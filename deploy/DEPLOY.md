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

## Vocal (LiveKit) — optionnel

Le vocal (salons audio WebRTC) utilise un SFU **LiveKit** auto-hébergé. Il est **désactivé**
tant que `VOICE_ENABLED` n'est pas à `true`. Pour l'activer en prod :

1. **DNS** — ajoute un sous-domaine qui pointe sur le VPS (comme le domaine principal) :
   ```
   livekit.moodit.ca   A     <IP_DU_VPS>
   turn.moodit.ca      A     <IP_DU_VPS>
   ```
   Caddy obtiendra seul le certificat TLS de ces sous-domaines (blocs déjà dans `deploy/Caddyfile`).
   Celui de `turn.moodit.ca` est lu par le serveur TURN intégré à LiveKit.

2. **Pare-feu** — le média WebRTC passe **en direct** (pas par Caddy/443), il faut ouvrir :
   ```bash
   ufw allow 7882/udp    # média WebRTC (UDP, le chemin normal)
   ufw allow 7881/tcp    # repli ICE/TCP si l'UDP est bloqué côté client
   ufw allow 3478/udp    # TURN/UDP
   ufw allow 5349/tcp    # TURN/TLS (VPN/proxy qui bloquent l'UDP, ex. Edge Secure Network)
   ```
   Si un **firewall Hetzner Cloud** est actif, y autoriser aussi ces 4 ports.

   **Renouvellement du cert TURN** — LiveKit ne lit le cert qu'au démarrage ; Caddy le renouvelle
   tous les ~60 j. Ajouter un cron hebdo (nuit, hors usage) sur le VPS (`crontab -e`) :
   ```
   0 5 * * 1  docker restart moodit_livekit
   ```

3. **Secrets** (`.env.docker`) — renseigne :
   ```
   VOICE_ENABLED=true
   LIVEKIT_URL=wss://livekit.moodit.ca          # DOIT matcher le sous-domaine ci-dessus
   LIVEKIT_API_KEY=<une clé>
   LIVEKIT_API_SECRET=<secret ≥ 32 octets>      # openssl rand -base64 48
   ```
   `VOICE_ENABLED=true` active le backend ET l'UI vocale (le frontend lit ce flag **au build**
   via `build.args`, donc un rebuild de l'image frontend est nécessaire après activation).

4. **Déploiement** — depuis la racine :
   ```bash
   docker compose --env-file .env.docker -f docker-compose-hetzner.yml up -d --build
   ```
   Vérifie : `livekit` up (`...ps`), `wss://livekit.moodit.ca` répond (cert OK), et un join
   de salon vocal dans l'app connecte deux onglets qui s'entendent.

> Architecture : la **signalisation** va `navigateur → wss://livekit.moodit.ca` (Caddy → `livekit:7880`
> en interne) ; le **média** va `navigateur → UDP <IP_VPS>:7882` en direct (repli TCP 7881,
> puis TURN 3478/udp ou 5349/tls si le client ne peut pas joindre le SFU directement). Le `voice-service`
> ne signe que le JoinToken ; la **présence** (qui est là / qui parle) reste dans `core-service`.

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
