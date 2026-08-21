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

# Conteneurs à longue durée de vie (piston_init est one-shot, traité à part).
SERVICES_UP="moodit_caddy moodit_postgres moodit_frontend moodit_gateway moodit_core moodit_auth moodit_permission moodit_mcp moodit_piston moodit_execution"
BOX_H="${BOX_H:-14}"   # hauteur (lignes) de la boîte de sortie du build

# Répète un caractère n fois (gère l'UTF-8 des bordures).
_rep() { local n="$1" c="$2" s='' i; for ((i=0;i<n;i++)); do s+="$c"; done; printf '%s' "$s"; }

# Affiche les dernières lignes de stdin dans une BOÎTE à hauteur fixe qui se
# redessine en place (au lieu de dérouler tout l'écran). Le flux complet est
# déjà écrit dans le log en amont (tee) ; ici on ne fait que l'AFFICHER.
box_tail() {
  local title="$1" H="${2:-14}"
  local W; W="$(tput cols 2>/dev/null || echo 100)"
  [ -z "$W" ] && W=100; [ "$W" -gt 118 ] && W=118; [ "$W" -lt 48 ] && W=48
  local inner=$((W-2)) usable=$((W-4))
  local -a buf=(); local drawn=0
  local t=" ${title} "; (( ${#t} > inner-2 )) && t="${t:0:inner-2}"
  local fill=$(( inner - 1 - ${#t} )); (( fill < 0 )) && fill=0
  local topb="┌─${t}$(_rep "$fill" '─')┐"
  local botb="└$(_rep "$inner" '─')┘"
  redraw() {
    (( drawn )) && printf '\033[%dA' $((H+2)); drawn=1
    printf '\r\033[2K%s%s%s\n' "$DIM" "$topb" "$RST"
    local n=${#buf[@]} start=0 i idx ln pad
    (( n > H )) && start=$((n-H))
    for ((i=0;i<H;i++)); do
      idx=$((start+i)); ln=''; (( idx < n )) && ln="${buf[idx]}"
      (( ${#ln} > usable )) && ln="${ln:0:usable}"
      printf -v pad '%*s' "$(( usable - ${#ln} ))" ''
      printf '\r\033[2K%s│%s %s%s %s│%s\n' "$DIM" "$RST" "$ln" "$pad" "$DIM" "$RST"
    done
    printf '\r\033[2K%s%s%s\n' "$DIM" "$botb" "$RST"
  }
  redraw
  while IFS= read -r line; do line="${line//$'\r'/}"; buf+=("$line"); redraw; done
}

# Exécute une commande longue. En terminal : sortie confinée dans une BOÎTE à
# hauteur fixe ($BOX_H dernières lignes). Hors terminal/cron : flux brut. Le log
# reçoit TOUT dans les deux cas. pipefail fait remonter l'échec malgré le tee.
stream() {
  local title="$1"; shift
  printf '[%s] $ %s\n' "$(date '+%F %T')" "$*" >>"$LOG"
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    "$@" 2>&1 | tee -a "$LOG" | box_tail "$title" "$BOX_H"
  else
    printf '   $ %s\n' "$*"
    "$@" 2>&1 | tee -a "$LOG"
  fi
}

# Health check par service : HTTPS public + état de chaque conteneur (running,
# + statut de santé Docker s'il existe, ex. postgres). Renvoie 0 si tout est OK.
hcheck() {
  local allok=1 name st health code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo 000)"
  if [ "$code" = "200" ]; then
    printf '   %s✔%s %-14s %shttps %s%s\n' "$GRN" "$RST" "moodit.ca" "$DIM" "$code" "$RST"
    printf '[%s] health HTTPS -> %s\n' "$(date '+%F %T')" "$code" >>"$LOG"
  else
    printf '   %s✖%s %-14s %shttps %s%s\n' "$RED" "$RST" "moodit.ca" "$YEL" "$code" "$RST"
    printf '[%s] health HTTPS -> %s (KO)\n' "$(date '+%F %T')" "$code" >>"$LOG"; allok=0
  fi
  for name in $SERVICES_UP; do
    st="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo absent)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name" 2>/dev/null || true)"
    if [ "$st" = "running" ] && { [ -z "$health" ] || [ "$health" = "healthy" ]; }; then
      printf '   %s✔%s %-14s %srunning%s%s\n' "$GRN" "$RST" "${name#moodit_}" "$DIM" "${health:+ ($health)}" "$RST"
      printf '[%s] health %s: running%s\n' "$(date '+%F %T')" "$name" "${health:+ ($health)}" >>"$LOG"
    else
      printf '   %s✖%s %-14s %s%s%s%s\n' "$RED" "$RST" "${name#moodit_}" "$YEL" "$st" "${health:+ ($health)}" "$RST"
      printf '[%s] health %s: %s%s (KO)\n' "$(date '+%F %T')" "$name" "$st" "${health:+ ($health)}" >>"$LOG"; allok=0
    fi
  done
  st="$(docker inspect -f '{{.State.Status}}' moodit_piston_init 2>/dev/null || echo absent)"
  health="$(docker inspect -f '{{.State.ExitCode}}' moodit_piston_init 2>/dev/null || echo '?')"
  printf '   %s·%s %-14s %s%s (exit %s, one-shot)%s\n' "$DIM" "$RST" "piston_init" "$DIM" "$st" "$health" "$RST"
  return $(( allok ? 0 : 1 ))
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

step "4/5 · Build des images"
printf '   %sPatiente : les services Java compilent — c'\''est normal que ce soit long.%s\n' "$DIM" "$RST"
if ! stream "Build des images" $COMPOSE build --progress=plain; then rollback; fi
ok "Images construites."

step "5/5 · Redémarrage des services"
if ! stream "Démarrage des services" $COMPOSE up -d; then rollback; fi
ok "Services démarrés."

# --- 4. Nettoyage des images orphelines -------------------------------------
docker image prune -f >/dev/null 2>&1 || true

# --- 5. Health check --------------------------------------------------------
step "Vérification de santé"
printf '   %sAttente du démarrage des services (8 s)…%s\n' "$DIM" "$RST"
sleep 8

ELAPSED="$((SECONDS / 60))m$((SECONDS % 60))s"
if hcheck; then
  printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$GRN" "$RST"
  printf '%s║  ✔ DÉPLOIEMENT RÉUSSI                                 ║%s\n' "$GRN" "$RST"
  printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$GRN" "$RST"
  log "OK : déployé ${REMOTE:0:8} — tous les services up.  (durée $ELAPSED)"
  ok "Version ${REMOTE:0:8} · tous services OK · $ELAPSED"
else
  printf '\n%s╔══════════════════════════════════════════════════════╗%s\n' "$YEL" "$RST"
  printf '%s║  ⚠ DÉPLOYÉ, MAIS AU MOINS UN SERVICE KO              ║%s\n' "$YEL" "$RST"
  printf '%s╚══════════════════════════════════════════════════════╝%s\n' "$YEL" "$RST"
  warn "post-déploiement : au moins un service KO (voir ci-dessus).  (durée $ELAPSED)"
  printf '   Inspecte : %sdocker compose -f docker-compose-hetzner.yml logs -f <service>%s\n' "$BOLD" "$RST"
fi
log "=== FIN ($ELAPSED) ==="
