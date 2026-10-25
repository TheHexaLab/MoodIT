#!/usr/bin/env bash
# ============================================================================
#  Reset de la base — repart de l'état FRAIS de init.sql (démo intacte : quiz,
#  messages MCP, …) tout en PRÉSERVANT les comptes réels et leurs rôles GLOBAUX.
# ============================================================================
# Déroulé :
#   1. Sauvegarde complète (gzip) de la base.
#   2. Snapshot des comptes (user_) et des rôles globaux (user_role, mémorisés par
#      EMAIL + NOM de rôle → indépendant des ids) dans un schéma `_reset_backup`.
#   3. DROP SCHEMA public CASCADE + réexécution de init.sql → schéma + données de
#      DÉMO recréés à neuf (programmes, cours, forums, MESSAGES, QUIZ, questions…).
#   4. Réinjection des comptes RÉELS absents de la démo (par email/username) et de
#      TOUS les rôles globaux (mappés par email + nom de rôle).
#
# Ce qui est PRÉSERVÉ : comptes utilisateurs + rôles GLOBAUX (User_Role).
# Ce qui NE l'est PAS  : les rôles PAR PROGRAMME (User_Program_Role) — les programmes
#                        sont réinitialisés à ceux de la démo, donc ces liens n'ont plus
#                        de cible (la démo re-seed ses propres rôles-programme).
#
# Usage :
#   ./deploy/reset-data.sh            # confirmation + sauvegarde
#   ./deploy/reset-data.sh --yes      # sans confirmation
#   ./deploy/reset-data.sh --no-backup
#   DATABASE_URL=postgres://user:pass@host/db ./deploy/reset-data.sh
#
# Par défaut : psql DANS le conteneur `moodit_postgres`, identifiants lus de `.env.docker`.
# ⚠️  DESTRUCTIF et IRRÉVERSIBLE (sauvegarde gzip faite avant, sauf --no-backup).
# ============================================================================
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(pwd)"
[ -f "$REPO_DIR/init.sql" ] || { echo "ERREUR : init.sql introuvable à la racine du repo." >&2; exit 1; }

YES=""
BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) YES=1 ;;
    --no-backup) BACKUP=0 ;;
    *) echo "Argument inconnu : $arg" >&2; exit 1 ;;
  esac
done

# --- Cible : DATABASE_URL (psql direct) ou conteneur moodit_postgres ------------------------
if [ -n "${DATABASE_URL:-}" ]; then
  psql_run() { psql -v ON_ERROR_STOP=1 "$DATABASE_URL" "$@"; }
  dump_run() { pg_dump "$DATABASE_URL"; }
  TARGET_DESC="DATABASE_URL"
else
  [ -f "$REPO_DIR/.env.docker" ] || { echo "ERREUR : .env.docker introuvable (ou fournis DATABASE_URL)." >&2; exit 1; }
  PGUSER="$(grep -E '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
  PGDB="$(grep -E '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"
  docker ps --format '{{.Names}}' | grep -q '^moodit_postgres$' \
    || { echo "ERREUR : conteneur moodit_postgres introuvable (ou fournis DATABASE_URL)." >&2; exit 1; }
  psql_run() { docker exec -i moodit_postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }
  dump_run() { docker exec moodit_postgres pg_dump -U "$PGUSER" "$PGDB"; }
  TARGET_DESC="conteneur moodit_postgres (db=$PGDB)"
fi

echo "Cible : $TARGET_DESC"
echo "→ Repart de init.sql (démo recréée), PRÉSERVE les comptes + rôles globaux."
echo

if [ -z "$YES" ]; then
  printf "⚠️  Action DESTRUCTIVE et IRRÉVERSIBLE. Taper « reset » pour continuer : "
  read -r answer
  [ "$answer" = "reset" ] || { echo "Annulé."; exit 0; }
fi

# --- 1. Sauvegarde complète -----------------------------------------------------------------
if [ "$BACKUP" -eq 1 ]; then
  mkdir -p "$REPO_DIR/backups"
  BACKUP_FILE="$REPO_DIR/backups/pre-reset-$(date '+%Y%m%d-%H%M%S').sql.gz"
  echo "→ Sauvegarde : $BACKUP_FILE"
  dump_run | gzip > "$BACKUP_FILE" || { rm -f "$BACKUP_FILE"; echo "ERREUR : sauvegarde échouée — reset annulé." >&2; exit 1; }
  echo "  OK ($(du -h "$BACKUP_FILE" | cut -f1))"
fi

# --- 2. Snapshot des comptes + rôles globaux (schéma séparé, survit au DROP public) ---------
echo "→ Snapshot des comptes et rôles globaux…"
psql_run -q <<'SQL'
DROP SCHEMA IF EXISTS _reset_backup CASCADE;
CREATE SCHEMA _reset_backup;
-- Copie intégrale des comptes.
CREATE TABLE _reset_backup.users AS SELECT * FROM public.user_;
-- Rôles GLOBAUX mémorisés par clés STABLES (email + nom de rôle), pas par id.
CREATE TABLE _reset_backup.user_roles AS
  SELECT u.email AS user_email, r.name AS role_name
  FROM public.user_role ur
  JOIN public.user_ u ON u.id = ur.user_id
  JOIN public.role  r ON r.id = ur.role_id;
SQL

# --- 3. Reset du schéma + réexécution de init.sql (démo à neuf) ------------------------------
echo "→ Réinitialisation du schéma (DROP public) + init.sql…"
psql_run -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql_run -q < "$REPO_DIR/init.sql"

# --- 4. Réinjection des comptes réels + rôles globaux ---------------------------------------
echo "→ Réinjection des comptes réels et de leurs rôles globaux…"
psql_run -q <<'SQL'
-- Comptes ABSENTS de la démo recréée (comparaison par email OU username → couvre les deux
-- contraintes UNIQUE). Les comptes de démo (déjà recréés par init.sql) sont ignorés. On NE
-- réinjecte PAS l'id (SERIAL en assigne un neuf) → aucune collision avec les ids de la démo.
INSERT INTO public.user_ (
  username, first_name, last_name, email, settings, avatar_color, active_token_hash,
  password_hash, created_at, verification_code, verification_code_expires_at,
  verification_attempts, last_code_sent_at, verification_locked_until, failed_login_attempts,
  login_locked_until, reset_code, reset_code_expires_at, reset_attempts, reset_last_sent_at,
  reset_locked_until)
SELECT
  s.username, s.first_name, s.last_name, s.email, s.settings, s.avatar_color, s.active_token_hash,
  s.password_hash, s.created_at, s.verification_code, s.verification_code_expires_at,
  s.verification_attempts, s.last_code_sent_at, s.verification_locked_until, s.failed_login_attempts,
  s.login_locked_until, s.reset_code, s.reset_code_expires_at, s.reset_attempts, s.reset_last_sent_at,
  s.reset_locked_until
FROM _reset_backup.users s
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_ u WHERE u.email = s.email OR u.username = s.username
);

-- Rôles globaux de TOUS les comptes du snapshot, mappés par email + nom de rôle (ids neufs).
-- ON CONFLICT DO NOTHING : ignore les rôles déjà (re)posés par init.sql pour les comptes démo.
INSERT INTO public.user_role (user_id, role_id)
SELECT u.id, r.id
FROM _reset_backup.user_roles br
JOIN public.user_ u ON u.email = br.user_email
JOIN public.role  r ON r.name  = br.role_name
ON CONFLICT DO NOTHING;

DROP SCHEMA _reset_backup CASCADE;
SQL

echo "✓ Terminé : démo de init.sql recréée, comptes + rôles globaux préservés."
