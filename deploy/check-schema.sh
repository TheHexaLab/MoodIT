#!/usr/bin/env bash
# ============================================================================
# Compare le schéma d'une base RÉELLE à celui que produisent les migrations Flyway
# (db/migration), et affiche le SQL qui ferait passer la base réelle au schéma attendu.
#
# Usage (depuis la racine du dépôt, sur le serveur ou en local) :
#   ./deploy/check-schema.sh                  # base du conteneur moodit_postgres (.env.docker)
#   ./deploy/check-schema.sh dump.sql[.gz]    # un dump (pg_dump, complet ou --schema-only)
#
# Sortie : « ✓ Schéma identique » (code 0), ou le SQL de différence (code 2). À lancer :
#   - AVANT le premier déploiement avec Flyway (#96) : la prod doit avoir exactement le schéma
#     de V1, puisqu'elle est marquée à la version 2 sans rien rejouer ;
#   - à tout moment, pour détecter une dérive (changement fait à la main en prod).
#
# Ignorés : les tables de suivi des migrations (flyway_schema_history, schema_migrations).
# Seul le SCHÉMA est comparé (tables, colonnes, contraintes, index), pas les données.
# Prérequis : Docker. Tout tourne en conteneurs jetables (Postgres, Flyway, migra).
# ============================================================================
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(pwd)"
# Chemin du dossier db/ pour `docker -v` : sous Git Bash (Windows), il faut la forme C:/… (pwd -W).
DB_DIR="$(cd db && { pwd -W 2>/dev/null || pwd; })"
SOURCE="${1:-}"

PG_IMAGE="postgres:16"          # même version que les fichiers compose
PY_IMAGE="python:3.12-slim"     # exécute migra (pip)
FLYWAY_IMAGE="flyway/flyway:13.10.0@sha256:f5dab54b2b51e5aa131ebc2be36fd8a7c18006541db06638469ec26b6ad2bfe2"
NET="moodit_schemacheck_$$"
PG_LIVE="moodit_pg_live_$$"
PG_EXP="moodit_pg_expected_$$"
PGUSER="moodit"; PGPASS="moodit"; PGDB="moodit"

cleanup() {
  docker rm -f "$PG_LIVE" "$PG_EXP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker info >/dev/null 2>&1 || { echo "ERREUR : le démon Docker n'est pas joignable." >&2; exit 1; }

docker network create "$NET" >/dev/null
for c in "$PG_LIVE" "$PG_EXP"; do
  docker run -d --name "$c" --network "$NET" \
    -e POSTGRES_USER="$PGUSER" -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$PGDB" "$PG_IMAGE" >/dev/null
done
for c in "$PG_LIVE" "$PG_EXP"; do
  for _ in $(seq 1 30); do docker exec "$c" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break; sleep 1; done
done
# pg_isready répond pendant l'init du conteneur, avant le redémarrage final : petite marge.
sleep 3

echo "→ Schéma attendu : Flyway (db/migration) sur une base vide…"
FLYWAY_OUT="$(docker run --rm --network "$NET" -v "$DB_DIR:/flyway/db:ro" "$FLYWAY_IMAGE" \
  -url="jdbc:postgresql://$PG_EXP:5432/$PGDB" -user="$PGUSER" -password="$PGPASS" \
  -locations=filesystem:/flyway/db/migration -placeholderReplacement=false -connectRetries=10 \
  migrate 2>&1)" || { echo "$FLYWAY_OUT" >&2; echo "ERREUR : Flyway a échoué." >&2; exit 1; }
# Aucune migration trouvée (dossier mal monté) : la comparaison n'aurait aucun sens.
grep -q "Successfully applied" <<<"$FLYWAY_OUT" \
  || { echo "$FLYWAY_OUT" >&2; echo "ERREUR : aucune migration appliquée (db/ introuvable ?)." >&2; exit 1; }

echo "→ Schéma réel : ${SOURCE:-conteneur moodit_postgres}…"
load_live() { docker exec -i "$PG_LIVE" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" >/dev/null; }
if [ -n "$SOURCE" ]; then
  if [[ "$SOURCE" == *.gz ]]; then gunzip -c "$SOURCE" | load_live; else load_live < "$SOURCE"; fi
else
  [ -f .env.docker ] || { echo "ERREUR : .env.docker introuvable (ou passe un dump en argument)." >&2; exit 1; }
  LIVE_USER="$(grep -E '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
  LIVE_DB="$(grep -E '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"
  docker exec moodit_postgres pg_dump --schema-only --no-owner -U "$LIVE_USER" "$LIVE_DB" | load_live
fi
for c in "$PG_LIVE" "$PG_EXP"; do
  docker exec "$c" psql -q -U "$PGUSER" -d "$PGDB" \
    -c "SET client_min_messages = warning; DROP TABLE IF EXISTS flyway_schema_history, schema_migrations" >/dev/null
done

# migra <réel> <attendu> : SQL qui rend la base réelle identique au schéma attendu.
# Codes : 0 = identique, 2 = différences, autre = erreur. --unsafe : montre aussi les DROP.
echo "→ Comparaison (migra)…"
set +e
DIFF_SQL="$(docker run --rm --network "$NET" "$PY_IMAGE" sh -c \
  "pip install --quiet --disable-pip-version-check 'setuptools<81' migra psycopg2-binary >/dev/null 2>&1 \
   && PYTHONWARNINGS=ignore migra --unsafe \
      'postgresql+psycopg2://$PGUSER:$PGPASS@$PG_LIVE:5432/$PGDB' 'postgresql+psycopg2://$PGUSER:$PGPASS@$PG_EXP:5432/$PGDB'")"
RC=$?
set -e

case "$RC" in
  0) echo "✓ Schéma identique à db/migration."; exit 0 ;;
  2) echo "✖ Différences : SQL qui alignerait la base réelle sur db/migration :"; echo; echo "$DIFF_SQL"; exit 2 ;;
  *) echo "ERREUR : migra a échoué (code $RC)." >&2; echo "$DIFF_SQL" >&2; exit 1 ;;
esac
