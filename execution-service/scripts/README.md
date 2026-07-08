# Tests d'intégration manuels — exécution SQL

Les tests unitaires (`./gradlew test`) **mockent** Piston. Ces deux scripts valident la chaîne
**réelle** (vrais appels Piston), qu'un CI sans Piston ne peut pas couvrir. À lancer manuellement
avant un déploiement qui touche à l'assemblage/exécution SQL, ou après un changement d'image Piston.

Prérequis : Node ≥ 12, l'accès réseau au conteneur Piston / à l'execution-service (les ports ne sont
pas exposés en prod → on partage la pile réseau d'un conteneur, cf. commandes ci-dessous).

## 1. `sql-isolation-e2e.js` — valide le DESIGN contre Piston réel

Rejoue la logique 2 phases (setup → code étudiant → `.dump` → filtre → verdict) directement contre
Piston, sans passer par l'execution-service. Utile pour vérifier que le paquet `sqlite3` honore
`.dump`/les dot-commands (dépendance implicite), et que l'isolation tient (triche, DDL).

```sh
# <PISTON> = nom du conteneur Piston (ex. moodit_piston)
docker cp sql-isolation-e2e.js <PISTON>:/tmp/e2e.js
docker exec <PISTON> node /tmp/e2e.js
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
