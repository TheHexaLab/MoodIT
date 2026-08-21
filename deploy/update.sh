#!/usr/bin/env bash
# ============================================================================
# Met à jour le déploiement MoodIT : sauvegarde BD -> git pull -> rebuild ->
# health check, avec rollback du code si le build/démarrage échoue.
#
# Usage :
#   ./deploy/update.sh          # ne fait rien s'il n'y a pas de nouveau commit
#   ./deploy/update.sh --force  # rebuild/redéploie même sans nouveau commit
#
# Sortie VISUELLE : les étapes sont annoncées en couleur et la sortie du build
# et du démarrage est STREAMÉE à l'écran (et copiée dans update.log). Désactive
# les couleurs avec NO_COLOR=1 ou hors terminal (cron : log brut, pas d'ANSI).
#
# Idempotent, sûr à lancer en cron. Journalise dans ~/moodit/update.log.
# ============================================================================
set -euo pipefail
SECONDS=0   # chrono total (builtin bash)

# --- Se placer à la racine du repo (le script vit dans deploy/) -------------
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(pwd)"

COMPOSE="docker compose --env-file .env.docker -f docker-compose-hetzner.yml"
LOG="$REPO_DIR/update.log"
BACKUP_DIR="$REPO_DIR/backups"
KEEP_BACKUPS=7
HEALTH_URL="https://moodit.ca"
FORCE="${1:-}"

# --- Couleurs (désactivées hors terminal, en cron, ou si NO_COLOR) ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[1;31m'; GRN=$'\033[1;32m'
  YEL=$'\033[1;33m'; BLU=$'\033[1;34m'; CYA=$'\033[1;36m'; RST=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GRN=''; YEL=''; BLU=''; CYA=''; RST=''
fi

# Journalise : fichier en BRUT (horodaté), console en COULEUR.
log()  { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
         printf '%s%s%s %s\n' "$DIM" "$(date '+%H:%M:%S')" "$RST" "$*"; }
ok()   { printf '[%s] OK : %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
         printf '   %s✔%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '[%s] AVERTISSEMENT : %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
         printf '   %s⚠%s %s\n' "$YEL" "$RST" "$*"; }
step() { printf '\n[%s] ===== %s =====\n' "$(date '+%F %T')" "$*" >>"$LOG"
         printf '\n%s%s▶ %s%s\n' "$BOLD" "$BLU" "$*" "$RST"; }
fail() { printf '[%s] ÉCHEC : %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
         printf '\n%s✖ ÉCHEC : %s%s\n' "$RED" "$*" "$RST"; exit 1; }

# Exécute une commande longue en STREAMANT sa sortie (console + log).
# pipefail (set plus haut) fait remonter l'échec de la commande malgré le tee.
stream() {
  printf '%s   $ %s%s\n' "$DIM" "$*" "$RST"
  printf '[%s] $ %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  "$@" 2>&1 | tee -a "$LOG"
}

banner() {
  printf '%s%s' "$BOLD" "$CYA"
  printf '╔══════════════════════════════════════════════════════╗\n'
  printf '║   MoodIT — mise à jour du déploiement                 ║\n'
  printf '╚══════════════════════════════════════════════════════╝%s\n' "$RST"
}

# --- Verrou : pas deux updates en parallèle (cron + lancement manuel) -------
exec 9>"$REPO_DIR/.update.lock"
if ! flock -n 9; then
  log "Une mise à jour est déjà en cours — abandon."
  exit 0
fi

banner

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
step "Vérification des mises à jour ($BRANCH)"
git fetch --quiet origin "$BRANCH" || fail "git fetch impossible"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" != "--force" ]; then
  ok "À jour (${LOCAL:0:8}) sur '$BRANCH' — rien à faire."
  printf '   %s(utilise --force pour rebuild quand même)%s\n' "$DIM" "$RST"
  exit 0
fi

log "Cible : ${LOCAL:0:8} -> ${REMOTE:0:8}  (force=${FORCE:-non})"

# --- 1. Sauvegarde de la base AVANT toute modif -----------------------------
step "1/5 · Sauvegarde de la base"
mkdir -p "$BACKUP_DIR"
PGUSER="$(grep -E '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
PGDB="$(grep -E '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"
BACKUP_FILE="$BACKUP_DIR/db-$(date '+%Y%m%d-%H%M%S').sql.gz"
if docker ps --format '{{.Names}}' | grep -q '^moodit_postgres$'; then
  if docker exec moodit_postgres pg_dump -U "$PGUSER" "$PGDB" | gzip > "$BACKUP_FILE"; then
    ok "Sauvegarde : $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
  else
    rm -f "$BACKUP_FILE"; fail "pg_dump a échoué — mise à jour annulée."
  fi
  # Rotation : ne garder que les KEEP_BACKUPS plus récentes
  ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
else
  warn "Conteneur postgres absent, pas de sauvegarde."
fi

# --- 2. Aligner le code sur le dépôt distant (résiste aux dérives locales) ---
# origin/$BRANCH est déjà récupéré (git fetch plus haut). reset --hard ne touche
# QUE les fichiers suivis → .env.docker (ignoré par git) est préservé. Immunise
# contre les « local changes would be overwritten » si un fichier suivi a dérivé
# sur le serveur.
step "2/5 · Récupération du code"
if ! git reset --hard "origin/$BRANCH"; then
  fail "git reset --hard origin/$BRANCH impossible — aucun changement appliqué."
fi
ok "Code aligné sur origin/$BRANCH (${REMOTE:0:8})"
log "Résumé des changements :"
git --no-pager log --oneline --no-decorate "${LOCAL}..${REMOTE}" 2>/dev/null | head -n 15 | sed 's/^/     /' || true

# --- 2b. Migrations de schéma : appliquer les nouvelles, avec suivi ----------
# init.sql ne rejoue JAMAIS sur un volume existant → les évolutions de schéma
# passent par migrations/*.sql (générées par deploy/generate-migration.sh). On
# applique, dans l'ordre, celles pas encore enregistrées dans `schema_migrations`,
# chacune en transaction (rollback atomique si elle échoue). AVANT le rebuild :
# le schéma doit être prêt avant que les services (profil `validate`) ne démarrent.
#
# ⚠️ Un volume VIERGE possède déjà tout le schéma via init.sql : NE PAS y rejouer
# les migrations (elles feraient doublon). Après un 1er `compose up` sur volume
# neuf, marque-les comme appliquées sans les exécuter (cf. DEPLOY.md, section
# « Changement de schéma »).
step "3/5 · Migrations de base de données"
if docker ps --format '{{.Names}}' | grep -q '^moodit_postgres$'; then
  psql_db() { docker exec -i moodit_postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" "$@"; }
  psql_db -q -c "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" \
    || fail "Création de la table schema_migrations impossible."
  MIGRATED=0
  for m in $(ls -1 "$REPO_DIR"/migrations/*.sql 2>/dev/null | sort); do
    base="$(basename "$m")"
    seen="$(docker exec moodit_postgres psql -tAX -U "$PGUSER" -d "$PGDB" \
      -c "SELECT 1 FROM schema_migrations WHERE filename='$base'" 2>/dev/null)"
    [ "$seen" = "1" ] && continue
    log "Migration BD : $base"
    # -c (enregistrement) PUIS -f (migration) dans UNE transaction : si la migration
    # échoue, l'enregistrement est annulé aussi → elle sera retentée au prochain run.
    if psql_db -q --single-transaction \
         -c "INSERT INTO schema_migrations(filename) VALUES ('$base')" -f - < "$m" >>"$LOG" 2>&1; then
      MIGRATED=$((MIGRATED + 1))
    else
      fail "Migration '$base' échouée — déploiement interrompu (BD sauvegardée : $BACKUP_FILE). Corrige la migration puis relance."
    fi
  done
  if [ "$MIGRATED" -gt 0 ]; then ok "$MIGRATED migration(s) BD appliquée(s)."; else ok "Aucune migration BD en attente."; fi
else
  warn "Conteneur postgres absent, migrations BD non appliquées."
fi

# --- 3. Rebuild + redéploiement (rollback du code si échec) -----------------
rollback() {
  warn "Rollback du code vers ${LOCAL:0:8}…"
  git reset --hard "$LOCAL" >/dev/null 2>&1 || true
  $COMPOSE up -d --build >>"$LOG" 2>&1 || warn "Rollback : échec du redémarrage de l'ancienne version."
  fail "Build/déploiement de la nouvelle version échoué — ancienne version restaurée."
}

step "4/5 · Build des images  (sortie en direct ↓)"
printf '   %sPatiente : les services Java compilent — c'\''est normal que ce soit long.%s\n' "$DIM" "$RST"
if ! stream $COMPOSE build; then rollback; fi
ok "Images construites."

step "5/5 · Redémarrage des services  (sortie en direct ↓)"
if ! stream $COMPOSE up -d; then rollback; fi
ok "Services démarrés."

# --- 4. Nettoyage des images orphelines -------------------------------------
docker image prune -f >/dev/null 2>&1 || true

# --- 5. Health check --------------------------------------------------------
step "Vérification de santé"
printf '   %sAttente du démarrage (8 s)…%s\n' "$DIM" "$RST"
sleep 8
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo 000)"
# On ignore piston_init : conteneur one-shot qui S'ARRÊTE normalement (exit 0)
# après avoir installé les langages dans le sandbox.
DOWN="$($COMPOSE ps --status exited --status dead --format '{{.Name}}' 2>/dev/null | grep -vc 'piston_init' || true)"

ELAPSED="$((SECONDS / 60))m$((SECONDS % 60))s"
if [ "$CODE" = "200" ] && [ "$DOWN" -eq 0 ]; then
  printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$GRN" "$RST"
  printf '%s║  ✔ DÉPLOIEMENT RÉUSSI%s\n' "$GRN" "$RST"
  printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$GRN" "$RST"
  log "OK : déployé ${REMOTE:0:8} — HTTPS $CODE, tous les conteneurs up.  (durée $ELAPSED)"
  ok "Version ${REMOTE:0:8} · HTTPS $CODE · conteneurs OK · $ELAPSED"
else
  printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$YEL" "$RST"
  printf '%s║  ⚠ DÉPLOYÉ, MAIS À VÉRIFIER%s\n' "$YEL" "$RST"
  printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$YEL" "$RST"
  warn "post-déploiement : HTTPS=$CODE, conteneurs arrêtés=$DOWN.  (durée $ELAPSED)"
  printf '   Inspecte : %s$COMPOSE ps%s   et   %s$COMPOSE logs%s\n' "$BOLD" "$RST" "$BOLD" "$RST"
fi
log "=== FIN ($ELAPSED) ==="
