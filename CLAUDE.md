# MoodIT — instructions pour Claude

Plateforme d'entraide étudiante (UdeS). Microservices Spring Boot 4.0.6 / Java 25 + frontend React 19 / Vite / TypeScript, une base PostgreSQL 16 partagée.
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

- **Autorisations** : toute nouvelle route d'écriture (POST/PUT/PATCH/DELETE) doit avoir sa règle dans `permission-service` (`PermissionService`). Pas de vérification de rôle codée en dur dans un autre service.
- **Manifestes de routes** : après avoir ajouté ou modifié une route dans core, mcp ou execution, lancer `./gradlew test --tests '*MutatingRouteManifestTest'`. Le test réécrit `src/test/resources/mutating-routes.txt` / `readable-routes.txt` et échoue une fois ; relancer, puis committer ces fichiers. `RouteCoverageTest` (permission-service) vérifie que chaque route a une règle.
- **Endpoints internes** : appels service-à-service sous `/internal/**`, protégés par le header `X-Internal-Token` (`INTERNAL_TOKEN`). Ils ne passent pas par le gateway.
- **Schéma de BD** : pas de Flyway pour l'instant ([#96](https://github.com/TheHexaLab/MoodIT/issues/96)). Tout changement se fait **à deux endroits** : `init.sql` (bases neuves) **et** un nouveau script idempotent `migrations/AAAA-MM-JJ_sujet.sql` (bases existantes).
- **Secrets** : le dépôt est public. Ne jamais committer `.env`, de clés ou de jetons. Les secrets de prod (`application-prod.properties`) n'ont pas de valeur de repli.
- **Analyse MCP** : si le LLM est injoignable, `mcp-service` produit une analyse déterministe de repli. Ne pas casser ce repli.

## Conventions

- Code (identifiants) en anglais ; commentaires, messages d'interface, issues et PR en **français**.
- Branches : `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/` (ou `ci/`) + numéro d'issue, ex. `feat/43-systeme-amis`.
- Titres de commits et de PR : commits conventionnels, `type(portée): description` (ex. `fix(core): …`). Les labels de PR sont posés automatiquement à partir du titre et des fichiers touchés.
- Description de PR : remplir `pull_request_template.md` et lier l'issue (`Closes #43`).
- Avant d'ouvrir une PR : tests des services touchés + `npm run lint` si le frontend est touché.

## CI

`.github/workflows/tests.yml` lance `./gradlew test` pour auth, core, execution, gateway et mcp, l'intégration core (Testcontainers) et execution (vrai Piston), puis `tsc` + Vitest + ESLint pour le frontend. `permission-service` n'est **pas** dans la matrice ([#89](https://github.com/TheHexaLab/MoodIT/issues/89)) : lancer ses tests en local.
