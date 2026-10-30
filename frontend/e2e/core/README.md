# Tests E2E du frontend (Playwright)

Tous les parcours du frontend, dans de vrais navigateurs, contre la pile **Docker Compose** (vraies
images, profil dev). Ils tournent en CI (job `e2e` de `.github/workflows/tests.yml`) : sur une PR,
Chromium desktop en deux moitiés (`--shard`) et les cinq profils tablette/mobile dans un seul job ;
Firefox et WebKit desktop s'ajoutent sur push vers `main` et chaque nuit. Chaque job démarre sa pile
(images en cache de build gha) et joue ses tests dans l'image officielle de Playwright. Les tests vocaux (`e2e/voice`, branche vocale)
sont à part : ils exigent LiveKit.

## Profils (`playwright.core.config.ts`)

| Profil | Appareil | Ce qui tourne |
|---|---|---|
| `desktop-chromium`, `desktop-firefox`, `desktop-webkit` | 1280×720 | toute la suite |
| `tablet-portrait` (iPad Mini, 768 px), `tablet-landscape` (1024 px) | WebKit | `responsive/` |
| `mobile-chromium` (Pixel 7, 412 px), `mobile-webkit` (iPhone 14, 390 px), `mobile-small` (Galaxy S8, 360 px) | | `responsive/` |

Les points de rupture CSS du frontend sont 900 px (barre latérale en tiroir), 1024, 768, 480 et
360 px : chaque profil en exerce un.

## Lancer en local

Depuis la racine du dépôt (Docker requis ; ports 5173, 8080, 8025 et 2000 libres, donc pile de dev
arrêtée) :

```bash
sh frontend/e2e/core/start-stack.sh      # construit, démarre et prépare la pile (même script que la CI)
cd frontend
npx playwright install chromium firefox webkit   # une fois
npx playwright test e2e/core --config playwright.core.config.ts --project=desktop-chromium
npx playwright test e2e/core --config playwright.core.config.ts --project=mobile-chromium
```

Arrêt et effacement de la base : la commande `down -v` affichée à la fin de `start-stack.sh`.

## La pile E2E (`docker-compose-e2e.yml`)

| Élément | Différence avec la prod |
|---|---|
| Services Spring | Profil **dev** : endpoint de validation `/auth/verify/{username}`, code 2FA fixe `000000` (`DevFixedTwoFactorCode`, refusé hors dev). Valeurs bidons, y compris par-dessus un `.env.docker` local : aucun secret. |
| Courriels | Capturés par **Mailpit** (http://localhost:8025) : les tests y lisent les codes de validation et de réinitialisation (`readCodeFromMail`). |
| mcp-service | Sans clé LLM : **repli déterministe**, sans Ollama ni réseau. |
| Piston | Sans `piston-init` : seul **Python** est installé (par `start-stack.sh`). |

`bootstrap.sh` (appelé par `start-stack.sh`) crée les comptes à rôles et l'établissement des
comptes à courriels lus.

## Comptes

| Compte | Rôle | Usage |
|---|---|---|
| `alice`, `bob`, `carol` (`@e2e.test`) | étudiants du programme 1 / cours MAT115 | `e2e/setup/global-setup.ts`, session dans `e2e/.auth/<compte>.json` (`storageStatePath`) |
| `gardien@e2e.test` | Gardien (global) | établissements, journal d'audit, administrateurs, programmes |
| `padmin@e2e.test` | Administrateur du programme 1 | rôles du programme, modification, modération |
| `prof@e2e.test` | Enseignant du programme 1 | cours, sections, quiz, analyse MCP (ne modère pas) |

`sessionAs(baseURL, email)` ouvre une session pour l'un d'eux ; `createEnrolledUser(baseURL)` crée
un compte **neuf**.

## Organisation

| Fichiers | Contenu |
|---|---|
| `auth`, `account`, `profile`, `navigation` | compte, réglages, barre latérale |
| `subscription`, `course-admin`, `sections`, `establishments`, `roles`, `audit` | gestion (abonnements, cours, programmes, rôles, journal) |
| `chat`, `forum`, `mcp` | temps réel, forum complet, analyse MCP |
| `quiz`, `quiz-editor` | quiz côté étudiant (6 types, Piston) et éditeur |
| `errors` | chaque action sous panne serveur (500) puis réseau (`abort`) : message, saisie conservée, reprise |
| `scrolling`, `details` | défilements infinis ; Markdown complet, validations, longueurs max, quiz du jour, hors-ligne |
| `a11y`, `keyboard`, `focus-visible` | audit axe (WCAG 2.1 AA, clair + sombre), navigation clavier, indicateur de focus |
| `responsive/` | disposition par largeur, débordements, parcours tactiles, rotation, cibles tactiles |
| `mobile-back` | bouton « back » : vue dans l'URL, jamais de retour à l'authentification (#63) |
| `security-headers` | en-têtes de sécurité de l'image nginx (#93) et aucune violation de la CSP (Report-Only), KaTeX compris |
| `*.helpers.ts`, `fixtures.ts` | helpers par domaine ; `test` commun (ferme les contextes ouverts) |

## Pièges à connaître

- **Un compte n'a qu'une session active** : toute connexion (`sessionAs`, `loginThroughUi`, setup
  global) révoque les autres sessions du même compte. Ne jamais reconnecter alice/bob/carol dans un
  test ; une seule session par test pour gardien/padmin/prof. En CI (un seul worker), sans effet.
- **`POST /api/courses/users` remplace** la liste des cours suivis d'un programme.
- **L'ordre des cours du sélecteur n'est pas garanti** (`User.enrollments` sans `@OrderBy` ; après
  un remplacement des inscriptions, Postgres peut renvoyer GIF201 avant MAT115). Après avoir ouvert
  le programme, forcer le cours voulu : `ensureCourse` (`dashboard.helpers.ts`) ou `pickCourse`
  (`responsive.helpers.ts`).
- **Les menus contextuels se ferment au moindre défilement** (y compris un message WS qui arrive) :
  `clickProgramMenu` / `clickCourseMenu` d'`admin.helpers.ts` réessaient.
- **Le dernier emplacement est restauré par compte** : ne pas supposer qu'un cours est ouvert au
  chargement. La vue est dans l'URL (`/home/p/<programme>/c/<cours>/<type>/<id>`, #63) : à l'arrivée
  sur `/home`, l'URL passe à la vue restaurée. Tester l'arrivée avec `toHaveURL(/\/home(\/|$)/)`.
- **Les pages d'authentification renvoient vers `/home` une session active** (#63) : pour tester
  `/login` ou `/register`, partir d'un contexte sans cookie.
- **La police change le layout** : l'app sert elle-même Inter (`src/fonts.css`, woff2 du paquet
  `@fontsource-variable/inter`, #115), le rendu est donc le même sur Windows, macOS et Linux sans
  police installée. Si elle ne se chargeait plus, le repli (DejaVu Sans sur Linux, plus large)
  ferait déborder le titre du forum de 41 px à 390 px ; en cas de débordement, le message
  d'erreur liste les éléments en cause et la police effective. Pour reproduire le rendu des
  runners : `docker run --rm -v "$PWD:/work" -w /work -e E2E_BASE_URL=http://host.docker.internal:5173
  mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test …`.
- **WebKit dispatche les événements de pointeur sans laisser React rendre** : utiliser `pointerDrag`
  de `quiz.helpers.ts`, qui attend le rendu entre chaque pas.

## Écrire un test

- Importer `test`/`expect` de `./fixtures` (ou `../fixtures`), pas de `@playwright/test`.
- Les tests sont **rejouables** sans vider la base : ce qu'un test crée a un nom unique
  (`uniqueSuffix()`), et tout ce qui est à usage unique (tentative de quiz, essais 2FA ratés,
  changement de profil ou de rôle) se fait sur un compte neuf.
- Ne jamais modifier durablement le seed (programme 1, cours MAT115 et ses éléments) ni les
  comptes partagés : d'autres tests en dépendent.
- Sélecteurs par rôle et nom accessible (`getByRole`) ; par placeholder pour les champs sans
  `<label>` ; CSS seulement pour les éléments sans nom accessible.
- Chemins d'erreur : `injectFault` de `faults.helpers.ts` (500 ou `abort`), puis `restore()`.
- Un bogue connu de l'app : écrire le test attendu et le marquer `test.fail(true, '…')` avec la
  référence de l'issue (ex. `keyboard.spec.ts`, #110). Le test passe au rouge quand le bogue est
  corrigé : retirer `test.fail` dans la PR qui le corrige.

## Non testable (non branché dans l'UI)

Upload de la photo de profil, pièce jointe du chat, épinglage d'un sujet de forum, remise de
fichier (épopée #34).
