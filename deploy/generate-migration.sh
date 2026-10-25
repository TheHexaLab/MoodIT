#!/usr/bin/env bash
# ============================================================================
#  Génère AUTOMATIQUEMENT un fichier de migration SQL par diff base-à-base.
# ============================================================================
# Compare le schéma décrit par l'ANCIEN init.sql (version committée, HEAD) à
# celui du init.sql COURANT (ton édition en cours), et écrit le SQL qui fait
# passer l'un à l'autre dans migrations/<date>_<nom>.sql.
#
# Pourquoi base-à-base (et pas un diff Hibernate) : les entités JPA sont
# éclatées entre services (auth-service en connaît 3, core-service 22, avec
# User/Establishment dupliquées) → un diff depuis un service génèrerait des
# DROP sur les tables des autres. init.sql est la SEULE source décrivant le
# schéma COMPLET : on diffe donc deux bases construites à partir de lui.
#
# Usage :
#   ./deploy/generate-migration.sh <nom_migration>
#   ./deploy/generate-migration.sh add_bio_colonne_user
#   REF=prod ./deploy/generate-migration.sh <nom>   # diff contre la VRAIE prod
#                                                      (nécessite PROD_DB_URL)
#
# Prérequis : Docker (démon démarré). Aucune installation locale de Postgres
# ni de migra — tout tourne en conteneurs jetables.
#
# ⚠️  Le fichier généré est un POINT DE DÉPART : RELIS-LE avant de committer.
#     migra peut mal rendre un RENOMMAGE (vu comme DROP + ADD → perte de
#     données) ou une conversion de type. Corrige à la main si besoin.
# ============================================================================
set -euo pipefail

# --- Se placer à la racine du repo (le script vit dans deploy/) -------------
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(pwd)"

NAME="${1:-}"
if [ -z "$NAME" ]; then
  echo "Usage : $0 <nom_migration>   (ex. add_bio_colonne_user)" >&2
  exit 1
fi
# Nom de fichier normalisé : <date>_<nom>.sql (aligne la convention existante).
DATE="$(date +%Y-%m-%d)"
OUT_REL="migrations/${DATE}_${NAME}.sql"
OUT="$REPO_DIR/$OUT_REL"
if [ -e "$OUT" ]; then
  echo "ERREUR : $OUT_REL existe déjà — choisis un autre nom." >&2
  exit 1
fi

# --- Paramètres des conteneurs jetables -------------------------------------
PG_IMAGE="postgres:16"          # même version que le compose de prod
PY_IMAGE="python:3.12-slim"     # exécute migra (pip) — plus fiable qu'une image migra figée
NET="moodit_migragen_$$"        # réseau isolé, suffixe PID pour éviter les collisions
PG_OLD="moodit_pg_old_$$"
PG_NEW="moodit_pg_new_$$"
PGUSER="moodit"
PGPASS="moodit"
PGDB="moodit"
OLD_URL="postgresql://${PGUSER}:${PGPASS}@${PG_OLD}:5432/${PGDB}"
NEW_URL="postgresql://${PGUSER}:${PGPASS}@${PG_NEW}:5432/${PGDB}"

# --- Nettoyage systématique (succès, échec ou Ctrl-C) -----------------------
cleanup() {
  docker rm -f "$PG_OLD" "$PG_NEW" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- Vérifs préalables ------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "ERREUR : le démon Docker n'est pas joignable (démarre Docker Desktop)." >&2
  exit 1
fi

# init.sql courant (working tree). L'ancien vient de git (HEAD), sauf REF=prod.
WORK_INIT="$REPO_DIR/init.sql"
[ -f "$WORK_INIT" ] || { echo "ERREUR : init.sql introuvable." >&2; exit 1; }

echo "→ Réseau + Postgres jetables…"
docker network create "$NET" >/dev/null

start_pg() {  # $1 = nom conteneur
  docker run -d --name "$1" --network "$NET" \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" \
    "$PG_IMAGE" >/dev/null
}
wait_pg() {   # $1 = nom conteneur — attend la disponibilité réelle
  for _ in $(seq 1 30); do
    if docker exec "$1" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "ERREUR : Postgres ($1) n'est pas prêt à temps." >&2; exit 1
}

start_pg "$PG_OLD"
start_pg "$PG_NEW"
wait_pg "$PG_OLD"
wait_pg "$PG_NEW"

# --- Charger le schéma ANCIEN (référence) -----------------------------------
echo "→ Chargement du schéma ANCIEN…"
if [ "${REF:-git}" = "prod" ]; then
  # Diff contre la VRAIE base de prod : on y restaure un dump. Nécessite un dump
  # accessible via PROD_DUMP (fichier .sql/.sql.gz) — évite d'exposer prod au script.
  [ -n "${PROD_DUMP:-}" ] || { echo "ERREUR : REF=prod exige PROD_DUMP=<dump.sql[.gz]>." >&2; exit 1; }
  if [[ "$PROD_DUMP" == *.gz ]]; then
    gunzip -c "$PROD_DUMP" | docker exec -i "$PG_OLD" psql -q -U "$PGUSER" -d "$PGDB" >/dev/null
  else
    docker exec -i "$PG_OLD" psql -q -U "$PGUSER" -d "$PGDB" < "$PROD_DUMP" >/dev/null
  fi
else
  # Défaut : l'ancien init.sql = version committée (HEAD). Déterministe, hors-ligne.
  git show HEAD:init.sql | docker exec -i "$PG_OLD" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" >/dev/null
fi

# --- Charger le schéma NOUVEAU (cible) --------------------------------------
echo "→ Chargement du schéma NOUVEAU (init.sql courant)…"
docker exec -i "$PG_NEW" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" < "$WORK_INIT" >/dev/null

# --- Diff : SQL pour faire passer OLD → NEW ---------------------------------
# migra <from> <target> émet le SQL qui rend <from> identique à <target>.
# Ici from=OLD (l'état de prod), target=NEW (désiré) → SQL à appliquer en prod.
# Code de sortie migra : 0 = aucune différence, 2 = différences trouvées (OK),
# 1 = erreur réelle. --unsafe autorise l'émission des changements destructifs
# (DROP/ALTER TYPE) — indispensable pour les voir et les RELIRE.
echo "→ Diff des schémas (migra)…"
set +e
DIFF_SQL="$(docker run --rm --network "$NET" "$PY_IMAGE" sh -c \
  "pip install --quiet --disable-pip-version-check 'setuptools<81' migra psycopg2-binary >/dev/null 2>&1 \
   && PYTHONWARNINGS=ignore migra --unsafe '$OLD_URL' '$NEW_URL'")"
RC=$?
set -e

if [ "$RC" -eq 0 ]; then
  echo "✓ Aucune différence de schéma — rien à générer."
  exit 0
elif [ "$RC" -ne 2 ]; then
  echo "ERREUR : migra a échoué (code $RC)." >&2
  echo "$DIFF_SQL" >&2
  exit 1
fi

# --- Écriture du fichier de migration (avec en-tête d'avertissement) --------
{
  echo "-- ============================================================================"
  echo "--  Migration générée automatiquement le ${DATE} (deploy/generate-migration.sh)"
  echo "--  Diff : init.sql@HEAD  ->  init.sql (working tree)"
  echo "-- ----------------------------------------------------------------------------"
  echo "--  ⚠️  RELIS ce fichier avant de committer. Un RENOMMAGE de colonne peut"
  echo "--  apparaître comme DROP + ADD (perte de données) ; corrige à la main au"
  echo "--  besoin. Idempotence NON garantie : l'application doit tracker ce qui a"
  echo "--  déjà été appliqué (cf. deploy/update.sh)."
  echo "-- ============================================================================"
  echo ""
  echo "$DIFF_SQL"
} > "$OUT"

echo "✓ Migration écrite : $OUT_REL"
echo "  → RELIS-la, ajuste si besoin, puis committe-la avec ta modif de init.sql."
