#!/usr/bin/env bash
# ============================================================================
# Met à jour le déploiement MoodIT : sauvegarde BD -> git pull -> rebuild ->
# health check, avec rollback du code si le build/démarrage échoue.
#
# Usage :
#   ./deploy/update.sh          # ne fait rien s'il n'y a pas de nouveau commit
#   ./deploy/update.sh --force  # rebuild/redéploie même sans nouveau commit
#
# Idempotent, sûr à lancer en cron. Journalise dans ~/moodit/update.log.
# ============================================================================
set -euo pipefail

# --- Se placer à la racine du repo (le script vit dans deploy/) -------------
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(pwd)"

COMPOSE="docker compose --env-file .env.docker -f docker-compose-hetzner.yml"
LOG="$REPO_DIR/update.log"
BACKUP_DIR="$REPO_DIR/backups"
KEEP_BACKUPS=7
HEALTH_URL="https://moodit.ca"
FORCE="${1:-}"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
fail() { log "ÉCHEC : $*"; exit 1; }

# --- Verrou : pas deux updates en parallèle (cron + lancement manuel) -------
exec 9>"$REPO_DIR/.update.lock"
if ! flock -n 9; then
  log "Une mise à jour est déjà en cours — abandon."
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin "$BRANCH" || fail "git fetch impossible"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" != "--force" ]; then
  log "À jour (${LOCAL:0:8}) sur '$BRANCH' — rien à faire. (--force pour rebuild)"
  exit 0
fi

log "=== MISE À JOUR '$BRANCH' : ${LOCAL:0:8} -> ${REMOTE:0:8} (force=$FORCE) ==="

# --- 1. Sauvegarde de la base AVANT toute modif -----------------------------
mkdir -p "$BACKUP_DIR"
PGUSER="$(grep -E '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
PGDB="$(grep -E '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"
BACKUP_FILE="$BACKUP_DIR/db-$(date '+%Y%m%d-%H%M%S').sql.gz"
if docker ps --format '{{.Names}}' | grep -q '^moodit_postgres$'; then
  if docker exec moodit_postgres pg_dump -U "$PGUSER" "$PGDB" | gzip > "$BACKUP_FILE"; then
    log "Sauvegarde BD : $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
  else
    rm -f "$BACKUP_FILE"; fail "pg_dump a échoué — mise à jour annulée."
  fi
  # Rotation : ne garder que les KEEP_BACKUPS plus récentes
  ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
else
  log "AVERTISSEMENT : conteneur postgres absent, pas de sauvegarde."
fi

# --- 2. Aligner le code sur le dépôt distant (résiste aux dérives locales) ---
# origin/$BRANCH est déjà récupéré (git fetch plus haut). reset --hard ne touche
# QUE les fichiers suivis → .env.docker (ignoré par git) est préservé. Immunise
# contre les « local changes would be overwritten » si un fichier suivi a dérivé
# sur le serveur.
if ! git reset --hard "origin/$BRANCH"; then
  fail "git reset --hard origin/$BRANCH impossible — aucun changement appliqué."
fi

# --- 3. Rebuild + redéploiement (rollback du code si échec) -----------------
rollback() {
  log "Rollback du code vers ${LOCAL:0:8}…"
  git reset --hard "$LOCAL" >/dev/null 2>&1 || true
  $COMPOSE up -d --build >>"$LOG" 2>&1 || log "Rollback : échec du redémarrage de l'ancienne version."
  fail "Build/déploiement de la nouvelle version échoué — ancienne version restaurée."
}

log "Build des images…"
$COMPOSE build >>"$LOG" 2>&1 || rollback
log "Redémarrage des services modifiés…"
$COMPOSE up -d >>"$LOG" 2>&1 || rollback

# --- 4. Nettoyage des images orphelines -------------------------------------
docker image prune -f >/dev/null 2>&1 || true

# --- 5. Health check --------------------------------------------------------
sleep 8
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo 000)"
# On ignore piston_init : conteneur one-shot qui S'ARRÊTE normalement (exit 0)
# après avoir installé les langages dans le sandbox.
DOWN="$($COMPOSE ps --status exited --status dead --format '{{.Name}}' 2>/dev/null | grep -vc 'piston_init' || true)"
if [ "$CODE" = "200" ] && [ "$DOWN" -eq 0 ]; then
  log "OK : déployé ${REMOTE:0:8} — HTTPS $CODE, tous les conteneurs up."
else
  log "AVERTISSEMENT post-déploiement : HTTPS=$CODE, conteneurs arrêtés=$DOWN. Vérifie '$COMPOSE ps' et '$COMPOSE logs'."
fi
log "=== FIN ==="
