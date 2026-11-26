# Runner d'exécution du code étudiant (#116)

TOUTE exécution de code étudiant passe par un **conteneur jetable** `moodit-runner-*` lancé par
`execution-service` (Piston a été retiré). Deux modes du superviseur : « evaluate » (notation des
compilés **Go, Rust, C, C++, C#, Java**, décrite ci-dessous) et « exec » (exécution générique :
programmes RPC à nonce des interprétés/SQL/vues, et bouton « Exécuter » de tous les langages —
tout y tourne sous l'UID étudiant, sorties à la Piston). Le harnais du prof y est un
**CORPS qui renvoie un booléen**, compilé dans un programme séparé sous un UID séparé (le
noteur) — c'est la SEULE forme notée, un harnais au format framework (JUnit, NUnit, `go test`,
`cargo test`) étant refusé avec un diagnostic — et la POO est du simple code de
test (`new Rectangle(3, 4).aire()`), sans génération de code côté prof.

## Architecture

```
execution-service (DockerEvaluator)
  └─ docker run moodit-runner-<lang>     réseau none, mémoire/PID/CPU bornés, no-new-privileges,
       │                                 TOUTES les capacités retirées sauf le minimum root,
       │                                 oom_score_adj -1000 (le PID 1 n'est jamais tué par l'OOM)
       └─ supervisor.py (root)           ← processus de CONFIANCE
            pour chaque cas (ordre mélangé, 2 canaris insérés) :
              1. compile                 le HARNAIS + le nonce dans un programme (le noteur,
                                         compilé par root), le CODE SOUMIS seul dans un autre
                                         (le serveur, compilé sous l'UID étudiant — sauf le
                                         serveur Java, compilé par root, cf. plus bas)
              2. verrouille les sources  chown root, chmod 700 → EACCES pour l'étudiant
              3. lance le COUPLE         serveur sous l'UID étudiant (tiré au sort par
                                         conteneur, 1300 dans l'image), noteur sous cet UID + 1,
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
| **POO proxifiée — ce que le prof peut écrire** (harnais booléen) | L'objet vit CHEZ l'étudiant et le noteur n'en manipule qu'une poignée, donc les champs privés le restent. Deux idiomes : **constructeur** (`new Rectangle(3, 4)`, `Rectangle::new`, `NewRectangle` — y compris rendant `*T`), et **littéral à champs nommés** en Go et Rust, où le langage n'a pas de constructeur, par capture de champs | En capture de champs, l'objet est **reconstruit à chaque appel** à partir des champs du littéral : un état porté d'un appel au suivant ne survivrait pas. En **Go**, c'est l'étudiant qui choisit son récepteur : une méthode à récepteur pointeur (`*T`) reste donc en capture de champs, et son bouchon **relit les champs** chez l'étudiant après l'appel pour les recopier dans l'objet du harnais — la modification n'est pas perdue. En **Rust**, une méthode `&mut self` écarte ce mode et le type passe par la poignée d'un constructeur (un harnais écrit pour `&self` ne compilerait de toute façon pas contre elle) ; un type sans constructeur ET à méthode `&mut self` n'est pas proxifié : le harnais qui l'appelle ne compile pas, et le prof le voit. Un type **sans champ** (`struct{}` en Go, `struct T;` ou `struct T {}` en Rust) se construit par son littéral, et une classe **C++ sans constructeur déclaré** (dérivée comprise) par son constructeur par défaut, comme en Java et en C#. En C++, une classe **abstraite** ou **template** n'est pas proxifiée (elle ne s'instancie pas telle quelle) ; ses classes dérivées concrètes le sont. Le serveur C++ construit par une aide vérifiée à la compilation (`__is_constructible`) : une classe intermédiaire restée abstraite sans le déclarer, ou dont le constructeur demandé n'est pas accessible, est refusée à l'appel au lieu de faire échouer la compilation du code soumis |
| **Contrat du canal de réponse** | Le stdout du code noté EST le canal de réponse, et les deux processus le partagent. Toute réponse est donc **auto-cadrée** : un saut de ligne AVANT, un APRÈS, dans les répartiteurs des six compilés comme dans ceux des interprétés (Python, JavaScript/TypeScript, PHP). Sans cela, une dernière écriture non terminée par un saut de ligne (`print(…, end="")`, `print!`, `System.out.print`) se collait au début de la ligne de réponse, qui n'était plus reconnue : le couple s'attendait et une réponse JUSTE était notée « Interrompu ». En face, le lecteur ignore tout ce qui ne porte pas l'identifiant imprévisible de SON appel. Un test parcourt les serveurs des six langages compilés (formes fonction et objet, neuf variantes) depuis une liste unique : ajouter un langage compilé sans tenir l'invariant fait échouer la CI. Les répartiteurs interprétés, générés côté Java par `CodeAssembler`, n'y figurent pas | le code noté ne doit pas FERMER sa sortie standard : c'est le canal sur lequel son propre processus répond. S'il le fait, le cas échoue avec « processus etudiant termine » — net et immédiat, jamais un faux verdict, mais un échec. Fermer la sortie dans un `main` ne coûte rien : sur ce chemin, le `main` soumis n'est jamais appelé |
| **Coût du chemin booléen** | Un cas compile DEUX programmes (le noteur et le code soumis), et TROIS en Java, où le code soumis est d'abord compilé seul pour que ses signatures soient lues sur ses classes. En C/C++, le superviseur lance aussi, par cas, les sondes des noms réservés (`gcc -fsyntax-only`, 20 s en tout, `C_PROBE_BUDGET_S`) et `nm` sur le binaire soumis (10 s, `NM_TIMEOUT_S`), et une fois par job le préprocesseur seul (10 s) ; une sonde expirée ou tuée (par un signal, ou son `cc1` tué sous `gcc`) interrompt le cas (à rejouer) au lieu de refuser un nom innocent. Le mur du conteneur et le miroir de core en tiennent compte (`DockerEvaluator.compilesPerCase`, `toolsPerCaseMs`, `toolsPerJobMs`), sans quoi un cas lancé juste avant l'échéance du budget pouvait être tué au mur — tous les verdicts du job perdus, 502, tentative supprimée (#216) | une question Java à plusieurs cas dont les compilations sont réellement lentes atteint le plafond du mur (15 min) : elle est alors notée PARTIELLEMENT, les cas restants portant « Non évalué » (`budget_depasse`). C'est le comportement dégradé assumé, préféré à la perte de tous les verdicts. En pratique les compilations prennent quelques secondes, très loin de leur plafond de 90 s |
| **Types échangeables** | entiers, flottants, booléens et chaînes, générés d'après les signatures réellement présentes dans le code soumis. Les chaînes voyagent en **hexadécimal** et les flottants en `%.17g` (sauf en Go, où le fil est du JSON : chaînes échappées, flottants à pleine précision) : le fil est à champs séparés, donc un séparateur dans la valeur — ou un arrondi d'affichage — faisait noter FAUSSE une réponse juste | hors de ces types, le bouchon n'est pas généré : le harnais ne compile pas. C'est un message au prof, jamais un faux verdict. **Types reconnus, par langage** (paramètres et retour) : C et C++ `int`, `long`, `double` (pas `bool`, `long long`, `char*` ni `std::string`) ; C# `int`, `long`, `double`, `bool`, `string` (et leurs noms longs `Int32`, `String`…) ; Java `int`, `long`, `double`, `boolean`, `String` ; Go `int`, `int64`, `float64`, `bool`, `string` ; Rust `i32`, `i64`, `f64`, `bool`, `String`. **Ce qui n'est pas proxifié**, dans tous les langages : une méthode `void` (le harnais n'a rien à comparer : exposer un accesseur) ; en C++, une fonction membre **statique** (`Calc::add(2, 3)`), et en Rust une fonction associée sans `self` qui ne renvoie pas le type (`Calc::add(2, 3)`) : les écrire en fonctions libres. Une méthode **HÉRITÉE** d'un autre type du code soumis l'est : classe mère en Java, en C# et en C++ (héritage public, classe `final`, base `virtual`, constructeurs repris par `using Base::Base;` ou par défaut implicite d'une dérivée, masquage par nom respecté), méthode `default` d'une interface en Java, méthode d'un trait implémenté (`impl Forme for Carre`, méthodes par défaut comprises) en Rust, méthode promue par composition (`type Carre struct { Rectangle }`) en Go. Le bouchon de `Carre` porte l'`aire()` qu'il ne redéfinit pas, et le serveur la trouve — l'étudiant qui hérite au lieu de redéfinir est noté comme celui qui redéfinit. En C#, un `struct` n'est pas proxifié (seules les classes le sont) ; en C++, un paramètre déclaré sans nom (`Rect(int, int);`, définition hors de la classe) l'est. Les bouchons ne reproduisent pas la **hiérarchie** elle-même : `Forme f = new Carre(2);` ne compile pas dans le harnais (le bouchon `Carre` n'étend pas `Forme`), il faut écrire `Carre f = new Carre(2);`. Ce cas donne « Le harnais ne compile pas » pour toute réponse, solution du prof comprise — le prof le voit dès « Tester », jamais un faux verdict, et `deploy/check-compiled-harnesses.py` le classe BLOQUANT. Le harnais **C et C++** dispose de `<math.h>` (`fabs`, `sqrt`…), `<stdbool.h>`, `<stdlib.h>`, `<string.h>` et `<stdio.h>` (et `<exception>` en C++) : le prof ne peut pas ajouter d'`#include`. Ces outils restent ceux de la bibliothèque : une fonction soumise que le **harnais emploie** et qui porte le **nom** d'une fonction ou d'une macro de ces en-têtes (`fabs`, `sqrt`, `isnan`, `abs`, `round`…) est **refusée** avec un message clair (sonde du compilateur sur les seuls noms que le harnais emploie, classes C++ comprises). Elle prendrait sinon leur place dans le harnais, et une `fabs` qui renvoie 0 ferait passer tout `fabs(f(x) - attendu) < 1e-9`. Une fonction d'aide du même nom que le harnais n'appelle pas n'entre pas dans le noteur : elle n'est ni sondée ni refusée. De même, un nom **réservé à l'implémentation** — en C, qui commence par `__` ou par `_` suivi d'une majuscule ; en C++, aussi tout nom qui contient `__` (`C_IMPL_RESERVED`, `CPP_IMPL_RESERVED`) — est refusé, avec un message qui le dit (« Identifiant réservé au compilateur »), pour une fonction ou une classe que le harnais emploie : les macros des en-têtes s'y développent, et le `#define` du noteur détournerait l'outil. Une fonction d'aide `aide__calc` que le harnais n'appelle pas reste libre. Une question C ou C++ ne demande donc pas d'écrire `abs` ou `round`, mais `valeur_absolue` ou `arrondi`. En Go, un identifiant prédéclaré (`max`, `min`, `len`…) est refusé de même s'il est déclaré par le code soumis et employé par le harnais ; ceux dont le serveur généré se sert (`string`, `int`, `len`, `nil`…) le sont pour toute déclaration de paquet. Un **paramètre à valeur par défaut** (C++, C#) donne au bouchon chacune de ses arités (`somme(int n, int acc = 0)` s'appelle `somme(4)` comme `somme(4, 1)`), la valeur par défaut s'appliquant chez l'étudiant ; une **référence constante** C++ (`const int&`) est lue comme le scalaire ; `int&` non constante (le bouchon passe par valeur : une modification attendue par le harnais serait perdue) et `int&&` ne sont pas proxifiées. Une valeur par défaut portée par le **prototype** vaut pour la définition. Une **surcharge** est résolue par signature complète, types des paramètres compris, en C, C++, Java et C# (`Rect()` et `Rect(int, int)`, `f(int)` et `f(double)` sont distinctes) ; Go et Rust n'ont pas de surcharge. En Java, les classes **anonymes et locales** du code soumis (`new Comparator<>() { … }`) ne sont pas proxifiées : le harnais ne peut pas les nommer. En C#, une question proxifie **une** classe : la classe que le harnais nomme reçoit les bouchons (méthodes statiques de tout le code soumis, constructeurs et méthodes d'instance de cette classe) ; un harnais qui mêle `Solution.F()` et `new Rect()` ne compile pas. **En Go uniquement**, un flottant NON FINI (`NaN`, `±Inf`) n'est pas transportable : le protocole y est du JSON, qui ne les représente pas, et le cas est refusé explicitement plutôt que de bloquer. Les cinq autres langages les transportent ; une question Go dont la réponse attendue est un non-fini doit donc être formulée autrement |
| **Noms choisis par l'étudiant** | Le code généré (serveur côté étudiant, runtime côté noteur) ne dépend d'aucun nom que le code soumis peut porter. **Rust** : serveur et runtime du noteur dans un module à part, le code soumis atteint par `crate::` seulement. **C et C++** : le serveur n'inclut **aucun en-tête** (les quelques fonctions de la libc sont liées sous un nom `moodit_` par étiquette d'assembleur), ses locales sont préfixées, les appels C++ sont qualifiés `::f`, les mots-clés qu'il emploie sont débarrassés d'une macro soumise du même nom (`#define int long long` : `#undef`, retours convertis vers le type annoncé), et une fonction, une méthode ou une surcharge écartée par le préprocesseur (`#ifdef DEBUG`, `#if 0`) n'est pas appelée : quand le code soumis porte une directive conditionnelle, ses signatures sont lues sur sa version aux directives traitées (`gcc -E -fdirectives-only`, mêmes options que la compilation, sous l'UID étudiant ; macros non développées). **C#** : serveur et runtime dans leur espace de noms, `using` à l'intérieur ; `global::System` dans les bouchons. **Java** : aucun import à nom simple dans le noteur ; dans le serveur, les types de `java.lang` sont nommés en entier (`java.lang.String`) ; une classe d'aide au nom d'un type de `java.lang` (`class Long`) que le harnais n'emploie pas ne reçoit pas de bouchon dans le noteur. **Go** : locales du serveur préfixées. **Python, JavaScript, TypeScript** : intégrées et objets globaux pris à la source avant le code soumis, symboles résolus hors des locales de la boucle. Vérifié par un balayage en compilation réelle : chaque identifiant du code généré et des bibliothèques qu'il importe, essayé comme fonction, fonction d'aide, variable, type, méthode et champ soumis | Restent **refusés, avec un message qui nomme le nom** : un nom que le *harnais* emploie et qui masque un outil du langage (intégrée Python, global JavaScript, commande Bash, identifiant prédéclaré Go, fonction ou macro des en-têtes C/C++ du noteur, classe de `java.lang`) — en Python, JavaScript, TypeScript et Bash, sauf s'il est déclaré par le **code de départ** de la question, qui désigne la fonction que l'énoncé impose (#22) ; en Go, toute déclaration de paquet au nom d'un identifiant prédéclaré dont le serveur se sert (`string`, `int`, `nil`, `true`, `len`…) ; en C et C++, une définition de `printf`, `fflush`, `fgets`, `strtol`, `strtod`, `malloc`, `calloc`, `realloc`, `free`, `stdin` ou `stdout`, que l'éditeur de liens substituerait à ceux du serveur — contrôle fait sur le **binaire** compilé (`nm`, sortie lue en entier), donc sur ce que le compilateur a produit et non sur l'écriture, fonction versionnée par `.symver` comprise (seule une *donnée* `stdin`/`stdout` versionnée à la main lui échappe, et si `nm` échoue il n'y a pas de refus : c'est un diagnostic, pas une barrière) ; une méthode `Pile::free`, un `using std::free;` ou une surcharge C++ (`free(Noeud *)`) n'en sont pas, alors qu'une réponse qui fournit son propre allocateur (`malloc`/`free` de même signature) est refusée. Non couverts, car le code soumis ne compilerait pas non plus seul ou le nom n'a aucun sens : un type soumis nommé comme un type primitif (`struct bool` en Rust), une classe C# nommée `System`, une classe Java nommée `java`, un nom préfixé `moodit` |
| **Exceptions du code soumis** | Une exception, un `panic` ou un arrêt du code soumis pendant un appel est relayé au noteur comme un **refus d'appel**, sans son type | le harnais ne peut pas tester **le type** d'une exception. En **Java**, le bouchon lève une `RuntimeException` générique : `catch (IllegalArgumentException e) { return true; }` ne l'attrape pas (`catch (RuntimeException e)` oui). En **Go**, le bouchon fait un `panic` que le harnais peut `recover`, sans en connaître la valeur d'origine. En **C#, Rust, C et C++**, le noteur s'arrête à l'appel refusé (« appel refuse par le code soumis ») avant que le harnais ne réagisse : le cas échoue. Une question « doit lever X » écrite du temps de Piston rend donc 0 à tous ; la reformuler avec une valeur de retour (code d'erreur, booléen, `Option`…). Le prof le voit en rejouant « Tester » avec sa solution. Une exception ou une panique du HARNAIS lui-même (le code du prof : `assert_eq!` Rust, `throw` C++…) est relayée `[MOODIT] harnais: <message>` dans les cinq langages qui en ont (Java, C#, Go, C++, Rust) — en C++ par un `try`/`catch` autour du harnais (`what()` d'une `std::exception`), en Rust par un crochet de panique —, sur une seule ligne (sauts de ligne remplacés), et c'est elle que le détail du cas montre, pas le stderr de l'étudiant. Ne sont PAS relayés : le C, qui n'a pas d'exception ; un harnais qui meurt par SIGNAL, dans tout langage (`abort()` ou pointeur nul en C/C++, dépassement de pile ou `process::abort()` en Rust…) — le noteur meurt sans message, et le cas échoue avec une cause NON CONCLUANTE (`grader_killed` : on ne peut pas le distinguer d'un noteur tué par l'OOM) ; une erreur FATALE de Go (pile épuisée, « all goroutines are asleep »…), qui n'est pas une panique, ne se `recover` pas et sort en 2 — échec ordinaire, concluant. Dans ces cas, le détail montre le stderr de l'étudiant (`rpc_verdict` ne trouve aucune ligne `[MOODIT]` du noteur) ; le prof le voit en rejouant « Tester » avec sa solution |
| **Harnais illisible par l'étudiant** | le harnais n'est PAS dans le processus de l'étudiant : il est compilé dans le noteur, sous un autre UID. Les sources sont en plus verrouillées `700` root après compilation (`EACCES`) | le nonce du verdict ne va dans AUCUNE source ni aucun artefact que le code soumis puisse ouvrir : il est passé au générateur du noteur, qui le compile dans son propre programme |
| **CVE des images elles-mêmes** | Les dix images sont scannées par Trivy (`security.yml`, job `trivy-runners`), résultats CRITICAL remontés dans Code scanning. Bases épinglées par digest, rafraîchies chaque semaine par Dependabot (digest et correctifs de la même version ; changer de version de langage reste manuel). **Exception : `c` (`gcc:14`), `go` (`golang:1.23`) et `rust` (`rust:1.82`)** sont sur des tags que l'amont ne reconstruit plus : Dependabot n'y proposera rien, et ce sont elles qui portent presque toutes les CVE. Leur seule mise à jour est une montée de version, à la main | **NON bloquant pour ces images**, contrairement aux sept images de service : au crible CRITICAL corrigeables, sept d'entre elles sont à zéro, mais `go` en compte une quarantaine, `c` (gcc) 205 et `rust` 208 — toutes venant des images officielles de chaînes de compilation, qu'une PR ne peut pas corriger. Bloquer dessus arrêterait le dépôt sur de l'amont ; réduire ces chiffres (bases plus minces pour c/go/rust) se décide à froid. Le job ne tourne pas sur les PR : dix constructions d'images par proposition pour un résultat informatif |
| **Pas de fuite réseau** | `--network none` | — |
| **Notation bornée dans le temps** | budget GLOBAL transmis au superviseur (mur du conteneur moins une marge, plafonné à **15 min**) : au-delà il CLÔT et renvoie les verdicts obtenus, les cas restants comptant « non exécuté » (`budget_depasse`) — le conteneur n'est plus tué au mur, ce qui perdait tout le travail et supprimait la tentative | une question à beaucoup de cas dont les compilations sont réellement lentes peut donc être notée partiellement ; le budget par cas (90 s de compilation) est très pessimiste par rapport au réel (quelques secondes) |
| **Pas d'épuisement de ressources** | mémoire/PID/CPU du conteneur + écritures étudiantes **confinées aux tmpfs bornés** `/box`, `/tmp` et `/dev/shm`, comptés dans la mémoire et **dérivés de `SANDBOX_MEMORY_MB`** (60 % / 6 % / 2 %, planchers 256 / 32 / 16 Mo — `DockerSandbox.boxSizeMb/tmpSizeMb/shmSizeMb` ; en dur, ils pouvaient dépasser la mémoire allouée au conteneur), bornés aussi en **nombre de fichiers** (`nr_inodes` : 32 768 / 4 096 / 1 024 — la taille ne borne que les octets, et des centaines de milliers de fichiers vides épuisaient la mémoire noyau du conteneur ; besoin réel mesuré : moins de 2 000 sur `/box` en Go, moins de 70 ailleurs) (répertoires monde-inscriptibles des images verrouillés → le disque de l'hôte est hors d'atteinte du code étudiant) + rlimits (fichiers, nproc, nofile sur le processus ÉTUDIANT ; fichiers et nofile sur le NOTEUR — `demote_student`/`demote_grader` ; l'UID étudiant est **tiré au sort par conteneur**, entre 2²⁴ et 2³¹ − 2 (`STUDENT_UID_RANGE`), sans quoi RLIMIT_NPROC — compté par UID réel sur l'hôte — aurait été un budget COMMUN : un étudiant qui fork en boucle faisait échouer la notation d'un autre ; tiré parmi 40 000 valeurs, deux conteneurs simultanés partageaient encore un UID environ 4 fois sur 10 000) + **ordre des victimes de l'OOM** (superviseur à -1000, code soumis à 1000 sans retour possible, noteur des compilés à 500 — section suivante) + **verrous d'enregistrement POSIX et AIO noyau refusés** au code soumis (filtre seccomp, section suivante) + temps limite par cas (prof, max 60 s) + budget mural du conteneur + **IPC System V fermée** : un segment de mémoire partagée (`shmget`) est compté dans la mémoire du conteneur mais vit hors des tmpfs et survit à son créateur — jamais détruit, il finissait par faire tuer le superviseur par l'OOM (conteneur mort sans verdict, tentative rejouable). `kernel.shm_rmid_forced=1` le détruit dès qu'il n'est plus attaché ; `kernel.msgmni=0` interdit les files de messages et `kernel.sem` (semmni à 0) les jeux de sémaphores, qui ont le même défaut — un jeu de 32 000 sémaphores pèse environ 2 Mio et survit lui aussi (`DockerSandbox.IPC_SYSCTLS`, vérifié par `RunnerSandboxIntegrationTest`) | un code soumis qui dépasse la mémoire est tué et son cas échoue ; il ne peut plus faire tomber le conteneur — ni par l'IPC System V, ni par de la mémoire noyau tenue hors de son RSS (mesures dans la section suivante). Les files de messages POSIX sont bornées par RLIMIT_MSGQUEUE (0,7 Mo mesurés). La compilation du code soumis (bombe, boucle d'évaluation constante, compilation lente) n'est faite qu'une fois par job, puis rejouée aux cas suivants |
| **Isolation entre cas** | dossier par cas, groupe de processus tué au timeout, et **balayage des survivants UID étudiant après CHAQUE phase** — compilation, inventaire, notation — et pas seulement entre deux cas (un `fork` + `setsid` échappe au kill de groupe ; balayer tôt libère aussi les tubes de sortie, qu'un descendant survivant tenait ouverts, ce qui coûtait sinon dix secondes d'attente par phase) | pendant UN cas, les processus étudiants du même cas partagent l'UID (ptrace entre eux possible selon le `ptrace_scope` de l'hôte) — sans portée inter-cas grâce au balayage |
| **Interprétés, SQL et vues — mode exec** (Python, JavaScript, TypeScript, PHP, Bash, SQL, JSON, HTML, JSX/TSX) | Noteur et code soumis dans **deux processus** (RPC, identifiant imprévisible par appel), nonce émis par le noteur seul. Le noteur **Python** est lancé en mode isolé (`python3 -I`) : son dossier, que le code soumis peut écrire, n'entre pas dans `sys.path`, donc un `import numpy` du harnais ne charge jamais un module déposé par le code soumis. Seuls les symboles soumis que le **harnais nomme** reçoivent un mandataire dans le noteur ; parmi eux, un nom qui **masque un outil du harnais** est refusé avec un message clair (une fonction d'aide `max` ou `test` que le harnais n'appelle pas n'est donc ni mandatée ni refusée — même règle pour les compilés : Java, Go, C et C++). Le refus épargne le nom que le **code de départ** de la question déclare (core l'envoie avec chaque correction) : c'est la fonction que l'énoncé impose, `def sum(l)` compris, et elle se note comme avant #116 ; un `abs` *ajouté* par l'étudiant pour détourner `abs(f(x) - 3) < 1e-9` reste refusé, de même qu'un nom imposé que la boucle RPC du noteur emploie elle-même (`print`, `Proxy`, `JSON`, `head`, `printf`…), dont le mandataire remplacerait l'outil dans la boucle. Noms refusés : fonction intégrée de Python (`bool`, `abs`, `len`…), global de JavaScript (`Number`, `parseInt`…) ou variable du module (`require`…), commande de bash ou du `PATH` (`test`, `expr`, `grep`… — vérifié par `type -t` dans l'image). Le verdict Python appelle la vraie `bool`, et un mandataire Bash rend le **statut** de l'appel réel. Les noteurs Node (JS, TS, JSX/TSX) ignorent `SIGUSR1` et `node` est lancé avec `--disable-sigusr1` : le code soumis, sous le même UID, ouvrait sinon l'**inspecteur** du noteur sur `127.0.0.1:9229` et y lisait le nonce ; le verdict exige aussi que le noteur sorte en 0. SQL : chaque instruction de la réponse est enfermée dans sa vue — coupée sur `;` **et** sur les lignes `go` et `/`, que `sqlite3` traite comme un `;` ; `sqlite3 -safe` (ni `.shell`, ni `.read`, ni `ATTACH`, ni `readfile`) ; programme livré **par stdin** depuis un fichier root `0600`, illisible même par la table virtuelle `fsdir`, que `-safe` laisse passer | **garantie plus faible que celle des compilés** : il n'y a pas de second UID en mode exec, noteur et code soumis tournent sous le **même UID**. Un code soumis déterminé peut donc, selon la politique `ptrace` de l'hôte et ce que `/proc` expose d'un voisin du même UID, tenter de lire la mémoire du noteur. Ces langages conviennent aux exercices et aux quiz formatifs ; pour une évaluation à fort enjeu, préférer un des six langages compilés, seuls à porter la propriété « verdict non falsifiable ». Les falsifications corrigées pendant la revue de #246 (`bool` en Python, ligne `go` en SQL, `test` en Bash) ne demandaient **ni ptrace ni lecture de mémoire** : un nouveau répartiteur doit refuser tout nom qui masque un outil du harnais |
| **Socket Docker de l'hôte** | `execution-service` monte `/var/run/docker.sock` pour lancer les conteneurs runner | accès **root-équivalent à l'hôte**. `execution-service` est routé depuis Internet (`/exec/**` via le gateway) et analyse le code soumis, les harnais et la sortie des conteneurs : un défaut d'exécution de code dans ce service vaudrait l'hôte entier (Postgres et Caddy compris), là où l'ancien Piston restait confiné à son conteneur. Durcissement prévu : un proxy de socket restreint (cf. `deploy/DEPLOY.md`) |
| **Détection** | Il n'y en a plus, et c'est le propos : le harnais et le nonce n'entrent dans aucun processus ni fichier que le code soumis puisse atteindre, donc il n'y a rien à surveiller. Les événements restants portent sur l'INFRASTRUCTURE (`budget_depasse`, `espace_sature`, `erreur_superviseur`), sur le fonctionnement normal de la compilation du code soumis, faite une fois par job puis rejouée aux cas suivants (`compilation_rejouee`, `echec_compilation_rejoue` : journalisés en DEBUG par `DockerEvaluator`), et sur les canaris (`canari_incoherent`), qui vérifient que la chaîne tranche encore dans les deux sens et détectent aussi un forgeage aveugle ou un gel sélectif : `incoherents` (un canari contredit de façon concluante, ou les deux gelés — expirés ou tués —, avec un cas réel vert) met les cas verts à zéro ; un canari non jugé (sauté avant ou après avoir tourné, compilation non concluante, interrompu) n'accuse jamais lui-même : le verdict est `indetermines`, sauf si l'autre canari est démenti de façon concluante (`incoherents` avec un cas réel vert) | la capacité `SYS_PTRACE` n'est plus accordée au conteneur et `strace` a quitté les images : elles ne servaient qu'à détecter une lecture du harnais, nécessaire quand il vivait dans un fichier ouvrable. Le code soumis ne peut donc plus tracer le noteur, ni aucun processus d'un autre UID (entre processus étudiants d'un même cas, voir la ligne précédente) |

Le **hardcoding** (un étudiant qui code `if (x == 5) return 10;` pour les entrées visibles de
l'énoncé) n'est pas une falsification : c'est la limite de tout système de tests fixes — la parade
est pédagogique (varier les cas).

## Conteneur mort sans verdict

Si le conteneur meurt sans imprimer son JSON une fois le code soumis pris en charge,
`DockerEvaluator` lève une `NoVerdictException` (avant, une panne de plateforme : voir la ligne
témoin plus bas) : 502, la tentative est supprimée et l'étudiant resoumet (sauf relance de l'enseignant, ou plafond d'échecs sans verdict atteint : gardée « à revoir »). Aucune note n'est falsifiée ; le défaut
était le rejeu, à volonté sur une question à tentative unique. Il est désormais plafonné (voir
« Mort sans verdict : journal et plafond » plus bas), et trois réglages ferment cette classe pour
ce que le code soumis peut provoquer.

- **Le superviseur n'est jamais la victime de l'OOM.** Le conteneur est lancé à `oom_score_adj`
  -1000 (`DockerSandbox.SUPERVISOR_OOM_SCORE_ADJ`), et le superviseur remonte EXPLICITEMENT chaque
  processus qu'il lance (`mark_oom_victim`, appliqué d'office par `run_proc` et `run_pair`) :
  1000 pour le code soumis et sa compilation, 500 pour le noteur des compilés et les processus
  root de `preexec_compile` — un noteur JVM pèse plus que de petits processus soumis, et à
  égalité c'est lui que l'OOM tuait. En mode exec, le noteur assemblé tourne sous l'UID étudiant :
  il partage avec le code soumis la valeur 1000 et le filtre seccomp étudiant. Un enfant oublié
  hériterait de -1000 et serait intuable : vérifié sur les dix images par un échantillonneur de
  `/proc` pendant 18 jobs réels, aucun processus exécuté n'y reste (seule la fenêtre de quelques
  microsecondes entre `fork` et `preexec_fn`, sans `exec`).
  Le conteneur reçoit `CAP_SYS_RESOURCE` pour cette seule raison : écrite par root qui la détient,
  la valeur relève aussi le plancher `oom_score_adj_min`, hérité par les descendants. Le code
  soumis ne peut plus la redescendre (EACCES dès 999) ; sans elle, il la ramenait à 0, celle du
  PID 1. Il n'a lui-même aucune capacité (`CapEff` 0 mesuré : setuid les efface,
  no-new-privileges l'empêche d'en regagner). La capacité ne lève aucune limite de cgroup ; seuls
  le superviseur et les processus root qu'il lance la détiennent : par `preexec_compile`,
  compilations du noteur, sonde des noms réservés C/C++, `javap`, et la compilation du serveur
  Java, qui a les classes du code soumis sur son classpath ; et, avec toutes les capacités du
  conteneur, le `rm -rf --one-file-system` de `remove_tree` (binaire de confiance, aucun lien
  suivi) qui vide les dossiers que le code soumis a pu remplir — des processus déjà root avec
  `DAC_OVERRIDE` et `SETUID`.
  Pourquoi -1000 et non -500 : une victime qui ne rend pas sa mémoire assez vite (tables de pages,
  que le moissonneur de l'OOM ne libère pas) laisse l'OOM passer à la suivante. À -500, le
  superviseur y passait encore (2 courses sur 6, sortie 137) ; à -1000, aucune sur 12 :
  l'allocation attend que la victime ait fini de mourir. Contrepartie : une mémoire jamais rendue
  bloquerait l'OOM au lieu de tuer le conteneur, jusqu'au mur. Les objets qui survivent à leur
  créateur sont bornés (tmpfs en taille et en inodes, IPC System V fermée) et tiennent sous la
  mémoire du conteneur : mesuré ci-dessous à 512, 1024 et 1536 Mo. **Docker rootful, sans
  `userns-remap`, requis** : un démon rootless refuserait un `oom_score_adj` négatif, et chaque
  notation répondrait 502 ; `userns-remap` ne mappe que 65 536 UID par conteneur, trop peu pour
  l'UID étudiant tiré au-delà de 2²⁴ (voir plus bas).
- **Verrous d'enregistrement et AIO noyau refusés au code soumis.** Un verrou `fcntl` est de la mémoire noyau
  que le cgroup NE COMPTE PAS (comptage retiré du noyau en 2021, revert 3754707bcc3e ; vérifié sur
  6.6) : 4 millions de verrous posés en 16 s ajoutaient 872 Mo à l'HÔTE et 0 au conteneur. Le VPS
  de prod (8 Go, ~1 Go de marge) tombait dans l'OOM global en un « Exécuter » de 60 s, et l'OOM
  global tue le plus lourd des processus à 1000 — souvent le code soumis d'un AUTRE étudiant, dont
  la note devient fausse. Aucune limite du noyau n'en borne le nombre : un filtre seccomp posé par
  le superviseur sur les processus de l'UID étudiant (exécution et compilation,
  `install_student_filter`) refuse `F_SETLK`, `F_SETLKW`, `F_OFD_SETLK`, `F_OFD_SETLKW` et, en 32
  bits, `F_SETLK64`/`F_SETLKW64`, avec ENOLCK. Il s'ajoute au profil de Docker et couvre x86_64,
  x32, i386 (`int 0x80`), aarch64 et arm — les trois premiers mesurés, aarch64 et arm vérifiés
  par simulation du programme BPF seulement (pas d'hôte ARM). S'il ne se pose pas, le processus
  meurt (127) plutôt que de tourner sans lui. `flock()` reste permis : un verrou par fichier
  ouvert, borné par RLIMIT_NOFILE × RLIMIT_NPROC, et c'est lui que `go build` utilise. **Coût
  pour le code soumis** (mesuré) : SQLite sur FICHIER répond « database is locked » (`:memory:`
  et `?nolock=1` fonctionnent ; le runtime SQL de la plateforme est en mémoire), et
  `FileChannel.lock()` lève `IOException: No locks available` en Java. Le même filtre refuse
  `io_setup` avec ENOSYS (la réponse d'un noyau sans AIO) : la limite de l'AIO noyau,
  `fs.aio-max-nr`, est **globale à l'hôte**, et 128 contextes de 512 événements, pris en une
  seconde par le code soumis, la vidaient pour tous les conteneurs. Aucun langage des images ne
  s'en sert.
- **Compilation du code soumis faite une fois par job.** Le programme étudiant ne dépend que du
  code soumis : il est identique d'un cas à l'autre, canaris compris (sauf en C#, où le serveur
  porte la classe que le harnais nomme : deux harnais qui nomment deux classes recompilent). Son
  résultat est mémorisé par empreinte de ses entrées (commande, environnement, octets des
  sources, chemin du cas neutralisé — `compile_student`) et rejoué aux cas suivants :
  - **réussite** : l'artefact (binaire, ou dossier de classes en Java) est copié par root hors
    du chantier de l'étudiant juste après la compilation — aucun de ses processus n'est vivant à
    ce moment — puis recopié dans le chantier de chaque cas suivant, sans suivre de lien. Au-delà
    de 64 Mo (`STUDENT_ARTIFACT_CAP`, taille apparente : la copie remplit les trous d'un fichier
    creux) ou de 256 fichiers (`STUDENT_ARTIFACT_MAX_FILES` : le cache garde ses inodes tout le
    job, sur un `/box` borné à 32 768), il n'est pas gardé et chaque cas recompile ; un échec qui
    suit une réussite déjà constatée (restauration impossible faute de place) ne la remplace pas ;
  - **échec du compilateur** : même code de sortie et mêmes messages, rejoués dès le cas suivant ;
  - **échec non concluant** (délai dépassé, compilateur tué par signal, ou son travailleur —
    `cc1`, `cc1plus`, `compile` — tué par l'OOM du conteneur sous un pilote `gcc`/`g++`/`go
    build` qui survit et sort en 1 : reconnu par la hausse du compteur `oom_kill` du cgroup
    pendant la compilation, le stderr étant celui du code soumis, qui pourrait en imprimer la
    signature) : il peut venir de l'hôte — machine chargée, cache de Go encore froid à la
    première compilation — et n'est rejoué qu'une fois constaté **deux** fois ; il garde alors
    sa cause non concluante (même traitement des canaris). Il reste un échec noté : jamais
    `interrompu`, puisque le code soumis peut le provoquer (bombe de compilation).
  Rien n'est mémorisé quand une sortie a été perdue (tmpfs saturé : la cause est l'espace).
- **UID étudiant tiré entre 2²⁴ et 2³¹ − 2.** Les limites par UID du noyau (RLIMIT_NPROC,
  RLIMIT_SIGPENDING, pages de tubes, instances inotify…) sont communes à l'hôte entier : deux
  conteneurs au même UID les partagent (mesuré : le second ne pouvait même plus lancer bash).
  Tiré parmi 40 000 valeurs, l'UID étudiant ou noteur de deux conteneurs simultanés coïncidait
  environ 4 fois sur 10 000 avec trois places ; parmi deux milliards, de l'ordre de 10⁻⁸. La plage
  commence au-dessus des sous-UID usuels.

### Vecteurs mesurés

Sondes C (notation réelle, 512 Mo) et Python/ctypes (mode exec), lancées avec les options exactes
de `DockerSandbox`, sous l'UID étudiant, avec ET sans tentative d'abaissement de
`oom_score_adj`. « Avant » : réglages précédents ; « après » : ceux décrits ci-dessus.

| Vecteur | Mesure | Statut |
|---|---|---|
| memfd jamais projeté | 328 Mo tenus, rendus à la mort ; abaissé, avant : sortie 137 sans JSON (C et Python) ; après : JSON, témoin vert | fermé (OOM) |
| tampons de sockets Unix, flux / datagrammes | 391 / 365 Mo tenus, rendus à la mort ; abaissé, avant : 137 (datagrammes en C et Python, flux en C) ; après : JSON | fermé (OOM) |
| VMA en masse | 361 Mo, rendus ; abaissé, avant : 137 ; après : JSON | fermé (OOM) |
| tables de pages (mmap creux) | 321 Mo, rendus ; superviseur tué même SANS abaissement (course du moissonneur, 1 course sur 3 avec S1 seul) ; après : 0 sur 12 | fermé (OOM, -1000) |
| epoll | 360 Mo, rendus ; reste sous 512 Mo seul, s'additionne aux autres | fermé (OOM) |
| tubes agrandis (`F_SETPIPE_SZ`) | 212 Mo, borné par `pipe-user-pages-soft` (par UID) | réglage existant + OOM |
| surveillances inotify | 167 à 180 Mo ; reste ~35 Mo de cache de dentries récupérable | réglage existant + OOM |
| fils jusqu'à RLIMIT_NPROC | +4 Mo | réglage existant |
| minuteries POSIX, signaux en attente | +21 Mo (RLIMIT_SIGPENDING) | réglage existant |
| verrous `fcntl` par plages | non comptés : 4 M verrous en 16 s = +872 Mo d'hôte, +0 conteneur | fermé (filtre seccomp) |
| flock, baux (`F_SETLEASE`), eventfd, timerfd, signalfd, au maximum des descripteurs (126 processus × 248) | 31 248 objets : +9 à +16 Mo d'hôte non comptés, +22 à +29 Mo au conteneur, rendus à la mort | réglage existant (RLIMIT_NOFILE × RLIMIT_NPROC) |
| AIO noyau (`io_setup`) | limite **globale** `fs.aio-max-nr` : 128 contextes de 512 la vidaient (EAGAIN ensuite, pour tout l'hôte) ; après : ENOSYS | fermé (filtre seccomp) |
| sockets AF_ALG (tampons d'émission non comptés), fanotify, perf_event_open | EPERM | réglage existant (profil seccomp de Docker) |
| liens physiques sur tmpfs | comptés par `nr_inodes` : 32 754 puis ENOSPC, +14 Mo | réglage existant |
| liens symboliques (cible de 4 000 o) | 32 755 puis ENOSPC, +167 Mo, dans la taille du tmpfs | réglage existant |
| attributs étendus `user.*` | 511 × 64 Kio puis ENOSPC (imputés sur l'espace d'inodes, 32 Mo pour `/box`), +64 Mo | réglage existant |
| trois tmpfs pleins (octets ET inodes), puis compilation Java des cas suivants | pic 379 / 690 / 1011 Mo à 512 / 1024 / 1536 Mo ; JSON, trois témoins verts, canaris `ok`, avant comme après | réglage existant (nettoyage entre cas) |
| `unshare(CLONE_NEWUSER)` puis tmpfs | EPERM (profil seccomp de Docker) | réglage existant |
| mode exec : le code soumis tue le noteur (`kill(ppid)`, `kill(-1)`, Python/JS/Bash) | échec noté « Interrompu (signal SIGKILL) », jamais un 502 | conception |
| exceptions du superviseur sur le code soumis | fuzz de la chaîne réelle de chaque langage (2 400 entrées de 100 Ko) : aucune exception ; Rust jusqu'à 12 s par cas (`code_depths` quadratique, 6 s pour 100 000 caractères) → linéaire, 0,07 s pour 200 000 | corrigé |
| expansions de l'extraction et des bouchons dans le superviseur (100 Ko de code soumis, avant toute compilation, hors délai) | quadratiques ou démultipliées : long mot sans `(` dans une classe C++ 115 s, 99 999 `#` en C# 3 s, chaîne d'héritage C++ de 2 000 classes 48 s et 4,9 Go (vides : 43 s), structure Go de 7 000 champs × 1 200 méthodes 54 s et 1,8 Go, Rust 45 s et 3,7 Go, 4 000 paramètres par défaut C++ : serveur de 609 Mo, méthode C++ de 4 000 paramètres héritée par 2 500 classes : serveur de 768 M caractères (3,6 Go), méthode par défaut de trait Rust de 4 000 paramètres sur 1 500 `impl` 70 s et 2 Go, type Go embarqué 19 000 fois 3,5 s ; après, mesuré sur ces formes et leurs voisines (balayage des six chaînes d'extraction) : au plus 0,3 s par cas dans le conteneur et 46 Mo, ou **refus avec message** (un échec noté, jamais un 502 ni un faux verdict ; décidé sur le seul code soumis, donc pour canaris et cas réels ensemble). Bornes, chacune refusée à part : **8 paramètres à valeur par défaut** par fonction, méthode ou constructeur (`MAX_DEFAULT_PARAMS`) ; **64 ancêtres** du code soumis par classe (`MAX_ANCESTORS`) ; trois compteurs à **10 000** chacun (`MAX_INHERITED_METHODS`) : méthodes héritées (C++, Java, C#, Go), constructeurs repris par `using Base::Base;` (C++), méthodes par défaut de traits reportées sur les `impl` (Rust) ; **5 000 copies de champs** en capture de champs Go/Rust (champs × (méthodes + constructeurs + 1), `MAX_FIELD_COPIES`) ; et, sur l'API FINALE de chaque runner (fonctions, constructeurs et méthodes, après héritage et arités réduites, toutes classes, sans regarder le harnais), **1 000 entrées** (`MAX_RELAYED_ENTRIES`) et **20 000 paramètres relayés** en tout (`MAX_RELAYED_PARAMS`, `check_relayed_params`) ; en Java, **256 classes** produites par la compilation du code soumis (`JAVA_MAX_CLASSES`), vérifiées avant `javap`. Ces trois dernières bornes rendent la compilation du noteur, `javap` et le javac du serveur RPC impossibles à pousser au délai par le code soumis : leur expiration est « interrompue », sans note (voir plus bas, `incomplet`), et n'est donc plus un essai gratuit. Pire cas mesuré sous ces bornes (1 CPU, 1 Go, configuration de production) : noteur Go jusqu'à ~32 s (Go à cache froid, /box rempli ; ~16 s à vide) et 238 Mo, Rust 2,5 s et 392 Mo, Java 2,9 s, C# 2,7 s, C++ 0,4 s pour 90 s ; `javap` 1,1 s et javac du serveur 2,1 s à 256 classes pour 5 s et 90 s ; avant : noteur Rust de 99 000 paramètres tué par l'OOM (1,09 Go), noteur Go à 13 600 copies de champs 495 Mo, 7 611 classes Java faisant expirer `javap` à chaque cas. Types embarqués Go et parents dédoublonnés ; segment C/C++ aux directives traitées borné aussi en caractères | corrigé (borné) |
| sortie qui casse le JSON (octets nuls, UTF-8 invalide, substituts, U+2028) | JSON rendu dans les deux modes (`read_capped` décode avec remplacement) | conception |
| 127 processus en boucle, zombies, bombe de fork | notes justes, canaris `ok`, ≤ 2 s par cas | réglage existant |
| bombes de compilation (3 cas + 2 canaris, 1024 Mo) | compilateur tué par l'OOM ; avant → après : templates C++ 75 → 21 s et préprocesseur C++ 14 → 5 s (mesures d'avant 95b1ac6d, quand le pilote de gcc, sorti en 1, faisait rejouer l'échec dès le 2e cas ; depuis, `cc1plus` tué par l'OOM est reconnu non concluant par `oom_kill` et l'échec n'est rejoué qu'une fois constaté deux fois, comme pour rustc : une compilation de plus, non remesurée), macro Rust 27 → 12 s et `static` géant Rust 5 → 3 s (rustc tué par signal : rejoué une fois constaté deux fois) ; `static char[1 Gio]` C : gcc élimine le tableau (binaire de 15 Ko), réussit, binaire rejoué, canaris `ok` | corrigé (compilation rejouée) |
| boucle d'évaluation constante Rust | 90 s de compilation **par cas** : 451 s de place pour 3 cas + 2 canaris → 183 s (délai dépassé : rejoué une fois constaté deux fois) | corrigé (compilation rejouée) |
| compilation lente qui RÉUSSIT juste avant le délai | refaite à chaque cas ; après : une fois par job, binaire recopié | corrigé (compilation rejouée) |
| code soumis à des milliers de fonctions (100 Ko) : bouchons du noteur recompilés à chaque cas (ils portent le nonce) | avant : 3 cas + 2 canaris : C 34 s, C++ 43 s, Go 60 s, Java 28 s, C# 8 s, tous notés ; Rust 2 730 fonctions : compilateur tué à 1 Go, échec noté ; après : au-delà de 1 000 fonctions, méthodes et constructeurs relayés, refus noté avant toute compilation (`MAX_RELAYED_ENTRIES`) | borné (≤ une solution lente honnête) |
| /box rempli par le code soumis, puis compilation du noteur (conteneur à 1 024 Mo, /box 614 Mo) | entre deux cas, le dossier du cas est supprimé et /tmp et /dev/shm vidés : seuls l'artefact gardé (≤ 64 Mo) et, en Go, le cache de compilation de l'étudiant (remplissable À L'EXÉCUTION) survivent. /box rempli à 566 Mo puis pire noteur sous les bornes : Go à cache froid 32 s et 238 Mo, Rust 383 Mo, aucun OOM (`oom_kill` 0) ; mais le noteur Go a écrit 48 Mo de cache et laissé 1 Mo libre, au bord d'un « no space left on device » présenté comme « Le harnais ne compile pas » → seuil de saturation de /box porté de 48 à 96 Mo (`BOX_MIN_FREE_BYTES`) : au-delà, cas suivants sautés, cause « espace », imputable | corrigé (marge mesurée) |
| cache Go du NOTEUR (`/box/gocache`, partagé par les cas) sur une question à beaucoup de cas | le paquet du noteur, recompilé à chaque cas (nonce différent), y ajoutait ses entrées : +7,5 à +13,6 Mo par cas sous les bornes (44 → 82 Mo et 51 → 119 Mo en 6 cas) — /box saturé bien avant 100 cas, cas suivants sautés pour « espace », imputés à l'étudiant ; après : une fois le cache chaud (bibliothèque standard compilée par une réussite), ce que chaque compilation du noteur ajoute est retiré (`drop_new_cache_files`) : 51 Mo et 44 Mo stables sur 6 cas, 3 à 5 s par compilation comme avant | corrigé |
| milliers d'entrées déposées par le code soumis dans /tmp ou /dev/shm (purge entre deux cas, hors délai) | un `rm` lancé par entrée de premier niveau : 5 118 dossiers vides (/tmp et /dev/shm pleins en inodes, 4 096 et 1 024), 16,2 s de purge par cas (moodit-runner-c, 1 CPU) ; après : fichiers et liens retirés directement, dossiers passés à `rm -rf` par lots (`remove_trees`, `rm_batches`) : 0,08 s | corrigé |
| fichiers de l'image inscriptibles | `/tmp` seulement, masqué par le tmpfs ; à l'exécution, `/box` (dossiers de l'étudiant), `/tmp` et `/dev/shm` | réglage existant |

### Mort sans verdict : journal et plafond (S3, S4)

- **S3 — journal.** Avant de supprimer le conteneur, `DockerSandbox` lit `State.OOMKilled`
  (`ContainerRun.oomKilled`). Docker le pose dès qu'UN processus du conteneur a été tué par l'OOM
  (mesuré : même quand le superviseur a rendu son JSON et que la sortie vaut 0) ; seule la
  combinaison sortie 137 + OOMKilled + aucun verdict désigne le superviseur
  (`ContainerRun.supervisorOomKilled`). Ce cas est journalisé en ERREUR à part : le superviseur
  est à -1000 et le code soumis ne peut plus l'atteindre, c'est donc l'isolation qui est en
  défaut. La réponse reste un 502 — jamais une note.
- **S4 — plafond.** Le 502 porte sa cause (`cause` du ProblemDetail) : `sans_verdict` quand le
  conteneur a tourné sans rendre de verdict une fois le code soumis pris en charge
  (`NoVerdictException`) — superviseur muet ou illisible APRÈS sa ligne témoin, notation
  compilée incomplète, mur réellement écoulé avec un conteneur encore en marche, sortie
  démesurée, et budget global d'une correction interprétée/SQL épuisé par l'attente d'une place
  alors que le travail seul tenait (un code qui s'arrête juste sous le temps limite à chaque
  harnais pouvait sinon laisser la file transformer chaque essai en suppression non comptée ; un
  étudiant honnête pris dans la même charge est compté lui aussi, sans jamais de fausse note) ;
  `indisponible` sinon : démon injoignable, flux d'attente coupé avant le mur,
  inspection du conteneur en échec au mur, image absente, service en arrêt (y compris un conteneur
  supprimé par l'arrêt pendant la notation), verdict des canaris absent d'un JSON valide (image
  d'une autre version que le service), superviseur mort AVANT sa ligne témoin. Cette ligne
  (`SUBMITTED_CODE_STAGE`, `moodit-supervisor: submitted-code-stage`) est écrite sur le stderr du
  superviseur juste avant qu'il prenne en charge le code soumis, après ses seules erreurs de
  plateforme (job non reçu, langage ou runtime inconnu) : sans elle, une image cassée envoyait
  toute une classe « à revoir » au troisième essai. Le code soumis ne peut pas l'effacer : ses
  sorties vont dans des tubes et des fichiers, jamais sur le stderr du PID 1. Au mur, le démon est
  interrogé avant de conclure : un conteneur déjà arrêté (démon qui n'a jamais notifié la fin) est
  lu normalement ; un état absent ou sans indicateur de marche compte comme « encore en marche »
  (rien ne prouve qu'il est arrêté). Les journaux du conteneur, qui portent le verdict, sont en
  json-file à options FIXÉES (`DockerSandbox.LOG_OPTS` : un seul fichier de 128 Mo, écriture
  bloquante) : le démon ne complète une configuration qu'avec ses log-opts pour les clés
  absentes. Un `max-size` bas réglé sur l'hôte ne gardait que les dernières lignes (mesuré : 11
  lignes relues sur 2000 à `max-size=1k`), perdant la ligne témoin et le début du JSON ; et en
  `mode: non-blocking`, Docker jette des messages quand son tampon est plein. Dans les deux cas,
  une sortie trouée comptée « sans verdict ». 128 Mo couvrent ce que le superviseur émet
  (quelques Mio au plus) même multiplié par 6 par l'échappement du pilote. Mesuré avec les
  options fixées, par `docker logs` sur les dix images : 2000 lignes sur 2000, et 20 Mio intacts
  (le service, lui, refuse au-delà de 16 Mio par flux : `NoVerdictException`). Deux fermetures côté core empêchent le code soumis de provoquer un échec non
  compté : un code de plus de 100 000 caractères (la borne d'execution-service) est refusé à la
  soumission (400, tentative non consommée) au lieu de recevoir un 400 à la correction ; et le
  résultat d'une tentative n'est lisible qu'une fois corrigée (`done`) — il porte le corrigé des
  questions sans code, que l'étudiant lisait pendant la correction pour resoumettre après un
  échec. Core compte les
  `sans_verdict` par étudiant et par quiz (table `Grading_Failure`, migration V6). Tant que le
  compte reste sous `QUIZ_MAX_NO_VERDICT_FAILURES` (3), la tentative est supprimée et l'étudiant
  resoumet, comme avant (sauf relance de l'enseignant, voir plus bas) ; dès que le compte atteint
  le plafond (3e échec sans verdict), elle est GARDÉE en statut `review` : elle consomme la tentative unique, sans
  note, et l'étudiant voit « transmise à votre enseignant ». L'enseignant la retrouve dans
  l'éditeur de quiz (pastille « N à revoir ») et relance sa correction
  (`POST /api/quizzes/{quizId}/attempts/{attemptId}/regrade`). Sur un quiz SANS reprise, une fois
  le plafond atteint, tout échec garde la tentative à revoir, panne de la sandbox comprise : seule
  une relance de l'enseignant peut encore la corriger, et une panne pendant celle-ci n'efface pas
  la tentative qu'il a sous les yeux. Sur un quiz AVEC reprise, une panne supprime la tentative
  comme d'habitude. Une tentative RELANCÉE par l'enseignant (colonne `regrade`, migration V7)
  revient à revoir quel que soit l'échec, le compte ou la reprise du quiz : une autre tentative
  corrigée entre-temps a pu remettre le compte à zéro. Une correction aboutie remet le compte à
  zéro.

### Restes ouverts

- **Pas de borne par utilisateur sur le chemin interne** (`QUIZ_CODE_GRADING_THREADS` fils de
  correction de code dans core, partagés : 3 par défaut, 2 en prod, = `EXEC_MAX_CONCURRENT` − 1). Au pire, une soumission tient une place le temps d'une compilation étudiante jusqu'à
  90 s (deux fois si elle expire ou est tuée), puis, par cas, de la compilation du noteur
  (bouchons au maximum des bornes : jusqu'à ~32 s par cas mesurés (Go à cache froid, /box
  rempli ; ~16 s à vide)), des outils
  du cas (en C/C++ sondes des noms réservés 20 s et `nm` 10 s ; en Java `javap` 5 s et `javac` du
  serveur RPC ; en C#, une compilation du code soumis par classe que les harnais nomment — cf.
  `DockerEvaluator.toolsPerCaseMs`) et de l'exécution jusqu'au temps limite du prof — ce dernier
  terme est aussi celui d'une solution honnête qui boucle —, sous le plafond de 15 min. Un
  artefact de plus de 64 Mo ou de 256 fichiers n'est pas gardé : sa compilation est refaite à
  chaque cas. Le nombre de soumissions d'un étudiant est borné par la tentative unique (une par
  quiz) ; un 502 « sans verdict » ne lui rend la main que deux fois — la tentative est supprimée
  aux 1er et 2e échecs sans verdict, gardée « à revoir » au 3e (voir « Mort sans verdict :
  journal et plafond » ci-dessus). Aucune correction n'est perdue (elles attendent dans la file de core),
  elles peuvent être retardées.
- **Ce que la ligne témoin ne distingue pas.** Elle part juste avant que le superviseur prenne en
  charge le code soumis. Une panne de PLATEFORME survenue après elle (bogue du superviseur dans
  la substitution des gabarits, le verrouillage des sources, la préparation de Go) est donc
  comptée « sans verdict » ; de même pour une notation compilée « incomplète » (erreur interne
  du superviseur en traitant le code soumis, que le code soumis peut provoquer). Jamais de
  fausse note : au pire une tentative « à revoir », et un bogue déterministe y reste après
  relance — l'enseignant ne peut que relancer.
- **Attente d'une place au-delà de `EXEC_INTERNAL_QUEUE_WAIT_MS` (429)** : tentative supprimée,
  non comptée (sauf relance de l'enseignant, ou plafond d'échecs atteint sur un quiz sans reprise : gardée « à revoir »). Pour un compilé, elle a lieu avant tout conteneur ; pour un interprété ou du SQL,
  qui prend une place PAR harnais, elle peut tomber entre deux harnais, après que le code soumis
  a déjà tourné. Elle dépend de la charge des corrections, que le code soumis ne règle pas, mais
  un étudiant qui a des soumissions en cours sur plusieurs quiz tient une place par quiz en
  cours, et il n'y a que deux places internes en prod : c'est le reste ouvert ci-dessus (aucune
  borne par utilisateur), rien ne permet d'y lier une donnée cachée.
- **Mémoire noyau non comptée** : les objets que le code soumis peut créer sous le profil de
  Docker ont été balayés (tableau ci-dessus) ; ceux qui restent permis sont bornés par les rlimits
  et rendus à la mort. Un objet non compté qui aurait échappé au balayage retomberait sur l'OOM
  global de l'hôte. Mesures faites sur le noyau 6.6 de Docker Desktop (x86_64), pas sur le noyau
  de prod ni sur ARM (filtre vérifié par simulation du programme BPF seulement).

## Protocole

- `execution-service` construit l'arborescence (`HarnessProjects`) : `cases/<i>/src/…` par cas,
  `job.json` (`{language, timeout_ms, budget_ms,
  cases:[{index, name} | {index, canary:"pass"|"fail"}]}`).
  - `budget_ms` : temps total que le superviseur s'accorde pour l'ensemble des cas. Il le teste
    AVANT de démarrer un cas ; au-delà, les cas restants sont rendus « non exécuté ».
  - Un cas ne porte que son index et son nom. Les champs `harness_types`/`student_types`
    appartenaient au format framework : le code soumis y était compilé dans la même unité que
    le harnais, donc ses PROPRES tests unitaires étaient découverts et comptés dans son
    verdict, et il fallait les exclure. Les deux programmes séparés ont supprimé la cause, et
    ces champs avec elle.
- Les harnais canaris contiennent `__MOODIT_A__`/`__MOODIT_B__`, substitués par le superviseur
  avec des valeurs aléatoires AU RUNTIME (introuvables dans l'archive).
- Réponse (stdout) : `{"v":1, "results":[{index, name, passed, detail, ms}], "events":[…],
  "canaries":"ok|incoherents|indetermines|aucun", "incomplet":true|false}`. Le côté Java
  (`DockerEvaluator`) est fail-closed : cas absent, JSON illisible ou erreur = jamais « réussi ».
  `incomplet` vaut vrai quand un cas réel a subi une erreur de LOGIQUE du superviseur (le code
  soumis peut parfois la provoquer, cf. « Ce que la ligne témoin ne distingue pas »), ou a été
  INTERROMPU par la plateforme — compilation du noteur expirée ou tuée, inventaire `javap` ou
  sonde des noms réservés C/C++ ou javac du serveur RPC Java expirés ou tués (cause
  `interrompu`, `platform_aborted`) ; « tué » comprend le travailleur tué sous un pilote qui
  survit et sort en 1 (`gcc: fatal error: Killed signal terminated program cc1`, `…/compile:
  signal: killed` sous `go build`, `collect2: fatal error: ld terminated with signal 9 [Killed]`
  sous gcc ou, préfixé de `= note:`, sous rustc ; `TOOL_KILLED`, `tool_killed`) — signature lue sur le stderr du noteur ou de
  la sonde seulement, que le code soumis ne contrôle pas. Ces cas devenaient un 0 définitif que
  personne ne pouvait rejouer. Le code soumis ne peut pas les provoquer : l'API relayée, les
  classes Java et les noms sondés sont bornés en amont (refus noté), et le pire cas mesuré reste
  loin des délais. Le « Tester » garde leur message. Sur le chemin interne, `DockerEvaluator`
  fait de ces cas interrompus un 502 « sans verdict », compté par core, et la tentative est à
  reprendre ou, au plafond, « à revoir ». La compilation du CODE SOUMIS tuée, elle, n'est
  jamais `interrompu` ni `incomplet` : c'est un échec noté (le code soumis peut la provoquer),
  non concluant seulement pour son rejeu et pour les canaris (cf. « Compilation du code soumis
  faite une fois par job »). `canaries` vaut `aucun` seulement pour
  un job sans canaris : `DockerEvaluator` le refuse, chaque job en portant deux. Des canaris incohérents l'emportent : la notation n'est alors
  jamais « incomplète ». `incoherents` (cas verts mis à zéro) exige un cas réel vert ET un
  canari démenti de façon concluante, ou les DEUX canaris gelés (expirés ou tués) ; un canari
  expiré ou tué alors que l'autre n'a pas été jugé (sauté, avant ou après avoir tourné ;
  compilation non concluante ; interrompu) donne `indetermines` — hôte chargé, pas falsification (`canary_verdict`, oracle
  de `CanaryTruthTableTest`).

## Dispositions par langage

| Langage | Image | Disposition | Verdict |
|---|---|---|---|
| Java | `moodit-runner-java` (temurin 25) | code soumis + `harnais_rpc.java` marqué | nonce sur le stderr du NOTEUR |
| C# | `moodit-runner-csharp` (mono) | `solution.cs` + `harnais_rpc.cs` marqué | nonce sur le stderr du NOTEUR |
| Go | `moodit-runner-go` | `main.go` + `harnais_rpc.go` marqué | nonce sur le stderr du NOTEUR |
| Rust | `moodit-runner-rust` | `solution.rs` + `harnais_rpc.rs` marqué | nonce sur le stderr du NOTEUR |
| C / C++ | `moodit-runner-c` (gcc 14, partagée) | `solution.c\|cpp` + `harnais_rpc.c\|cpp` marqué | nonce sur le stderr du NOTEUR |

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
  exécutable, IPC System V, inodes, OOM qui ne tue jamais le superviseur et ordre des victimes,
  verrous d'enregistrement et AIO noyau refusés, plage d'UID, compilation faite une fois par job
  dans les six langages — échec rejoué, binaire juste recopié —, boucle infinie, budgets, poids). En CI (`SANDBOX_REQUIRED=true`), une précondition
  manquante FAIT ÉCHOUER le job.
- Dev local : démon Docker requis (Windows : named pipe, détecté automatiquement par
  `DockerSandbox`). Sans démon ni images, les tests s'ignorent et l'évaluation compilée répond 502
  (cause `indisponible`) — côté core, la tentative en attente est alors SUPPRIMÉE
  (`quiz:attempt-failed`) et l'étudiant doit resoumettre (sauf relance de l'enseignant, ou plafond d'échecs atteint sur un quiz sans reprise : gardée « à revoir ») : il n'existe pas de rejouage
  automatique. Seuls les 502 `sans_verdict` sont comptés (plafond ci-dessus).

Images du mode « exec » : `python` (numpy/pandas/scipy/sympy), `node` (+ tsc — JS, TS et les
harnais JS de JSON/HTML/JSX/TSX, bundles vendor fournis avec le job), `php`, `bash`, `sqlite`.
Les compilés réutilisent leurs images de notation pour le bouton « Exécuter ».
