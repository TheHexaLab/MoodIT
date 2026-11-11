# Runner de notation des langages compilés (#116)

TOUTE exécution de code étudiant passe par un **conteneur jetable** `moodit-runner-*` lancé par
`execution-service` (Piston a été retiré). Deux modes du superviseur : « evaluate » (notation des
compilés **Go, Rust, C, C++, C#, Java**, décrite ci-dessous) et « exec » (exécution générique :
programmes RPC à nonce des interprétés/SQL/vues, et bouton « Exécuter » de tous les langages —
tout y tourne sous l'UID étudiant, sorties à la Piston). Le harnais du prof y est un
**vrai test du langage** — classe JUnit 5 (Java), classe NUnit (C#), fichier `_test.go` (Go), module
`#[cfg(test)]` (Rust), `MOODIT_TEST` de `moodit_check.h` (C/C++) — et la POO est du simple code de
test (`new Rectangle(3, 4).aire()`), sans génération de code.

## Architecture

```
execution-service (DockerEvaluator)
  └─ docker run moodit-runner-<lang>     réseau none, mémoire/PID/CPU bornés, no-new-privileges,
       │                                 + SYS_PTRACE (trace du processus étudiant)
       └─ supervisor.py (root)           ← processus de CONFIANCE
            pour chaque cas (ordre mélangé, 2 canaris insérés) :
              1. compile (root)          code étudiant + harnais, disposition native du framework
              2. verrouille les sources  chown root, chmod 700 → EACCES pour l'étudiant
              3. exécute le binaire de   UID `student` (1300), sans toolchain, rlimits,
                 test                    sous strace (openat/readlink) quand disponible
              4. verdict FAIL-CLOSED     exit code ET marqueurs du framework ET rapport cohérent
            → un JSON unique sur stdout (verdicts + événements de détection)
```

Les fichiers du job sont copiés dans le conteneur **créé mais non démarré** (API `copyArchive`,
compatible docker-outside-of-docker : aucun montage hôte), en mode `0600` root ; la sentinelle
`.ready` est le dernier élément de l'archive.

## Modèle de confiance — ce qui est garanti, ce qui ne l'est pas

La forme du harnais décide du modèle. **Harnais booléen** (la forme des gabarits) → notation à deux
processus et deux UID, verdict non falsifiable dans les six langages. **Harnais au format framework**
(héritage, toujours accepté) → ancien modèle in-process, avec les limites détaillées plus bas.

| Propriété | Mécanisme | Limite assumée |
|---|---|---|
| **Verdict NON FALSIFIABLE — les six langages compilés** (harnais booléen) | Le harnais du prof est un corps qui renvoie vrai/faux. Il est compilé dans un **programme séparé** (le noteur), lancé sous un **UID séparé**, avec le nonce ; le code soumis est compilé **seul** dans un autre programme (le serveur), sous l'UID étudiant. Tubes croisés, le noteur mène. Il appelle des **bouchons typés** générés à partir des signatures réellement présentes dans le code soumis (`javap` en Java, lecture de la source ailleurs), et il est le seul à détenir le nonce, qu'il émet sur **son** stderr — un flux que le processus étudiant ne tient pas. Chaque appel porte un **identifiant imprévisible** (tiré de `SecureRandom` / `crypto.randomBytes` / `random_bytes` / `/dev/urandom`) : le stdout du code noté EST le canal de réponse, et sans cet identifiant il pouvait répondre avant la question. La **POO est proxifiée par poignée** : l'objet vit chez l'étudiant (ses champs privés restent privés), le noteur n'en manipule qu'un numéro ; constructeur et — en Go et Rust, où le langage n'en a pas — littéral à champs nommés, par capture de champs | la garantie ne vient pas d'une détection mais de l'architecture : le processus de l'étudiant ne contient ni le harnais, ni le nonce, ni le verdict. Elle suppose en revanche que la signature appelée par le harnais soit **marshalable** (entiers, flottants, booléens, chaînes) : hors de ces types, le bouchon n'est pas généré et le harnais ne compile pas — message au prof, jamais un faux verdict. Le **hardcoding** reste possible (voir plus bas) : c'est la limite de tout système de tests fixes |
| **Verdict infalsifiable — JAVA et GO seulement**, et SEULEMENT pour un harnais au format framework (héritage ; C, C++, C# et Rust : voir la colonne de droite, leur verdict est contournable par un adversaire in-process. Pour un examen noté, utiliser un harnais booléen, ligne ci-dessus) | fail-closed multi-canaux + **canaris** (un cas qui doit réussir, un qui doit échouer, valeurs tirées au sort, position mélangée — attrapent un forgeage depuis un init/constructeur, exécuté partout) + **jeton de fin d'exécution** (aléatoire par cas, imprimé par le point de sortie du framework APRÈS tous les tests — attrape un forgeage depuis la fonction notée : son `exit(0)` saute le jeton, `jeton_absent`). **Java et C# : le jeton n'est PAS substitué dans les sources** — substitué, il devenait une constante en clair de `classes/*.class` / `tests.exe`, artefacts que le superviseur ouvre nécessairement à l'UID étudiant pour que la JVM et mono puissent les charger ; le code noté le lisait en trois lignes, publiait lui-même la ligne de verdict et sortait en 0 (note pleine sur un code faux, **sans aucune lecture traçable** : c'est le chargement de classes normal). Il arrive donc par un **TUBE sur stdin** (non repositionnable, fermé par root après écriture), lu à la PREMIÈRE instruction de l'enveloppe, avant tout chargement de classe étudiante, et le verdict est publié sur le **DESCRIPTEUR BRUT (fd 1)** capturé au même moment. **C/C++ : le sommaire lui-même porte le jeton** (`summary jeton=… total=… failed=…`), et il doit être UNIQUE — sans cela, le code noté imprimait un faux sommaire AVANT la fin (le superviseur retenait le premier), posait un `atexit()` qui sort en 0, et laissait le framework finir : vrai sommaire et vrai jeton étaient bien émis, et le cas passait au vert + **le VERDICT voyage sur la ligne du jeton** pour les langages à enveloppe (Java, C#, Go : `jeton=… code=<code du framework>`). C'est la seule voie de confiance : le rapport du framework vit sous `work/`, possédé par l'étudiant, et le code de sortie du PROCESSUS s'écrase après l'impression du jeton (hook d'arrêt, thread de premier plan). Les deux étaient donc forgeables ensemble sans extraire le jeton. Une ligne DÉJÀ CONSOMMÉE PAR ROOT, elle, est hors d'atteinte : stdout et stderr du processus noté sont des TUBES que le superviseur recopie dans les fichiers qu'il relira (`run_proc`). Le fichier lui-même ne lui est jamais confié — passé directement en stdout, il donnait un descripteur inscriptible et POSITIONNABLE (ouvert sans `O_APPEND`) : `lseek`+`write`, `pwrite64` ou `ftruncate` réécrivaient après coup des octets déjà émis, ligne du jeton et sommaires compris, sans jamais lire le fichier ni connaître le jeton. Les droits `0600` root n'y changeaient rien, n'étant vérifiés qu'au `open(2)` | obtenir le jeton exige de lire la source verrouillée (EACCES + `lecture_source_tentee`), son propre binaire (`lecture_binaire_tentee` sur les natifs) ou les caches de build — eux aussi verrouillés 700 root (gocache, dépôt/target cargo, HOME de compilation) → bruyant ou refusé ; le nom des tests canaris est randomisé au runtime, LONGUEUR et alphabet variables (une forme fixe se reconnaissait à l'exécution) — **mais sur les langages où l'interposition est possible, cela ne ferme pas le canal** : un forgeur peut discriminer les canaris autrement, par exemple au nombre de tests du cas (toujours un seul), relayer honnêtement leur sortie et ne forger que les cas réels ; en Rust, où le jeton est un test trié en dernier, un FIL DE DÉTENTE invalide tout sommaire « 0 failed » contredit par une ligne « test … ... FAILED » (imprimée par libtest AVANT qu'un test étudiant tardif ne puisse forger — insupprimable) ; **résiduel assumé** : un étudiant déterminé qui partage le processus du framework peut encore extraire le jeton SANS lecture tracée — `include_str!` (Rust, harnais dans le même fichier), interposition de symboles ou scan de sa propre mémoire (C/C++, même unité de compilation). **Java/C# ne sont plus dans cette liste par la lecture d'artefact** (le jeton n'y figure plus : tube sur stdin, lu avant tout code étudiant, puis gardé dans une variable locale de l'enveloppe) ; il resterait à inspecter la MÉMOIRE de la pile de l'enveloppe, sans API supportée pour le faire en Java (JNI/FFM et `sun.misc.Unsafe` refusés, aucun agent JVMTI, `/proc/self/*` fermé par la transition setuid de `strace -u`). **En C#, en revanche, le jeton reste atteignable** : il a fallu lire l'entrée standard en BRUT puis effacer le tampon, parce que le lecteur d'entrée mis en cache par le runtime conservait le jeton dans ses tampons internes, que mono laisse inspecter par réflexion — sans aucun `open(2)`, donc sans trace. Le tampon effacé ferme ce chemin précis ; la réflexion et la redirection de descripteurs restent ouvertes. C# est donc un langage à résiduel in-process assumé, pas un langage à verdict infalsifiable. **En C/C++ le coût est faible** : le code étudiant étant inclus AVANT `moodit_check.h`, un `#define printf …` capture toutes les sorties du mini-framework — jeton compris — en une quinzaine de lignes, sans lecture tracée ; séparer les unités de compilation fermerait ce canal mais ferait perdre l'accès aux `static` du code étudiant (compromis assumé) ; C, C++ **et Rust** n'ont pas d'enveloppe qui tienne le code du framework (en Rust le jeton est imprimé par un test, qui n'a pas accès au code de sortie global) : leur verdict reste sur `exit_code` + sommaire, avec le fil de détente décrit ci-dessus pour garde-fou. Pour les trois langages à ENVELOPPE (Java, C#, Go), forger le verdict ne supposait PAS seulement de forger la ligne du jeton : il suffisait de la **réécrire au passage**. `System.out` / `Console.Out` / `os.Stdout` sont des variables, réassignables depuis le code noté (`init()`, initialiseur statique, fonction notée) : le filtre voyait passer la ligne authentique — jeton compris — et y remplaçait `code=1` par `code=0`, sans jamais connaître le jeton (démontré en Java, avec réécriture du rapport XML depuis un hook d'arrêt). **Fermé en Java** : l'enveloppe capture les descripteurs BRUTS (fd 1 **et** fd 2) avant tout code étudiant, hors d'atteinte de `System.setOut` ; les détourner demanderait un `dup2`, donc JNI/FFM (`--illegal-native-access=deny`) ou `sun.misc.Unsafe` (`--sun-misc-unsafe-memory-access=deny`) — les deux sont refusés. **PAS fermé en C#** : mono n'a aucun équivalent de ces drapeaux et laisse le code noté appeler du code natif, donc rediriger les descripteurs sur lesquels l'enveloppe publie. Publier sur les flux bruts ne lui coûte qu'un détournement de plus : **C# rejoint donc C/C++ dans les résiduels in-process ci-dessous**, et la propriété « verdict infalsifiable » ne vaut pas pour lui. Le seul correctif de fond serait un profil **seccomp** dédié au runner C# (à évaluer : mono a probablement des usages légitimes des appels concernés) — **suivi ouvert, mécanisme détaillé hors de ce dépôt public**. **Go tient par construction, pas par choix** : `os.Stdout` est un `*os.File` CONCRET (pas une interface), donc aucun filtre SYNCHRONE n'est possible — il faut un tube relu par une goroutine, et le `os.Exit(code)` que TestMain exécute juste après son `Printf` tue le processus avant qu'elle ait pu réémettre : la ligne meurt dans le tampon et le cas est refusé pour sortie vide (deux variantes de l'attaque sont figées en test d'intégration). Si l'enveloppe Go cessait un jour de sortir immédiatement après son impression, la course deviendrait gagnable. Enfin, comme l'enveloppe n'imprime qu'UNE ligne de jeton, deux lignes valent refus (`jeton_duplique`), sans qu'on ait à choisir entre elles |
| **POO proxifiée — ce que le prof peut écrire** (harnais booléen) | L'objet vit CHEZ l'étudiant et le noteur n'en manipule qu'une poignée, donc les champs privés le restent. Deux idiomes : **constructeur** (`new Rectangle(3, 4)`, `Rectangle::new`, `NewRectangle` — y compris rendant `*T`), et **littéral à champs nommés** en Go et Rust, où le langage n'a pas de constructeur, par capture de champs | En capture de champs, l'objet est **reconstruit à chaque appel** à partir des champs du littéral : un état porté d'un appel au suivant ne survivrait pas. Une méthode à **récepteur mutable** (`*T` en Go) écarte donc ce mode, et le type passe par la poignée d'un constructeur — faute de quoi la modification aurait été perdue en silence, c'est-à-dire un verdict faux sans diagnostic. Un type sans constructeur ET à méthode mutable n'est pas proxifié : le harnais qui l'appelle ne compile pas, et le prof le voit |
| **Types échangeables** | entiers, flottants, booléens et chaînes, générés d'après les signatures réellement présentes dans le code soumis. Les chaînes voyagent en **hexadécimal** et les flottants en `%.17g` : le fil est à champs séparés, donc un séparateur dans la valeur — ou un arrondi d'affichage — faisait noter FAUSSE une réponse juste | hors de ces types, le bouchon n'est pas généré : le harnais ne compile pas. C'est un message au prof, jamais un faux verdict. Une **surcharge** est résolue par nom et arité : deux fonctions notées de même nom et même nombre de paramètres sont ambiguës, à éviter dans un énoncé |
| **Harnais illisible par l'étudiant** | sources `700` root après compilation, processus étudiant sous UID dédié → `EACCES` ; tentative **tracée** (`lecture_source_tentee`) | avec un harnais au format framework, les constantes compilées dans les artefacts (binaire de test, `.class`) restent extractibles par un étudiant déterminé. Avec un harnais booléen, il n'y a rien à extraire : le harnais n'entre dans aucun artefact que l'étudiant puisse ouvrir |
| **Pas de fuite réseau** | `--network none` | — |
| **Notation bornée dans le temps** | budget GLOBAL transmis au superviseur (mur du conteneur moins une marge, plafonné à **15 min**) : au-delà il CLÔT et renvoie les verdicts obtenus, les cas restants comptant « non exécuté » (`budget_depasse`) — le conteneur n'est plus tué au mur, ce qui perdait tout le travail et supprimait la tentative | une question à beaucoup de cas dont les compilations sont réellement lentes peut donc être notée partiellement ; le budget par cas (90 s de compilation) est très pessimiste par rapport au réel (quelques secondes) |
| **Pas d'épuisement de ressources** | mémoire/PID/CPU du conteneur + écritures étudiantes **confinées aux tmpfs bornés** `/box`, `/tmp` et `/dev/shm`, comptés dans la mémoire et **dérivés de `SANDBOX_MEMORY_MB`** (60 % / 6 % / 2 %, planchers 256 / 32 / 16 Mo — `DockerSandbox.boxSizeMb/tmpSizeMb/shmSizeMb` ; en dur, ils pouvaient dépasser la mémoire allouée au conteneur) (répertoires monde-inscriptibles des images verrouillés → le disque de l'hôte est hors d'atteinte du code étudiant) + rlimits (fichiers, nproc, nofile — posés sur les DEUX chemins, strace compris ; l'UID étudiant est **tiré au sort par conteneur**, sans quoi RLIMIT_NPROC — compté par UID réel sur l'hôte — aurait été un budget COMMUN : un étudiant qui fork en boucle faisait échouer la notation d'un autre) + temps limite par cas (prof, max 60 s) + budget mural du conteneur | — |
| **Isolation entre cas** | dossier par cas, groupe de processus tué au timeout, et **balayage des survivants UID étudiant après CHAQUE phase** — compilation, inventaire, notation — et pas seulement entre deux cas (un `fork` + `setsid` échappe au kill de groupe ; balayer tôt libère aussi les tubes de sortie, qu'un descendant survivant tenait ouverts, ce qui coûtait sinon dix secondes d'attente par phase) | pendant UN cas, les processus étudiants du même cas partagent l'UID (ptrace entre eux possible selon le `ptrace_scope` de l'hôte) — sans portée inter-cas grâce au balayage |
| **Détection** | événements remontés dans le détail des verdicts + logs serveur : `canari_incoherent` (fait échouer TOUTE la soumission), `lecture_source_tentee`, `lecture_binaire_tentee` et `jeton_duplique` (font échouer LE CAS — lire son binaire peut réussir, annoter ne suffisait pas), `jeton_absent`, `rapport_incoherent`, `sommaire_duplique` et `budget_depasse` (refus SANS accusation : ils se déclenchent sur des situations qu'un code honnête atteint, p. ex. un `fork()` dont l'enfant réimprime le sommaire), `espace_sature`, `harnais_non_execute`, `trace_indisponible` (pas de cas : panne d'infrastructure, journalisée en ERREUR par execution-service — cf. `deploy/DEPLOY.md`), `erreur_superviseur` | l'acheminement vers le journal d'audit (Gardien) est un suivi |

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

| Langage | Image | Disposition | Framework / verdict |
|---|---|---|---|
| Java | `moodit-runner-java` (temurin 25) | `<ClassePublique>.java` + `<Harnais>.java` | JUnit 5 console (`--include-classname=.*`), rapport XML |
| C# | `moodit-runner-csharp` (ubuntu + mono) | `solution.cs` + `harness.cs` + `moodit_runner.cs` généré (`mcs -main:MooditRunner`) | NUnitLite, rapport XML |
| Go | `moodit-runner-go` | `go.mod` + `main.go` + `solution_test.go` (même package → identifiants non exportés accessibles) | `go test -c` puis binaire seul |
| Rust | `moodit-runner-rust` | projet cargo, `lib.rs` = code étudiant + module de tests (`use super::*` → items privés accessibles) | `cargo test --no-run` puis binaire seul |
| C / C++ | `moodit-runner-c` (gcc 14, partagée) | `solution.c|cpp` + `harness.c|cpp` (prélude généré : inclut l'étudiant avec `main` renommé + `moodit_check.h`) | `moodit_check.h` : `MOODIT_TEST`/`MOODIT_CHECK`, sommaire machine |

Compiler **par cas** (sources du cas seulement) évite les collisions de noms entre cas et entre
harnais ; les binaires de test sont autonomes au run (aucune toolchain exécutée par l'étudiant,
donc toute ouverture de `src/` au run est suspecte).

## Construire / tester

```bash
./docker/runners/build.sh          # construit les 10 images (tag MOODIT_RUNNER_TAG, défaut latest)
```

- Filet d'intégration : `execution-service` → `DockerRunnerIntegrationTest` (notation, POO,
  compilation, timeout, **matrice anti-triche** : forge du sommaire, exit prématuré, lecture du
  harnais). En CI (`SANDBOX_REQUIRED=true`), une précondition manquante FAIT ÉCHOUER le job.
- Dev local : démon Docker requis (Windows : named pipe, détecté automatiquement par
  `DockerSandbox`). Sans démon ni images, les tests s'ignorent et l'évaluation compilée répond 502
  — côté core, la tentative en attente est alors SUPPRIMÉE (`quiz:attempt-failed`) et l'étudiant
  doit resoumettre : il n'existe pas de rejouage automatique.

Images du mode « exec » : `python` (numpy/pandas/scipy/sympy), `node` (+ tsc — JS, TS et les
harnais JS de JSON/HTML/JSX/TSX, bundles vendor fournis avec le job), `php`, `bash`, `sqlite`.
Les compilés réutilisent leurs images de notation pour le bouton « Exécuter ».
