#!/usr/bin/env sh
# Démarre la pile E2E complète et la prépare pour `npx playwright test e2e/core`.
# Utilisé tel quel par la CI (job `e2e` de .github/workflows/tests.yml) et en local.
# Depuis la racine du dépôt :   sh frontend/e2e/core/start-stack.sh
# Arrêt (et effacement de la base) : la commande `down -v` affichée à la fin.
set -eu

export FRONTEND_PORT="${FRONTEND_PORT:-5173}" GATEWAY_PORT="${GATEWAY_PORT:-8080}"
export POSTGRES_USER=postgres POSTGRES_DB=moodit_db   # interpolation des fichiers compose
# La CI fournit son propre COMPOSE (avec docker-compose-ci-cache.yml, cache de build gha) : on le
# garde ; sans lui (en local), la pile e2e de base.
COMPOSE="${COMPOSE:-docker compose -p moodit-e2e -f docker-compose-prod.yml -f docker-compose-e2e.yml}"
SERVICES="postgres db-migrate mailpit auth-service core-service permission-service mcp-service piston execution-service gateway frontend"

[ -f .env.docker ] || touch .env.docker   # requis par `env_file:` ; valeurs imposées par docker-compose-e2e.yml

echo "→ Construction et démarrage des services"
# shellcheck disable=SC2086 # découpage en mots voulu (commande + liste de services)
$COMPOSE up -d --build --no-deps --wait $SERVICES

echo "→ Préparation de la BD (dev-db.sql)"
docker exec -i moodit_e2e_postgres psql -v ON_ERROR_STOP=1 -U postgres -d moodit_db -q \
  < frontend/e2e/setup/dev-db.sql

echo "→ Attente du gateway"
# Prêt quand le gateway relaie vers auth-service : un login inconnu répond 401 (et non 502).
i=0
until [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"email":"personne@e2e.test","password":"x"}' "http://localhost:$FRONTEND_PORT/auth/login")" = 401 ]; do
  i=$((i + 1))
  [ "$i" -lt 120 ] || { echo "La pile ne répond pas après 120 s." >&2; exit 1; }
  sleep 1
done

echo "→ Python dans Piston (questions de code)"
# Seul langage des quiz de code testés ; piston-init (12 langages) serait bien plus long.
until curl -fsS http://localhost:2000/api/v2/runtimes > /dev/null 2>&1; do sleep 1; done
curl -fsS http://localhost:2000/api/v2/runtimes | grep -q '"language":"python"' ||
  curl -fsS -X POST http://localhost:2000/api/v2/packages -H 'Content-Type: application/json' \
    -d '{"language":"python","version":"3.12.0"}' > /dev/null

sh frontend/e2e/core/bootstrap.sh

echo "Pile E2E prête : http://localhost:$FRONTEND_PORT (courriels : http://localhost:8025)"
echo "Arrêt : $COMPOSE down -v"
