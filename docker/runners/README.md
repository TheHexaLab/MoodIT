# Runner de notation des langages compilés (#116)

TOUTE exécution de code étudiant passe par un **conteneur jetable** `moodit-runner-*` lancé par
`execution-service` (Piston a été retiré). Deux modes du superviseur : « evaluate » (notation des
compilés **Go, Rust, C, C++, C#, Java**, décrite ci-dessous) et « exec » (exécution générique :
programmes RPC à nonce des interprétés/SQL/vues, et bouton « Exécuter » de tous les langages —
tout y tourne sous l'UID étudiant, sorties à la Piston). Le harnais du prof y est un
**vrai test du langage** — classe JUnit 5 (Java), classe NUnit (C#), fichier `_test.go` (Go), module
un CORPS qui renvoie un booléen, compilé dans un programme séparé sous un UID séparé — et la POO
test (`new Rectangle(3, 4).aire()`), sans génération de code.

## Architecture

```
execution-service (DockerEvaluator)
  └─ docker run moodit-runner-<lang>     réseau none, mémoire/PID/CPU bornés, no-new-privileges,
       │                                 TOUTES les capacités retirées sauf le minimum root
       └─ supervisor.py (root)           ← processus de CONFIANCE
            pour chaque cas (ordre mélangé, 2 canaris insérés) :
              1. compile (root)          le HARNAIS + le nonce dans un programme (le noteur),
                                         le CODE SOUMIS seul dans un autre (le serveur)
              2. verrouille les sources  chown root, chmod 700 → EACCES pour l'étudiant
              3. lance le COUPLE         noteur sous l'UID 1301, serveur sous l'UID 1300,
                                         tubes croisés, le noteur mène
              4. verdict FAIL-CLOSED     le nonce du cas sur le stderr DU NOTEUR, rien d'autre
            → un JSON unique sur stdout (verdicts + événements d'infrastructure)
```

Les fichiers du job sont copiés dans le conteneur **créé mais non démarré** (API `copyArchive`,
compatible docker-outside-of-docker : aucun montage hôte), en mode `0600` root ; la sentinelle
`.ready` est le dernier élément de l'archive.

## Modèle de confiance — ce qui est garanti, ce qui ne l'est pas

**Un seul modèle** : le harnais du prof est un corps qui renvoie un booléen, compilé dans un
programme séparé sous un UID séparé, et le verdict est le nonce que ce programme — et lui seul —
peut émettre. Le format « vraie classe de test du framework » (JUnit, NUnit, go test, cargo test)
a existé dans une version intermédiaire de #116 : il compilait le harnais AVEC le code de
l'étudiant, donc le processus qui détenait le secret était celui que l'étudiant contrôle, et cinq
canaux de forge y ont été démontrés. Il est retiré, et un harnais qui en porte le marqueur est
refusé avec un diagnostic plutôt que noté par un chemin contournable.

| Propriété | Mécanisme | Limite assumée |
|---|---|---|
| **Verdict NON FALSIFIABLE — les six langages compilés** (harnais booléen) | Le harnais du prof est un corps qui renvoie vrai/faux. Il est compilé dans un **programme séparé** (le noteur), lancé sous un **UID séparé**, avec le nonce ; le code soumis est compilé **seul** dans un autre programme (le serveur), sous l'UID étudiant. Tubes croisés, le noteur mène. Il appelle des **bouchons typés** générés à partir des signatures réellement présentes dans le code soumis (`javap` en Java, lecture de la source ailleurs), et il est le seul à détenir le nonce, qu'il émet sur **son** stderr — un flux que le processus étudiant ne tient pas. Chaque appel porte un **identifiant imprévisible** (tiré de `SecureRandom` / `crypto.randomBytes` / `random_bytes` / `/dev/urandom`) : le stdout du code noté EST le canal de réponse, et sans cet identifiant il pouvait répondre avant la question. La **POO est proxifiée par poignée** : l'objet vit chez l'étudiant (ses champs privés restent privés), le noteur n'en manipule qu'un numéro ; constructeur et — en Go et Rust, où le langage n'en a pas — littéral à champs nommés, par capture de champs | la garantie ne vient pas d'une détection mais de l'architecture : le processus de l'étudiant ne contient ni le harnais, ni le nonce, ni le verdict. Elle suppose en revanche que la signature appelée par le harnais soit **marshalable** (entiers, flottants, booléens, chaînes) : hors de ces types, le bouchon n'est pas généré et le harnais ne compile pas — message au prof, jamais un faux verdict. Le **hardcoding** reste possible (voir plus bas) : c'est la limite de tout système de tests fixes |
| **POO proxifiée — ce que le prof peut écrire** (harnais booléen) | L'objet vit CHEZ l'étudiant et le noteur n'en manipule qu'une poignée, donc les champs privés le restent. Deux idiomes : **constructeur** (`new Rectangle(3, 4)`, `Rectangle::new`, `NewRectangle` — y compris rendant `*T`), et **littéral à champs nommés** en Go et Rust, où le langage n'a pas de constructeur, par capture de champs | En capture de champs, l'objet est **reconstruit à chaque appel** à partir des champs du littéral : un état porté d'un appel au suivant ne survivrait pas. Une méthode à **récepteur mutable** (`*T` en Go, `&mut self` en Rust) écarte donc ce mode, et le type passe par la poignée d'un constructeur — faute de quoi la modification aurait été perdue en silence, c'est-à-dire un verdict faux sans diagnostic. Un type sans constructeur ET à méthode mutable n'est pas proxifié : le harnais qui l'appelle ne compile pas, et le prof le voit |
| **Contrat du canal de réponse** | Le stdout du code noté EST le canal de réponse, et les deux processus le partagent. Toute réponse est donc **auto-cadrée** : un saut de ligne AVANT, un APRÈS, dans les neuf répartiteurs (six compilés, trois interprétés). Sans cela, une dernière écriture non terminée par un saut de ligne (`print(…, end="")`, `print!`, `System.out.print`) se collait au début de la ligne de réponse, qui n'était plus reconnue : le couple s'attendait et une réponse JUSTE était notée « Interrompu ». En face, le lecteur ignore tout ce qui ne porte pas l'identifiant imprévisible de SON appel. Un test parcourt les neuf répartiteurs depuis une liste unique : ajouter un langage sans tenir l'invariant fait échouer la CI | le code noté ne doit pas FERMER sa sortie standard : c'est le canal sur lequel son propre processus répond. S'il le fait, le cas échoue avec « processus etudiant termine » — net et immédiat, jamais un faux verdict, mais un échec. Fermer la sortie dans un `main` ne coûte rien : sur ce chemin, le `main` soumis n'est jamais appelé |
| **Coût du chemin booléen** | Un cas compile DEUX programmes (le noteur et le code soumis), et TROIS en Java, où le code soumis est d'abord compilé seul pour que ses signatures soient lues sur ses classes. Le mur du conteneur et le miroir de core en tiennent compte (`DockerEvaluator.compilesPerCase`), sans quoi un cas lancé juste avant l'échéance du budget pouvait être tué au mur — tous les verdicts du job perdus, 502, tentative supprimée (#216) | une question Java à plusieurs cas dont les compilations sont réellement lentes atteint le plafond du mur (15 min) : elle est alors notée PARTIELLEMENT, les cas restants portant « Non évalué » (`budget_depasse`). C'est le comportement dégradé assumé, préféré à la perte de tous les verdicts. En pratique les compilations prennent quelques secondes, très loin de leur plafond de 90 s |
| **Types échangeables** | entiers, flottants, booléens et chaînes, générés d'après les signatures réellement présentes dans le code soumis. Les chaînes voyagent en **hexadécimal** et les flottants en `%.17g` : le fil est à champs séparés, donc un séparateur dans la valeur — ou un arrondi d'affichage — faisait noter FAUSSE une réponse juste | hors de ces types, le bouchon n'est pas généré : le harnais ne compile pas. C'est un message au prof, jamais un faux verdict. Une **surcharge** est résolue par nom et arité : deux fonctions notées de même nom et même nombre de paramètres sont ambiguës, à éviter dans un énoncé. **En Go uniquement**, un flottant NON FINI (`NaN`, `±Inf`) n'est pas transportable : le protocole y est du JSON, qui ne les représente pas, et le cas est refusé explicitement plutôt que de bloquer. Les cinq autres langages les transportent ; une question Go dont la réponse attendue est un non-fini doit donc être formulée autrement |
| **Harnais illisible par l'étudiant** | le harnais n'est PAS dans le processus de l'étudiant : il est compilé dans le noteur, sous un autre UID. Les sources sont en plus verrouillées `700` root après compilation (`EACCES`) | avec un harnais au format framework, les constantes compilées dans les artefacts (binaire de test, `.class`) restent extractibles par un étudiant déterminé. Avec un harnais booléen, il n'y a rien à extraire : le harnais n'entre dans aucun artefact que l'étudiant puisse ouvrir |
| **CVE des images elles-mêmes** | Les dix images sont scannées par Trivy (`security.yml`, job `trivy-runners`), résultats CRITICAL remontés dans Code scanning. Bases épinglées par digest, téléchargements vérifiés par SHA-256 | **NON bloquant pour ces images**, contrairement aux sept images de service : au crible CRITICAL corrigeables, sept d'entre elles sont à zéro, mais `go` en compte une quarantaine, `c` (gcc) 205 et `rust` 208 — toutes venant des images officielles de chaînes de compilation, qu'une PR ne peut pas corriger. Bloquer dessus arrêterait le dépôt sur de l'amont ; réduire ces chiffres (bases plus minces pour c/go/rust) se décide à froid. Le job ne tourne pas sur les PR : dix constructions d'images par proposition pour un résultat informatif |
| **Pas de fuite réseau** | `--network none` | — |
| **Notation bornée dans le temps** | budget GLOBAL transmis au superviseur (mur du conteneur moins une marge, plafonné à **15 min**) : au-delà il CLÔT et renvoie les verdicts obtenus, les cas restants comptant « non exécuté » (`budget_depasse`) — le conteneur n'est plus tué au mur, ce qui perdait tout le travail et supprimait la tentative | une question à beaucoup de cas dont les compilations sont réellement lentes peut donc être notée partiellement ; le budget par cas (90 s de compilation) est très pessimiste par rapport au réel (quelques secondes) |
| **Pas d'épuisement de ressources** | mémoire/PID/CPU du conteneur + écritures étudiantes **confinées aux tmpfs bornés** `/box`, `/tmp` et `/dev/shm`, comptés dans la mémoire et **dérivés de `SANDBOX_MEMORY_MB`** (60 % / 6 % / 2 %, planchers 256 / 32 / 16 Mo — `DockerSandbox.boxSizeMb/tmpSizeMb/shmSizeMb` ; en dur, ils pouvaient dépasser la mémoire allouée au conteneur) (répertoires monde-inscriptibles des images verrouillés → le disque de l'hôte est hors d'atteinte du code étudiant) + rlimits (fichiers, nproc, nofile — posés sur les DEUX chemins, strace compris ; l'UID étudiant est **tiré au sort par conteneur**, sans quoi RLIMIT_NPROC — compté par UID réel sur l'hôte — aurait été un budget COMMUN : un étudiant qui fork en boucle faisait échouer la notation d'un autre) + temps limite par cas (prof, max 60 s) + budget mural du conteneur | — |
| **Isolation entre cas** | dossier par cas, groupe de processus tué au timeout, et **balayage des survivants UID étudiant après CHAQUE phase** — compilation, inventaire, notation — et pas seulement entre deux cas (un `fork` + `setsid` échappe au kill de groupe ; balayer tôt libère aussi les tubes de sortie, qu'un descendant survivant tenait ouverts, ce qui coûtait sinon dix secondes d'attente par phase) | pendant UN cas, les processus étudiants du même cas partagent l'UID (ptrace entre eux possible selon le `ptrace_scope` de l'hôte) — sans portée inter-cas grâce au balayage |
| **Détection** | Il n'y en a plus, et c'est le propos : le harnais et le nonce n'entrent dans aucun processus ni fichier que le code soumis puisse atteindre, donc il n'y a rien à surveiller. Les événements restants portent sur l'INFRASTRUCTURE (`budget_depasse`, `espace_sature`, `erreur_superviseur`) et sur les canaris, qui vérifient que la chaîne tranche encore dans les deux sens | la capacité `SYS_PTRACE` n'est plus accordée au conteneur et `strace` a quitté les images : elles ne servaient qu'à détecter une lecture du harnais, nécessaire quand il vivait dans un fichier ouvrable. Le code soumis ne peut donc plus tracer aucun processus |

Le **hardcoding** (un étudiant qui code `if (x == 5) return 10;` pour les entrées visibles de
l'énoncé) n'est pas une falsification : c'est la limite de tout système de tests fixes — la parade
est pédagogique (varier les cas).

## Protocole

- `execution-service` construit l'arborescence (`HarnessProjects`) : `cases/<i>/src/…` par cas,
  `job.json` (`{language, timeout_ms, budget_ms,
  cases:[{index, name, harness_types, student_types} | {index, canary:"pass"|"fail"}]}`).
  - `budget_ms` : temps total que le superviseur s'accorde pour l'ensemble des cas. Il le teste
    AVANT de démarrer un cas ; au-delà, les cas restants sont rendus « non exécuté ».
  - `harness_types` : conteneurs de tests déclarés par le HARNAIS (classes Java/C#, modules
    Rust), en nom pleinement qualifié. Ils portent l'INVARIANT DE NOTATION : un cas n'est
    « réussi » que si au moins un test exécuté leur appartient. Liste vide = harnais non
    identifié : aucune exclusion n'est appliquée, donc tous ses tests tournent et l'invariant
    est satisfait par construction.
  - `student_types` : conteneurs déclarés par le CODE ÉTUDIANT, EXCLUS de l'exécution — son
    code est compilé dans la même unité que le harnais, donc ses propres tests unitaires
    étaient comptés dans son verdict. L'extraction est textuelle sur un texte qu'il contrôle :
    elle ne joue que sur l'ÉQUITÉ, jamais sur l'intégrité de la note, que garde l'invariant
    ci-dessus. En Rust, l'exclusion passe par une sélection `--exact` bâtie sur un inventaire
    `--list` préalable (un run étudiant de plus, borné à `LIST_TIMEOUT_S` = 5 s et budgété en
    miroir par `DockerEvaluator.LIST_BUDGET_MS` et `ExecutionClient.LIST_SLACK_MS`) ; un
    inventaire tronqué ou mal formé fait renoncer au filtre.
- Les harnais canaris contiennent `__MOODIT_A__`/`__MOODIT_B__`, substitués par le superviseur
  avec des valeurs aléatoires AU RUNTIME (introuvables dans l'archive).
- Réponse (stdout) : `{"v":1, "results":[{index, name, passed, detail, ms}], "events":[…],
  "canaries":"ok|incoherents|indetermines|aucun"}`. Le côté Java (`DockerEvaluator`) est
  fail-closed : cas absent, JSON illisible ou erreur = jamais « réussi ».

## Dispositions par langage

| Langage | Image | Disposition | Verdict |
|---|---|---|---|
| Java | `moodit-runner-java` (temurin 25) | code soumis + `harnais_rpc.java` marqué | nonce sur le stderr du NOTEUR |
| C# | `moodit-runner-csharp` (mono) | `solution.cs` + `harnais_rpc.cs` marqué | nonce sur le stderr du NOTEUR |
| Go | `moodit-runner-go` | `main.go` + `harnais_rpc.go` marqué | nonce sur le stderr du NOTEUR |
| Rust | `moodit-runner-rust` | `solution.rs` + `harnais_rpc.rs` marqué | nonce sur le stderr du NOTEUR |
| C / C++ | `moodit-runner-c` (gcc 14, partagée) | `solution.c|cpp` + `harnais_rpc.c|cpp` marqué | nonce sur le stderr du NOTEUR |

Une seule disposition : le code soumis dans son fichier, le harnais du prof dans un autre, précédé
du marqueur `__MOODIT_HARNAIS__`. Le superviseur compile le second dans le **noteur** et le premier
dans le **serveur** — deux programmes, deux UID — et le noteur appelle des bouchons typés générés
d'après les signatures réellement présentes dans le code soumis.

## Construire / tester

```bash
./docker/runners/build.sh          # construit les 10 images (tag MOODIT_RUNNER_TAG, défaut latest)
```

- Filets d'intégration : `RpcGradingIntegrationTest` (notation non falsifiable — bonne et mauvaise
  réponse par langage, objets par poignée, forge refusée, harnais inatteignable) et
  `RunnerSandboxIntegrationTest` (**isolation du conteneur** : réseau coupé, `/tmp` non
  exécutable, boucle infinie, budgets, poids). En CI (`SANDBOX_REQUIRED=true`), une précondition
  manquante FAIT ÉCHOUER le job.
- Dev local : démon Docker requis (Windows : named pipe, détecté automatiquement par
  `DockerSandbox`). Sans démon ni images, les tests s'ignorent et l'évaluation compilée répond 502
  — côté core, la tentative en attente est alors SUPPRIMÉE (`quiz:attempt-failed`) et l'étudiant
  doit resoumettre : il n'existe pas de rejouage automatique.

Images du mode « exec » : `python` (numpy/pandas/scipy/sympy), `node` (+ tsc — JS, TS et les
harnais JS de JSON/HTML/JSX/TSX, bundles vendor fournis avec le job), `php`, `bash`, `sqlite`.
Les compilés réutilisent leurs images de notation pour le bouton « Exécuter ».
