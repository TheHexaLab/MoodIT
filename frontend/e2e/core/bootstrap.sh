#!/usr/bin/env sh
# Prépare la BD de la pile E2E pour les tests de e2e/core (idempotent, rejouable).
# Appelé par start-stack.sh, après e2e/setup/dev-db.sql. Depuis la racine du dépôt :
#   sh frontend/e2e/core/bootstrap.sh
#
# - Établissement `e2e.courriel` : domaine des comptes dont les tests lisent les courriels
#   (Mailpit). TLD inexistant, donc non routable.
# - Comptes à rôles (cf. e2e/core/accounts.ts) : inscrits et validés par l'API (endpoint de dev),
#   puis rôles posés en SQL. Aucun compte privilégié n'existe au départ pour les attribuer par l'UI.
#     gardien@e2e.test → rôle global Gardien
#     padmin@e2e.test  → Administrateur du programme 1 (gère les rôles, modère)
#     prof@e2e.test    → Enseignant du programme 1 (gère le contenu des cours)
set -eu

PG_CONTAINER="${E2E_PG_CONTAINER:-moodit_e2e_postgres}"
BASE_URL="${E2E_BASE_URL:-http://localhost:5173}"
PASSWORD='E2e-Passw0rd!'   # = TEST_PASSWORD de e2e/setup/accounts.ts

psql_e2e() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d moodit_db -q; }

psql_e2e <<'SQL'
INSERT INTO Establishment (name, domain_email)
SELECT 'MoodIT E2E (courriels)', 'e2e.courriel'
WHERE NOT EXISTS (SELECT 1 FROM Establishment WHERE domain_email = 'e2e.courriel');
SQL

# Inscription + validation (déjà inscrit → 4xx ignoré : idempotent).
for account in gardien:Gaston padmin:Paula prof:Pierre; do
  username="e2e_${account%%:*}"
  first="${account##*:}"
  curl -s -o /dev/null -X POST "$BASE_URL/auth/register" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"firstName\":\"$first\",\"lastName\":\"E2E\",\"email\":\"${account%%:*}@e2e.test\",\"password\":\"$PASSWORD\"}"
  curl -s -o /dev/null "$BASE_URL/auth/verify/$username"
done

psql_e2e <<'SQL'
INSERT INTO User_Role (user_id, role_id)
SELECT u.id, r.id FROM User_ u, Role r
WHERE u.email = 'gardien@e2e.test' AND r.name = 'Gardien'
ON CONFLICT DO NOTHING;

INSERT INTO User_Program_Role (program_id, user_id, role_id)
SELECT 1, u.id, r.id FROM User_ u, Role r
WHERE (u.email, r.name) IN (('padmin@e2e.test', 'Administrateur'), ('prof@e2e.test', 'Enseignant'))
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM User_ WHERE email IN ('gardien@e2e.test', 'padmin@e2e.test', 'prof@e2e.test')) <> 3 THEN
    RAISE EXCEPTION 'bootstrap E2E : comptes à rôles manquants (pile prête ? dev-db.sql appliqué ?)';
  END IF;
END $$;
SQL

echo "bootstrap E2E : OK"
