#!/usr/bin/env bash
# ============================================================================
# Peuple une base de DÉVELOPPEMENT déjà migrée (y compris une pile PROD lancée en local) avec les
# données de test, SANS e2e, SANS Flyway, SANS recréer de volume. Rapide et rejouable.
#
# Réutilise les fichiers db/demo/* en les envoyant à psql via STDIN, EN UNE TRANSACTION (-1 :
# un échec à mi-parcours ne laisse pas une base à moitié peuplée que la garde d'idempotence
# refuserait ensuite de réparer). Pas de docker cp ni de chemins dans le conteneur → aucun
# souci de conversion de chemin sous Git Bash/Windows. Idempotent : ne
# fait rien si des établissements existent déjà (FORCE=1 pour re-seeder malgré tout). Donne
# l'établissement usherbrooke.ca, un programme/cours, des comptes de démo et le quiz de code
# multi-langages (harnais des compilés au format booléen non falsifiable depuis V9_1).
#
# Pré-requis : le SCHÉMA est déjà appliqué (la pile a lancé ses migrations V1→V9). Ce script ne
# migre PAS — il SÈME. Usage dev uniquement ; la prod réelle reste volontairement vierge.
#
# Usage :
#   ./scripts/migrate-dev-seed.sh
#   PG_CONTAINER=moodit_postgres POSTGRES_DB=moodit_db POSTGRES_USER=postgres ./scripts/migrate-dev-seed.sh
#   FORCE=1 ./scripts/migrate-dev-seed.sh        # re-seed même si déjà peuplé (peut dupliquer les quiz)
# ============================================================================
set -euo pipefail

CONTAINER="${PG_CONTAINER:-moodit_postgres}"
DB="${POSTGRES_DB:-moodit_db}"
DB_USER="${POSTGRES_USER:-postgres}"
DEMO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/db/demo"

# Toutes les requêtes passent par le psql DU CONTENEUR, via stdin — aucun chemin hôte transmis.
pg() { docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB" "$@"; }

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ Conteneur Postgres « $CONTAINER » absent ou arrêté. Lance la pile d'abord." >&2
  exit 1
fi

# Garde d'idempotence : la table establishment existe-t-elle, et est-elle vide ?
count="$(pg -tAc 'SELECT count(*) FROM establishment' 2>/dev/null | tr -d '[:space:]')" || count=""
if [ -z "$count" ]; then
  echo "✗ Lecture de « establishment » impossible — le schéma est-il migré (V1→V9) ? Lance la pile." >&2
  exit 1
fi
if [ "$count" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "ℹ Données déjà présentes (establishment=$count). Rien à faire — FORCE=1 pour re-seeder."
  exit 0
fi

echo "→ Seed des données de démo dans $CONTAINER/$DB (établissement, programme/cours, comptes, quiz de code)…"
# TOUS les fichiers de db/demo, dans l'ordre des VERSIONS (sort -V : V10_1 vient après V9_1,
# là où l'ordre lexicographique le placerait avant V2_1). Énumérer les fichiers à la main
# faisait sauter en SILENCE toute démo ajoutée ensuite — et la garde d'idempotence ci-dessus
# empêchait ensuite de réparer sans FORCE=1.
# NUL-safe : la liste n'est jamais découpée par mots. L'ancienne version (`cat $FILES`) éclatait
# sur un chemin de clone contenant une ESPACE — OneDrive d'organisation, « Mes Documents »… —
# avec des « cat: …: No such file or directory » qui ne désignaient pas la cause.
NB=$(find "$DEMO" -maxdepth 1 -name 'V*.sql' | wc -l)
if [ "$NB" -eq 0 ]; then
  echo "✗ Aucun fichier de démo trouvé dans $DEMO" >&2
  exit 1
fi
find "$DEMO" -maxdepth 1 -name 'V*.sql' -print0 | sort -zV | xargs -0 cat | pg -v ON_ERROR_STOP=1 -1 -q

echo
echo "✓ Terminé. Établissements autorisés :"
pg -tAc 'SELECT domain_email FROM establishment ORDER BY domain_email' | sed 's/^/  - /'
echo "Inscris-toi avec un courriel @usherbrooke.ca ; le quiz de code couvre les 16 langages (harnais au format runner)."
