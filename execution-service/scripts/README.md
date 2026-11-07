# Tests d'intégration manuels — exécution SQL

Les tests unitaires (`./gradlew test`) **mockent** l'exécution. Ces scripts valident la chaîne
**réelle**. Depuis le retrait de Piston (#116), `ExecutionIntegrationTest` (job CI `integration`)
couvre la même chose contre les vraies images runner — ces scripts restent utiles pour déboguer
à la main un binaire déployé.

## 1. `sql-isolation-e2e.js` — valide le DESIGN contre un sqlite3 réel

Rejoue la logique 2 phases (setup → code étudiant → `.dump` → filtre → verdict) directement
contre sqlite3. Utile pour vérifier que sqlite3 honore `.dump`/les dot-commands (dépendance
implicite), et que l'isolation tient (triche, DDL). Nécessite un conteneur avec node ET sqlite3 :

```sh
docker run --rm -v "$PWD":/s -w /s moodit-runner-node:latest sh -c   'apt-get update -qq && apt-get install -y -qq sqlite3 >/dev/null && node sql-isolation-e2e.js'
```
Attendu : les 4 cas affichent `OK` (dont 2 tentatives de triche qui échouent).

## 2. `sql-deployed-e2e.js` — valide le BINAIRE DÉPLOYÉ

Frappe le vrai endpoint interne `POST /internal/exec/evaluate` de l'execution-service **déployé**
(donc le code Java réel, `runSqlIsolated` + 2 appels Piston). Couvre les deux modes (lecture seule
`solution#` et modification isolée).

```sh
# <EXEC> = nom du conteneur execution-service ; <TOKEN> = valeur de INTERNAL_TOKEN
docker cp sql-deployed-e2e.js <EXEC>:/tmp/e2e.js
docker exec -e MOODIT_TOKEN="<TOKEN>" <EXEC> node /tmp/e2e.js
# (si l'image n'a pas Node, lancer via un conteneur node partageant sa pile réseau :)
#   docker run --rm --network container:<EXEC> -e MOODIT_TOKEN="<TOKEN>" -v "$PWD:/w" \
#     node:20-alpine node /w/sql-deployed-e2e.js
```
Attendu : les 6 cas affichent `OK` (bonne réponse = réussie ; variantes fautives = échouées).

> Ces scripts n'ont AUCUN effet de bord (exécutions sandbox jetables). Ils sont sûrs en prod.
