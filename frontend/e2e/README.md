# Tests E2E (Playwright)

Tests de bout en bout dans de vrais navigateurs, contre la **stack de DEV lancée en local**.
Ils couvrent aujourd'hui le **vocal chiffré de bout en bout** (`e2e/voice/`, cf.
`voice-service/E2EE.md`). Pour « entendre », les tests mesurent le niveau sonore des flux reçus
(WebAudio) : une trame mal déchiffrée est jetée → silence. Un signal mesuré prouve donc un audio
**déchiffré**, pas seulement une connexion.

## Pré-requis (une fois)

1. Navigateurs Playwright : `npx playwright install chromium firefox` (Edge : celui installé sur
   la machine, canal `msedge`).
2. BD de dev préparée (idempotent, rejouable) :
   ```bash
   docker exec -i moodit_postgres psql -U postgres -d moodit_db < e2e/setup/dev-db.sql
   ```
   Crée la table `Device_Key` (absente d'une BD antérieure au vocal chiffré) et l'établissement
   `e2e.test` (domaine des comptes de test : TLD réservé, aucun email ne peut partir vers une
   vraie personne).
   Donne aussi le rôle **Enseignant** du programme 1 à `e2e_carol` (modératrice des tests de
   modération) : sans effet tant que le compte n'existe pas, donc **rejouer ce fichier après le
   premier `npm run e2e`**.
3. Dans `.env` (racine) : `DEV_FIXED_2FA_CODE=000000` (2FA à code fixe, refusé hors profil dev).

## Lancer

1. Stack de dev : Postgres + LiveKit (`docker compose -f docker-compose-dev.yml up -d`), puis
   permission-service, auth-service, core-service, voice-service, gateway (`./gradlew bootRun`
   dans chacun) et le front (`npm run dev`).
2. Tests : `npm run e2e` (rapport HTML : `npm run e2e:report`).

`e2e/setup/global-setup.ts` crée au besoin les comptes `e2e_alice`, `e2e_bob`, `e2e_carol`
(`@e2e.test`), les abonne au programme 1 et au cours 1, révoque leurs appareils des runs
précédents (plafond de 20 appareils actifs) et enregistre leur session dans `e2e/.auth/`.
`closeAll` (fin de chaque test) révoque aussi les appareils créés par le test : sans ça, un run
complet sur plusieurs navigateurs dépasse le plafond en cours de route.

## Limites connues

- **Firefox** : le Firefox de Playwright (build modifié) n'établit pas la connexion WebRTC avec le
  LiveKit de dev (« ICE failed »), même avec loopback / mDNS / IP LAN. Un vrai Firefox fonctionne
  (validé à la main). Les tests vocaux sont donc ignorés sur le projet `firefox`.
- **Edge** : l'aperçu LOCAL de la caméra (fausse caméra) ne produit parfois aucune image
  (`voice-video.spec.ts`, « miroir ») — instable sur Edge seulement, Chromium stable.
- Les tests partagent le salon `Vocal - Mathématiques pour ingénieurs I` : ils tournent en série
  (`workers: 1`). Avant CHAQUE test, `e2e/setup/livekit-admin.ts` vide le salon via l'API serveur
  LiveKit (clés `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` du `.env`) : un test qui échoue ne laisse
  plus de participant « fantôme » qui ferait échouer les suivants.

## Ce qui est couvert (`e2e/voice/`)

- `voice-e2ee.spec.ts` : 2 comptes s'entendent (audio déchiffré mesuré) ; arrivée/départ d'un 3e
  (rotations de clés) ; même compte dans 2 navigateurs ; Chrome + Edge dans le même salon.
- `voice-trust.spec.ts` : code de sécurité identique des deux côtés + « ✔ vérifié » ; révoquer un
  appareil depuis un autre navigateur l'éjecte du salon en direct.
- `voice-moderation.spec.ts` : server-mute (silence mesuré, réactivation refusée, persiste après
  reconnexion, levée), expulsion de tous les appareils, refus 403 / 404, fermeture du salon à la
  suppression du canal (cf. `voice-service/MODERATION.md`).
- `voice-video.spec.ts` : caméra (miroir local, vue et DÉCHIFFRÉE chez l'autre, coupure) ; partage
  d'écran ; un arrivant déchiffre une vidéo déjà en cours (clé tournée). « Voir » = images décodées
  en continu (`getVideoPlaybackQuality`) : sans la bonne clé, 0 image (vérifié par mutation).
