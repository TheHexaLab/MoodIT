# Déploiement MoodIT sur un VPS Hetzner (~8 €/mois)

Guide de bout en bout : d'un compte Hetzner vide à l'app en HTTPS.
LLM = **Groq** (gratuit). Sandbox de code = **Piston** (nécessite un VPS, pas un PaaS).

---

## 0. Ce qu'il te faut

- Un compte **Hetzner Cloud** (console.hetzner.cloud).
- Un **nom de domaine** (~10 €/an) — ou un sous-domaine gratuit (DuckDNS…). Requis pour le HTTPS Let's Encrypt automatique.
- Une **clé API Groq** gratuite : https://console.groq.com/keys (commence par `gsk_`).
- Un mot de passe d'application **Gmail** (ou autre SMTP) pour les emails de vérification.

---

## 1. Créer le serveur

Dans la console Hetzner → **Add Server** :

- Localisation : au choix (Nuremberg/Helsinki = moins cher ; Ashburn si public US).
- Image : **Ubuntu 24.04**.
- Type : **CAX21** (ARM Ampere, 4 vCPU / **8 Go**) ≈ 7-8 €/mois. *(x86 : CX32 équivalent.)*
- Ajouter ta **clé SSH**.
- Créer, puis noter l'**IP publique**.

> ARM (CAX) : les images Docker du projet se buildent sur place, donc l'archi est gérée
> automatiquement. Rien de spécial à faire.

## 2. Pointer le domaine

Chez ton registrar/DNS, crée un enregistrement **A** (et **AAAA** si IPv6) :

```
moodit.example.com   A     <IP_DU_VPS>
```

Attends que ça résolve (`ping moodit.example.com`).

## 3. Préparer le serveur

```bash
ssh root@<IP_DU_VPS>

# Docker + compose plugin
curl -fsSL https://get.docker.com | sh

# Pare-feu : n'ouvrir que SSH + HTTP + HTTPS
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Récupérer le code
apt-get install -y git
git clone <URL_DE_TON_REPO> moodit && cd moodit
```

## 4. Configurer les secrets

```bash
cp deploy/env.docker.example .env.docker
nano .env.docker
```

Remplis **tous** les `CHANGER_...`. Génère les secrets forts :

```bash
openssl rand -base64 64   # à coller dans JWT_SECRET
openssl rand -base64 64   # à coller dans APP_SECURITY_PEPPER
openssl rand -base64 64   # à coller dans INTERNAL_TOKEN
```

Points clés :
- `LLM_API_KEY=gsk_...` (ta clé Groq).
- `FRONT_ORIGIN=https://moodit.example.com` (l'origine HTTPS réelle — sinon le WebSocket est refusé).
- `SPRING_PROFILES_ACTIVE=prod`.
- `MAIL_USERNAME` / `MAIL_PASSWORD`.

Puis mets ton domaine dans le Caddyfile :

```bash
sed -i 's/moodit.example.com/TON_DOMAINE/' deploy/Caddyfile
```

## 5. Démarrer

Depuis la **racine** du repo :

```bash
docker compose -f docker-compose-hetzner.yml up -d --build
```

Le premier build prend quelques minutes (6 services Java + frontend + Piston).
`piston-init` installe les 12 langages puis s'arrête (normal). Au **tout premier**
démarrage, `init.sql` crée le schéma dans un volume Postgres vierge.

Suivre les logs :

```bash
docker compose -f docker-compose-hetzner.yml logs -f gateway core-service caddy
```

## 6. Vérifier

- Ouvre **https://moodit.example.com** → l'app se charge en HTTPS (cadenas OK).
- Crée un compte → tu reçois le **code par email** → connexion.
- Ouvre un quiz de code, soumets → correction via Piston (WebSocket met à jour le score).
- (Admin) lance une **analyse MCP** → résultat via Groq, ou repli déterministe si la clé est absente.

---

## Exploitation

| Action | Commande (depuis la racine du repo) |
|---|---|
| Voir l'état | `docker compose -f docker-compose-hetzner.yml ps` |
| Logs d'un service | `docker compose -f docker-compose-hetzner.yml logs -f <service>` |
| Mettre à jour le code | `git pull && docker compose -f docker-compose-hetzner.yml up -d --build` |
| Redémarrer | `docker compose -f docker-compose-hetzner.yml restart <service>` |
| Tout arrêter | `docker compose -f docker-compose-hetzner.yml down` |

### Sauvegarde de la base

```bash
docker exec moodit_postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup-$(date +%F).sql
```

### Changement de schéma après le 1er déploiement

`init.sql` ne rejoue **que** sur un volume vierge, et le profil prod tourne en
`validate`. Pour toute évolution de schéma, applique les scripts de `migrations/`
sur la base en cours (ne supprime pas le volume `postgres_data` en prod).

#### 1. Générer la migration automatiquement (dev)

Tu édites `init.sql` (source de vérité du schéma complet) comme d'habitude, puis :

```bash
./deploy/generate-migration.sh <nom_migration>     # ex. add_bio_colonne_user
```

Le script diffe le schéma de `init.sql@HEAD` (avant ta modif) contre le `init.sql`
courant, via deux Postgres jetables + [migra](https://github.com/djrobstep/migra),
et écrit le SQL dans `migrations/<date>_<nom>.sql`. **Prérequis : Docker.** Rien à
installer localement.

> ⚠️ Le fichier généré est un **point de départ, à RELIRE** : un renommage de
> colonne apparaît comme `DROP + ADD` (perte de données), et les conversions de
> type peuvent nécessiter un `USING`. Corrige à la main puis committe le `.sql`
> **avec** ta modif de `init.sql`.

Diff contre la vraie prod plutôt que `HEAD` (optionnel) : fournis un dump et
`REF=prod PROD_DUMP=backups/db-XX.sql.gz ./deploy/generate-migration.sh <nom>`.

#### 2. Appliquer la migration (prod)

`init.sql` contient déjà la version à jour du schéma → un **volume vierge** n'a
**pas** besoin des migrations (elles feraient doublon et échoueraient, p. ex.
`ADD COLUMN` d'une colonne déjà présente). Les migrations ne servent qu'aux bases
**déjà peuplées**. Applique-les avec un suivi (pour ne jamais rejouer une migration) :

```bash
PGUSER="$(grep -E '^POSTGRES_USER=' .env.docker | cut -d= -f2-)"
PGDB="$(grep -E '^POSTGRES_DB=' .env.docker | cut -d= -f2-)"
# Table de suivi (idempotent)
docker exec -i moodit_postgres psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
# Appliquer chaque migration non encore enregistrée, en transaction
for m in $(ls -1 migrations/*.sql | sort); do
  base="$(basename "$m")"
  seen="$(docker exec moodit_postgres psql -tAX -U "$PGUSER" -d "$PGDB" -c \
    "SELECT 1 FROM schema_migrations WHERE filename='$base'")"
  [ "$seen" = "1" ] && continue
  echo "Migration : $base"
  docker exec -i moodit_postgres psql -v ON_ERROR_STOP=1 --single-transaction -U "$PGUSER" -d "$PGDB" \
    -c "INSERT INTO schema_migrations(filename) VALUES ('$base')" -f - < "$m" \
    || { echo "ÉCHEC : $base"; break; }
done
```

Sur un **volume neuf** créé depuis `init.sql`, enregistre les migrations comme
déjà appliquées **sans les exécuter** (sinon doublon) :

```bash
for m in migrations/*.sql; do
  docker exec -i moodit_postgres psql -U "$PGUSER" -d "$PGDB" -c \
    "INSERT INTO schema_migrations(filename) VALUES ('$(basename "$m")') ON CONFLICT DO NOTHING"
done
```

---

## Notes de coût / dimensionnement

- **~8 Go de RAM** suffisent : les 6 services Java sont plafonnés (`-Xmx`, `mem_limit`
  dans le compose). Total observé ≈ 3,5-4 Go → marge confortable.
- **Groq** est gratuit (quotas généreux) ; aucune donnée LLM ne coûte de GPU.
- Si tu veux **0 €/mois** : reprends exactement ce compose sur une VM
  **Oracle Cloud Always Free** (ARM 4 cœurs / 24 Go). Même fichiers, seul l'hébergeur change.
- Pour réduire la RAM : externaliser Postgres vers **Neon**/**Supabase** (offre gratuite)
  et retirer le service `postgres` du compose (mettre `POSTGRES_HOST`/`PORT` sur l'hôte managé).

## Sécurité

- Seuls les ports **80/443** sont exposés (Caddy). Tous les services applicatifs, la base
  et Piston restent sur le réseau Docker `internal`, injoignables depuis Internet.
- Le TLS est géré et renouvelé automatiquement par Caddy.
- Piston tourne en `privileged` (exigé par l'isolation isolate) **mais** sans accès réseau
  à l'exécution et jamais exposé au gateway.
