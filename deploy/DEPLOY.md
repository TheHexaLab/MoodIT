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

> ARM (CAX) : les images Docker du projet se buildent sur place, **sauf Piston** : son image
> amont (`ghcr.io/engineer-man/piston`, épinglée par digest dans `piston/Dockerfile`) n'existe
> qu'en linux/amd64. Pour Piston, prendre un serveur **x86** (CX32), comme la prod actuelle.

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
`piston-init` installe les 12 langages puis s'arrête (normal), de même que `db-migrate`, qui crée
le schéma et les données de référence avec Flyway (voir « Changement de schéma »).

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

### Changement de schéma : migrations Flyway

Le schéma est versionné avec [Flyway](https://documentation.red-gate.com/flyway) (#96). Le
service one-shot `db-migrate` des fichiers compose applique, au démarrage, les versions de
`db/migration/` pas encore enregistrées dans la table `flyway_schema_history` ; les services qui
utilisent la base (auth, core, permission, mcp) ne démarrent qu'après lui. `deploy/update.sh` le
lance aussi avant le build, pour qu'une migration en échec arrête la mise à jour.

| Dossier | Contenu | Où |
|---|---|---|
| `db/migration/` | Schéma (V1), données de référence (V2 : rôles, types de forum et de question, langages), puis chaque évolution | Partout, prod comprise |
| `db/demo/` | Données de démo, un script par thème : établissements, comptes, programme et cours de base (V2.1), démo MCP (V2.2), quiz de code (V2.3), annonces (V2.4) | Dev, e2e et CI, **jamais en prod** |

#### Écrire une migration

1. Créer `db/migration/V<n>__<sujet>.sql`, `<n>` = la version suivante (ex. `V3__bio_utilisateur.sql`).
   Le SQL est appliqué tel quel, dans une transaction.
2. **Ne jamais modifier ni supprimer une migration fusionnée** : Flyway refuserait de démarrer
   (somme de contrôle différente), et le job CI `schema` bloque déjà ce cas. Une correction passe
   par une nouvelle version.
3. Si la démo doit suivre (nouvelle colonne obligatoire, nouvelles données), ajouter
   `db/demo/V<n>_1__<sujet>.sql`.
4. Vérifier en local : `docker compose -f docker-compose-dev.yml up -d` (applique les migrations
   manquantes à la base de dev), puis le job CI `schema` démarre chaque service en `validate`.

#### Appliquer en prod

Rien à faire à la main : `./deploy/update.sh` applique les nouvelles versions (après sa
sauvegarde de la base). Pour voir l'état :

```bash
docker compose --env-file .env.docker -f docker-compose-hetzner.yml run --rm --no-deps db-migrate
docker exec moodit_postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "SELECT version, description, installed_on, success FROM flyway_schema_history ORDER BY installed_rank"
```

#### Passage à Flyway d'une base existante (une seule fois)

Une base créée par l'ancien `init.sql` n'a pas d'historique Flyway. Au premier lancement,
`db-migrate` la marque à la version 2 (`FLYWAY_BASELINE_ON_MIGRATE`) sans rien rejouer : son schéma
doit donc être **exactement** celui de V1. À vérifier avant ce premier déploiement :

```bash
./deploy/check-schema.sh        # « ✓ Schéma identique à db/migration », sinon le SQL d'écart
```

En cas d'écart, corriger la base (ou ajouter une migration) avant de déployer. L'ancienne table
de suivi `schema_migrations` peut ensuite être supprimée.

#### Détecter une dérive

`./deploy/check-schema.sh` compare à tout moment la base de `moodit_postgres` (ou un dump passé
en argument) au schéma produit par `db/migration`, et affiche le SQL d'écart.

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

- Seuls les ports **80/443** sont exposés (Caddy). Tous les services applicatifs et la base
  restent sur le réseau Docker `internal`, injoignables depuis Internet.
- Le TLS est géré et renouvelé automatiquement par Caddy.
- Piston est seul sur le réseau `sandbox`, partagé uniquement avec `execution-service` (et
  `piston-init`) : ni le gateway, ni core-service, ni Postgres ne peuvent le joindre. Le code
  exécuté n'a aucun accès réseau (espace de noms réseau vide d'isolate).
- Piston ne tourne **plus** en `privileged` : capacités limitées à ce qu'isolate utilise
  (`SYS_ADMIN`, `NET_ADMIN`, `SYS_CHROOT`, `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`,
  `FOWNER`, `KILL`), seccomp par défaut de Docker actif, cgroup privé. AppArmor est levé pour ce
  seul conteneur (le profil `docker-default` interdit de remonter `/sys/fs/cgroup` en écriture).
  Si Piston ne démarre pas (« remontage de /sys/fs/cgroup impossible »), vérifier que l'hôte est
  en cgroup v2 et que `cap_add` / `cgroup: private` sont bien appliqués.
- Limites par exécution : 3 s d'exécution, 10 s de compilation, 256 Mo de mémoire à l'exécution
  et 512 Mo à la compilation, 1 Mio de sortie par flux. Côté execution-service : 2 exécutions
  simultanées au plus (`EXEC_MAX_CONCURRENT`, file d'attente de 5 s) et 2 requêtes en cours par
  utilisateur (`EXEC_MAX_PER_USER`) ; au-delà, l'interface affiche « Trop d'exécutions en cours ».
  Le conteneur Piston est plafonné à 1,5 Go (`mem_limit`) : 2 compilations de 512 Mo, plus une
  marge pour l'API Piston. Relever `EXEC_MAX_CONCURRENT` impose de relever ce plafond d'autant.
- Image Piston épinglée par digest (`piston/Dockerfile`). Pour la mettre à jour :
  `docker buildx imagetools inspect ghcr.io/engineer-man/piston:latest`, remplacer le digest,
  puis vérifier le job CI `integration` (vrai Piston) avant de déployer.
