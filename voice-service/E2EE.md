# Chiffrement de bout en bout (E2EE) des salons vocaux — conception

> Statut : conception **validée** (réponses §8 : oui à tout).
> - **E0 fait** : spike validé sur Chrome, Edge et Firefox ; `encryptionType 0` sur le data channel
>   avec l'option `e2ee` → l'échange de clés E2 passera par le data channel LiveKit.
> - **E1 codé** (tests auto OK, test manuel à faire) : clés d'appareil (`e2ee/deviceCrypto.ts`,
>   `deviceStore.ts`), annuaire core (`voice/e2ee/`, table `Device_Key`), règles permission,
>   identité LiveKit `userId.deviceId` + `name = username`, plafond 50/salon (`room.max_participants`).
> - **E2 codé** (tests auto OK, test manuel à faire) : `e2ee/protocol.ts` (annonces signées,
>   enveloppes ECDH+HKDF+AES-GCM), `e2ee/E2EEKeyExchange.ts` (vérif des pairs via l'annuaire,
>   rotation à chaque arrivée/départ, anti-rejeu par `seq`). Clés du spike SUPPRIMÉES ; E2EE
>   désormais toujours actif. Worker chargé en same-origin (`/assets/…`) → compatible CSP prod.
> - **E3 codé** : TOFU (`e2ee/trustStore.ts`, IndexedDB par compte local ; clé changée → statut
>   `keyChanged`, refus), codes de sécurité 12×5 chiffres (`e2ee/safetyCode.ts`) + « marquer
>   vérifié », écran « Mes appareils » (révocation), email « nouvel appareil » (core → auth-service
>   `/internal/mail/new-voice-device`, après commit), éjection d'un appareil révoqué (core →
>   voice-service `/internal/devices/{id}/eject` → API serveur LiveKit `RemoveParticipant`).
> - **Caméra + partage d'écran** : aucune crypto spécifique, le SDK chiffre TOUTES les pistes
>   publiées avec la clé média du participant (rotations comprises). `adaptiveStream` + `dynacast`
>   activés (le SFU choisit les couches simulcast sur les en-têtes RTP, sans lire le contenu).
> - Tests E2E Playwright (`frontend/e2e/`) : Chromium + Edge, audio ET vidéo DÉCHIFFRÉS mesurés,
>   rotations, codes de sécurité, éjection. Firefox de Playwright : WebRTC KO (vrai Firefox OK).
> - Limite assumée : un appareil révoqué peut se ré-enregistrer comme NOUVEL appareil si la
>   session du compte est encore valide (d'où l'email « nouvel appareil » et le conseil de changer
>   de mot de passe). Révoquer un appareil ≠ fermer les sessions du compte.
>
> ⚠ **Prod** : `ddl-auto=validate` → appliquer `migrations/2026-10-12_device_key.sql` AVANT de
> déployer core. En dev, sur une BD antérieure au vocal chiffré : même script (ou
> `frontend/e2e/setup/dev-db.sql`, qui l'inclut) — core ne crée pas les tables lui-même.
> Branche : `feature/voice-chat-prototype`. SDK : `livekit-client` 2.22.4, serveur LiveKit v1.13.9.

## 1. Pourquoi, et ce que ça change

Aujourd'hui l'audio est chiffré **en transit** (DTLS-SRTP navigateur ↔ SFU, + TLS pour le TURN),
mais le **SFU LiveKit le voit en clair** : il déchiffre chaque paquet puis le rechiffre pour chaque
destinataire. Quiconque contrôle le serveur (nous, un hébergeur, un attaquant qui le compromet) peut
écouter.

Objectif : seuls les navigateurs **présents dans le salon** peuvent déchiffrer l'audio. Le SFU ne
relaie que des trames opaques. Les clés ne transitent **jamais** en clair par un serveur MoodIT.

## 2. Modèle de menace

| | Couvert ? |
|---|---|
| Opérateur/compromission du SFU, du TURN, du backend MoodIT qui veut **écouter** | ✅ |
| Backend malveillant qui **ajoute un faux appareil** à un utilisateur pour recevoir les clés | ⚠ détectable (codes de sécurité + notification d'appareil, §5.3), pas empêché |
| Personne qui a **quitté** le salon et continue de capter le flux | ✅ (rotation à chaque départ) |
| Personne qui **arrive** et voudrait déchiffrer ce qui a été dit avant | ✅ (rotation à chaque arrivée) |
| Réseau (Wi-Fi, FAI) | ✅ (déjà le cas) |
| Métadonnées : qui est dans quel salon, quand, combien de temps, qui parle (taille des paquets Opus VBR) | ❌ hors périmètre, le serveur les voit |
| Navigateur compromis (XSS, extension malveillante) | ❌ hors périmètre (atténué par la CSP stricte `script-src`) |
| Déni de service (serveur qui jette les messages de clés) | ❌ l'appel échoue, il ne fuit pas |

Conséquences produit : **aucun enregistrement / transcription côté serveur** possible ; le
server-mute modérateur reste possible (plan de contrôle, pas le contenu).

## 3. Vue d'ensemble

```
 Navigateur A                         Serveurs MoodIT                       Navigateur B
 ─────────────                        ───────────────                       ─────────────
 clé d'identité (IndexedDB) ──pub──►  annuaire de clés (core, BD) ◄──pub── clé d'identité
 clé de session éphémère  ─signée──►  LiveKit data channel (relaie) ──────► vérifie signature
 clé média K_A (aléatoire) ─enveloppe chiffrée pour B uniquement─────────► déchiffre K_A
 audio ── chiffré K_A (worker) ─────► SFU (ne voit que des trames opaques) ──► déchiffre K_A
```

Trois niveaux de clés :

1. **Clé d'identité d'appareil** (longue durée) — prouve « je suis l'appareil X de l'utilisateur U ».
2. **Clé de session** (une par connexion au salon, jetée à la sortie) — sert à l'échange de clés,
   donne la confidentialité persistante (forward secrecy).
3. **Clé média** (une par émetteur, renouvelée à chaque arrivée/départ) — chiffre les trames audio.

C'est le modèle « sender keys » (une clé par émetteur) utilisé conceptuellement par DAVE (Discord),
sans l'arbre MLS. Il est adapté aux salons de cours (quelques dizaines de personnes, coût O(n²)
messages par rotation, négligeable à cette échelle). Voir §9 pour la migration MLS éventuelle.

## 4. Primitives (WebCrypto uniquement, zéro dépendance crypto)

| Usage | Algo | Pourquoi |
|---|---|---|
| Identité (signature) | ECDSA P-256 / SHA-256 | Supporté partout (Chrome, Edge, Firefox, Safari). Ed25519 est plus récent dans WebCrypto, on évite. |
| Échange de clés | ECDH P-256 | Idem |
| Dérivation | HKDF-SHA-256 | |
| Enveloppe de clé | AES-256-GCM | |
| Chiffrement des trames | celui du SDK LiveKit (AES-GCM, worker `livekit-client/e2ee-worker`) | Éprouvé, on ne réécrit pas de frame cryptor |

Les clés privées sont générées **non extractibles** (`extractable: false`) et stockées comme objets
`CryptoKey` dans **IndexedDB** (pas localStorage) : même un script injecté ne peut pas les exfiltrer
(il peut s'en servir tant qu'il tourne, d'où la CSP).

## 5. Composants

### 5.1 Clé d'identité d'appareil (front)

- Générée au premier usage du vocal, par **profil de navigateur** = un « appareil » (`deviceId` UUID).
  Chrome et Edge du même utilisateur = deux appareils, c'est normal.
- Deux paires : `sign` (ECDSA) et `dh` (ECDH). `dh_pub` est signée par `sign`.
- Effacer les données du site = nouvel appareil (les autres verront « nouvel appareil »).

### 5.2 Annuaire de clés publiques (backend)

Dans **core-service** (il a la BD et `User_` ; voice-service reste sans état). Package
`voice/e2ee`, sous le flag `moodit.voice.enabled` comme le reste du vocal.

Nouvelle table dans **init.sql** (pas Hibernate) :

```sql
CREATE TABLE Device_Key(
   id SERIAL,
   user_id INTEGER NOT NULL,
   device_id UUID NOT NULL UNIQUE,
   sign_pub TEXT NOT NULL,          -- SPKI base64
   dh_pub TEXT NOT NULL,            -- SPKI base64
   dh_sig TEXT NOT NULL,            -- signature de dh_pub par sign_pub
   created_at TIMESTAMP NOT NULL DEFAULT NOW(),
   revoked_at TIMESTAMP,
   PRIMARY KEY(id),
   FOREIGN KEY(user_id) REFERENCES User_(id) ON DELETE CASCADE
);
```

Endpoints (route `/api/**` → core, aucune modif gateway) :

| Méthode | Chemin | Rôle | Autorisation |
|---|---|---|---|
| POST | `/api/keys/devices` | enregistrer SON appareil (identité = `X-User-Email`) | authentifié ; refuse un `device_id` déjà pris par un autre user |
| GET | `/api/keys/devices/me` | lister ses propres appareils | authentifié |
| DELETE | `/api/keys/devices/{deviceId}` | révoquer un de ses appareils | propriétaire |
| GET | `/api/keys/devices/{deviceId}` | clé publique d'un appareil | utilisateurs qui partagent un programme |

⚠ Pièges connus (cf. permission-service) : ajouter les règles dans `PermissionService.buildRules()`
(écritures default-DENY) et les GET dans `readable-routes.txt` (garde-fou des lectures).

Le serveur **vérifie** `dh_sig` à l'enregistrement (rejette les clés incohérentes) mais n'est pas
digne de confiance pour autant : c'est le client qui fait foi (§5.3).

### 5.3 Confiance : TOFU + codes de sécurité + notification

Un annuaire contrôlé par le serveur peut mentir. Trois défenses, du plus automatique au plus fort :

1. **TOFU** (*trust on first use*) : chaque client mémorise dans IndexedDB les clés déjà vues
   (`deviceId → sign_pub`). Même `deviceId` avec une **autre** clé = alerte rouge, on refuse de lui
   envoyer notre clé média.
2. **Notification d'appareil** : à chaque `POST /api/keys/devices`, email « Nouvel appareil ajouté
   au vocal chiffré ». Un faux appareil injecté par le serveur sans passer par l'API ne déclenche
   pas l'email, mais apparaît dans « Mes appareils » (§5.1 GET me) et dans la liste du salon.
3. **Code de sécurité** : pour deux appareils, `SHA-256(tri(sign_pub_A, sign_pub_B))` affiché en
   12 groupes de 5 chiffres (style Signal). Comparé de vive voix / en personne → appareil marqué
   « vérifié » localement.

UI participant : 🔒✔ vérifié · 🔒 chiffré non vérifié · ⚠ clé changée (exclu) · ⏳ en attente de clé.

### 5.4 Identité LiveKit

Aujourd'hui `identity = email` (TODO confidentialité dans `VoiceTokenController`). Proposition :
**`identity = "<userId>.<deviceId>"`**, `name = username`.

- Règle le TODO (l'email n'est plus visible des autres).
- Règle au passage `DUPLICATE_IDENTITY` : deux navigateurs du même compte = deux identités.
- `POST /api/voice/token` reçoit `{channelId, deviceId}` ; voice-service demande à core que
  `deviceId` appartienne bien à l'utilisateur (`X-User-Email`) avant de signer.
- ⚠ Impacte la présence sidebar (`VoicePresenceRegistry`) qui raisonne aujourd'hui par email/session :
  à vérifier en E1.

### 5.5 Échange de clés (front)

À la connexion au salon, chaque appareil :

1. génère une **paire ECDH de session** éphémère (non extractible, oubliée à la sortie) ;
2. diffuse `SessionAnnounce { v, room, identity, deviceId, sessionPub, ts, sig }` signé par sa clé
   d'identité ;
3. pour chaque annonce reçue : récupère `sign_pub` de l'émetteur via l'annuaire (+ TOFU), vérifie
   la signature, la `room` et la fraîcheur de `ts` (±2 min, anti-rejeu).

Puis pour envoyer sa clé média `K_A` (index `n`) à B :

```
secret  = ECDH(sessionPriv_A, sessionPub_B)
wrapKey = HKDF(secret, salt = room, info = "moodit-voice-e2ee/v1/" + idA + "->" + idB)
KeyMsg  = { v, room, from: idA, to: idB, keyIndex: n, iv, ct: AES-GCM(wrapKey, K_A, aad = en-tête) }
```

`KeyMsg` est authentifié implicitement (seule la session de A, annoncée et signée, peut produire
`wrapKey`), donc pas de seconde signature.

**Transport** : LiveKit data channel, fiable, `topic: "moodit.e2ee"`, `destinationIdentities: [B]`.
Les messages sont auto-protégés, le SFU ne fait que relayer.

⚠ **Piège vérifié dans le SDK 2.22.4** : passer l'option `encryption` à `new Room()` active
**aussi le chiffrement du data channel** avec les clés média (`dcEncryptionEnabled = !!options.encryption`).
Un arrivant recevrait nos messages de clés… chiffrés avec une clé qu'il n'a pas encore → blocage.
Options : (a) utiliser l'option `e2ee` (dépréciée, ne chiffre que le média) ; (b) faire transiter les
messages de clés par notre `/ws` applicatif. On isole le transport derrière une interface
`KeyTransport` pour basculer de (a) à (b) sans toucher au reste. **Choix initial : (a), à
confirmer au spike E0.**

### 5.6 Clés média et rotation

- `K_A` = 32 octets aléatoires (`crypto.getRandomValues`), passés au SDK via un **KeyProvider
  maison** : `class MooditKeyProvider extends BaseKeyProvider` avec `sharedKey: false`, qui appelle
  `onSetEncryptionKey(cryptoKey, participantIdentity, keyIndex)` pour sa propre clé et celles reçues.
- `keyringSize: 16` (garde les anciens index le temps de la transition), `ratchetWindowSize: 0`
  (pas d'auto-ratchet sur échec : nos clés ne sont pas dérivées par ratchet, un ratchet silencieux
  désynchroniserait émetteur et récepteurs).
- **Toute arrivée ou départ** → chaque émetteur tire une **nouvelle** `K` (index `n+1`), l'envoie
  aux membres présents (hors partant), et **ne bascule dessus qu'après ~1 s** (le temps que les
  destinataires l'aient). Les trames portent l'index, le récepteur prend la bonne clé dans son
  trousseau.
- **Anti-rafale** : rotations groupées (debounce 300 ms) quand toute une classe arrive en même temps.
- Pas de rotation périodique au départ (pas nécessaire au modèle de menace), ajoutable plus tard.

### 5.7 Garde-fous côté client

- `isE2EESupported()` faux → on **refuse** de rejoindre (message clair), jamais de repli en clair.
- E2EE activé **avant** de publier le micro : aucune trame ne part en clair, même brièvement.
- Pas de clé pour un participant → on ne l'entend pas (⏳), on ne joue jamais de bruit chiffré.
- Le worker est chargé en module same-origin
  (`new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' })`),
  compatible avec la CSP actuelle (`worker-src` retombe sur `script-src 'self'`). À vérifier au build.

## 6. Ce qui change, fichier par fichier (estimation)

| Zone | Changement |
|---|---|
| `init.sql` | table `Device_Key` |
| core-service `voice/e2ee/` | entité, repo, contrôleur annuaire, email de notification |
| permission-service | règles POST/DELETE `/keys/devices`, lectures GET |
| voice-service | `deviceId` dans la requête de token, vérif d'appartenance, `identity = userId.deviceId` |
| front `components/Voice/e2ee/` | `deviceKeys.ts` (IndexedDB), `keyDirectory.ts` (API), `keyExchange.ts` (annonces/enveloppes), `MooditKeyProvider.ts`, `safetyCode.ts` |
| `useVoiceRoom.ts` | création du Room avec E2EE, orchestration rotation, statuts par participant |
| `VoicePanel.tsx` | cadenas, alertes, écran « code de sécurité », « Mes appareils » |

## 7. Plan par étapes

| Étape | Contenu | Critère de sortie |
|---|---|---|
| **E0 — spike** | KeyProvider maison + clé en dur, 2 navigateurs (Chrome + Edge + Firefox) ; trancher le transport (§5.5) ; worker + CSP en build prod | audio déchiffré entre 2 navigateurs, rien d'audible côté serveur |
| **E1 — identité** | clés d'appareil, annuaire, règles permission, `identity = userId.deviceId`, présence adaptée | appareil enregistré, token émis seulement pour un appareil du user |
| **E2 — échange** | annonces signées, enveloppes, rotation arrivée/départ, debounce | 3+ participants, arrivées/départs, le partant n'entend plus |
| **E3 — confiance** | TOFU, alerte clé changée, codes de sécurité, « Mes appareils », email | scénario « serveur injecte un appareil » visible dans l'UI |
| **E4 — tests & revue** | vecteurs de test crypto (Vitest, WebCrypto dispo dans Node), E2E multi-navigateurs (Playwright, faux média), revue sécurité | CI verte + revue |

## 8. Décisions (validées le 2026-10-12)

Toutes les propositions ci-dessous ont été acceptées : identité `userId.deviceId`, E2EE
obligatoire (pas de mode mixte), email « nouvel appareil » (E3), plafond 50 participants (fait en
E1), éjection immédiate d'un appareil révoqué (E3, via l'API serveur LiveKit `RemoveParticipant`).

### Questions d'origine

1. OK pour `identity = userId.deviceId` (impacte présence et le TODO email) ?
2. Le vocal chiffré devient-il **obligatoire** (pas de mode mixte) ? Recommandé : oui.
3. Email de notification « nouvel appareil » : acceptable vis-à-vis du volume d'emails ?
4. Limite de taille d'un salon (le coût est O(n²) par rotation) : plafonner à 50 ?
5. Un appareil révoqué doit-il être éjecté des salons en cours (rotation immédiate) ?

## 9. Évolution possible : MLS / DAVE

Le modèle ci-dessus sépare **distribution des clés** (§5.5) et **chiffrement des trames** (SDK).
Passer à MLS (ce que fait DAVE) ne remplacerait que la distribution : un arbre MLS donne des
rotations en O(log n) et une preuve formelle, utile au-delà de ~100 participants. Aucune
bibliothèque MLS navigateur auditée et mûre aujourd'hui → différé.
