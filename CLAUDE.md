# MoodIT — instructions pour Claude

Plateforme d'entraide étudiante (UdeS). Microservices Spring Boot 4.0.9 / Java 25 + frontend React 19 / Vite / TypeScript, une base PostgreSQL 16 partagée.
La documentation complète est dans le [wiki](https://github.com/TheHexaLab/MoodIT/wiki) : s'y référer plutôt que de deviner, et ne pas la recopier ici.

## Structure

| Dossier | Port | Rôle |
|---|---|---|
| `gateway/` | 8080 | Point d'entrée unique : validation JWT, routage vers les services |
| `core-service/` | 8081 | Cours, forums, quiz, temps réel (STOMP), audit |
| `mcp-service/` | 8082 | Analyse MCP d'un cours par LLM (API compatible OpenAI) |
| `auth-service/` | 8083 | Inscription, connexion, 2FA, réinitialisation |
| `permission-service/` | 8084 | Toutes les décisions d'autorisation |
| `execution-service/` | 8085 | Exécution de code des quiz via Piston |
| `frontend/` | 5173 | React ; le serveur Vite proxifie `/api`, `/auth`, `/mcp`, `/exec`, `/ws`… vers le gateway |

`voice-service/` (8086, LiveKit) existe seulement sur `feature/voice-chat-prototype` pour l'instant.

Chaque service Java est un **projet Gradle indépendant** (pas de build racine). Packages : `com.moodit.<nom>_service` (ex. `com.moodit.core_service`), et `com.moodit.gateway`.

## Commandes

Toujours lancer depuis le dossier du service, jamais depuis la racine :

```bash
./gradlew test                 # tests d'un service Java (Windows : .\gradlew.bat test)
./gradlew integrationTest      # core-service seulement, Testcontainers (Docker requis)
npm run test                   # frontend : Vitest
npm run lint                   # frontend : ESLint, --max-warnings 0
npm run build                  # frontend : tsc -b + vite build
docker compose -f docker-compose-dev.yml up -d   # Postgres + pgAdmin pour le dev local
```

- `CoreServiceApplicationTests` a besoin d'un Postgres sur `localhost:5432` (lancer `docker-compose-dev.yml`).
- Les services lisent le `.env` de la racine (`spring.config.import=optional:file:../.env[.properties]`). Partir de `.env.example`.
- Fichiers compose : `-dev` = dev local, `-ci` = CI, `-prod` = prod avec Ollama, `-hetzner` = déploiement réel.

## Règles à respecter

- **Autorisations** : toute nouvelle route, lecture comme écriture, doit avoir sa règle dans `permission-service` (`PermissionService`) ; sans règle, le gateway répond 403. Une lecture ouverte à tout authentifié porte une règle `-> true`. Pas de vérification de rôle codée en dur dans un autre service.
- **Manifestes de routes** : après avoir ajouté ou modifié une route dans core, mcp ou execution, lancer `./gradlew test --tests '*MutatingRouteManifestTest'`. Le test réécrit `src/test/resources/mutating-routes.txt` / `readable-routes.txt` et échoue une fois ; relancer, puis committer ces fichiers. `RouteCoverageTest` (permission-service) vérifie que chaque route a une règle, et que la règle appliquée est celle de la route que Spring sert.
- **Endpoints internes** : appels service-à-service sous `/internal/**`, protégés par le header `X-Internal-Token` (`INTERNAL_TOKEN`). Ils ne passent pas par le gateway.
- **Schéma de BD** : pas de Flyway pour l'instant ([#96](https://github.com/TheHexaLab/MoodIT/issues/96)). Tout changement se fait **à deux endroits** : `init.sql` (bases neuves) **et** un nouveau script idempotent `migrations/AAAA-MM-JJ_sujet.sql` (bases existantes).
- **Secrets** : le dépôt est public. Ne jamais committer `.env`, de clés ou de jetons. `JWT_SECRET`, `APP_SECURITY_PEPPER` et `INTERNAL_TOKEN` n'ont de valeur de repli dans aucun profil : un service démarre seulement s'ils sont définis (`.env` en local). Les tests prennent les leurs dans `src/test/resources/config/application.properties`.
- **Analyse MCP** : si le LLM est injoignable, `mcp-service` produit une analyse déterministe de repli. Ne pas casser ce repli.
- **Popups frontend** : toute fenêtre modale passe par `frontend/src/components/Popup` (`<Popup variant={PopupVariant.…}>`), qui fournit le voile, le conteneur selon la variante, le rôle `dialog`, le focus, Échap et l'animation de sortie. Ne pas réécrire d'overlay dans un composant ; un gestionnaire Échap interne (liste déroulante, édition en ligne) doit appeler `stopPropagation()`.

## Conventions

- Code (identifiants) en anglais ; commentaires, messages d'interface, issues et PR en **français**.
- Branches : `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/` (ou `ci/`) + numéro d'issue, ex. `feat/43-systeme-amis`.
- Titres de commits et de PR : commits conventionnels, `type(portée): description` (ex. `fix(core): …`). Les labels de PR sont posés automatiquement à partir du titre et des fichiers touchés.
- Description de PR : remplir `.github/pull_request_template.md` (proposé automatiquement par GitHub) et lier l'issue (`Closes #43`). Code assisté par IA : label `vibe-coded`.
- Avant d'ouvrir une PR : tests des services touchés + `npm run lint` si le frontend est touché.

## CI

`.github/workflows/tests.yml` (PR, push sur `main` et `deploiement`, chaque nuit) : `./gradlew test` des 6 services, intégration core (Testcontainers) et execution (vrai Piston), job `schema` (init.sql + migrations sur Postgres puis démarrage prod de auth/core/permission avec `ddl-auto=validate`), frontend (`npm run build` + Vitest + ESLint), puis Playwright contre la pile complète (`docker-compose-e2e.yml`, script `frontend/e2e/core/start-stack.sh`) : sur une PR, Chromium desktop en deux moitiés et les cinq profils tablette/mobile ; Firefox et WebKit desktop s'ajoutent sur `main` et la nuit. Les tests Playwright tournent dans l'image officielle `mcr.microsoft.com/playwright` (pas d'apt sur le chemin critique) avec la police Inter montée ; les images de la pile sont en cache de build gha (`docker-compose-ci-cache.yml`). Job `coverage` : une ligne verte ou rouge par service selon son seuil de couverture des lignes (`.github/coverage-thresholds.json` : 90 % pour tous les services ; un seuil ne baisse jamais). Sur une PR, deux contrôles de plus dans ce job (#108) : cliquet (PR vers `main` seulement), la couverture d'un service ne baisse pas de plus de 0,1 point par rapport à la dernière mesure de `main` (référence en cache, écrite seulement par un push sur `main` au vert ; les baisses tolérées peuvent s'additionner, choix assumé dans `coverage-gate.py`) ; code modifié, au moins 90 % des lignes ajoutées ou modifiées sont couvertes (`changed_lines`, script `coverage-changed.py`, lignes non couvertes annotées sur la PR). Job `mutation` (la nuit et sur `main`, pas sur `deploiement`) : PIT sur les six services Java, seuil de score de 90 % partout dans leur `build.gradle.kts` (`mutationThreshold`) ; en local `./gradlew pitest`, rapport dans `build/reports/pitest/`, à partir des rapports JaCoCo et Vitest. En local : `./gradlew test` produit `build/reports/jacoco/test/`, `npm run test:coverage` produit `frontend/coverage/`. `.github/workflows/security.yml` (PR, push sur `main` et `deploiement`, chaque lundi) : CodeQL, gitleaks, Trivy (bloquant sur les CVE critiques corrigeables, sur les PR comme sur `main`), Dependabot, et le job `actions-pinned` (bloquant) : toute action est épinglée par SHA complet avec la version en commentaire, `uses: actions/checkout@<sha> # v7.0.1`, jamais `@v7`. `.github/workflows/ci-alert.yml` : quand Tests ou Sécurité échoue sur `main`, `deploiement` ou la nuit, une issue « CI en échec : <workflow> sur <branche> » (label `ci`) est ouverte ou commentée, puis fermée au run vert suivant ; rejouable à la main sur un run donné (`run_id`). Voir `frontend/e2e/core/README.md` pour écrire ou déboguer un test e2e.
