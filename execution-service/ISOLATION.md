# Isolation & anti-triche de l'exécution du code

Ce document décrit **comment** le code non fiable de l'étudiant est isolé lors de la correction,
les **dépendances fragiles** à connaître avant une mise à jour, et le **résiduel** de sécurité restant.

## Le modèle par langage

| Groupe | Langages | Modèle | Verdict |
|---|---|---|---|
| Appel de fonction / classe (interprétés) | Python, JavaScript, TypeScript, PHP, Bash | **RPC 2 processus** | nonce émis par le noteur |
| Vues / composants | JSX, TSX | **RPC + proxy DOM** | nonce émis par le noteur |
| Données inertes | JSON, HTML | contenu non exécuté | nonce (harnais JS sur `data`/`doc`) |
| Compilés | Go, Rust, C, C++, C#, Java | **runner Docker + RPC 2 processus, 2 UID** | nonce émis par le noteur |
| Requête / état | SQL | **lecture seule** : un processus, chaque instruction de la réponse enfermée dans sa vue (`CREATE VIEW solution…`) ; **modification** (`-- @student`) : isolation 2 phases (dump) | sortie encadrée par sentinelles au nonce ; un nonce par phase, sentinelle de début en double = échec ; code contenant un octet NUL refusé avant tout conteneur (sqlite3 coupe sa ligne au NUL : la réponse sortait de sa vue) ; dump de phase 1 tronqué par le superviseur refusé (« État de la base trop volumineux ») ; dump découpé comme le tokenizer de SQLite (paramètres `$x(…)` compris) et refusé si une instruction gardée porte un paramètre (« État de la base invalide » : schéma réécrit par `writable_schema` pour faire exécuter du SQL en phase 2) ; sentinelles de phase 1 par `.print`, insensibles au `.mode` de l'étudiant |

### Isolation RPC (interprétés + JSX/TSX)
Le **harnais du prof reste identique**. À l'assemblage, `CodeAssembler` produit **deux fichiers** :

- **`grader.*` (noteur)** : exécute le harnais avec des **proxys** (mandataires) pour les symboles
  étudiants que le harnais **emploie** (fonctions/classes découvertes par regex, noms Unicode
  compris ; PHP : tous). Contient le **nonce** et les **attendus**. S'**auto-supprime** au
  démarrage. **Aucun code étudiant** n'y tourne. Un nom soumis qui masquerait une intégrée que
  le harnais emploie (`sum`, `max`, `test`…) est **refusé** (« Nom réservé »), sauf s'il est
  déclaré par le **code de départ** de la question (#22) et que le noteur ne s'en sert pas
  lui-même.
- **`student_server.*` (serveur)** : héberge le vrai code étudiant. Boucle RPC (JSON par ligne) : reçoit
  « appelle `f(args)` / `new C(args)` / méthode », exécute, renvoie la valeur. **Aucun nonce.**

Le noteur appelle les proxys → RPC synchrone → le serveur exécute → renvoie la valeur → le noteur
tranche le harnais et **émet le nonce s'il réussit**. Comme le code étudiant ne tourne **jamais** dans
le noteur, il ne peut ni lire le nonce ni forger le verdict par sa sortie : **passer = produire les
bonnes sorties**. Cette garantie s'arrête à la séparation des **processus** : noteur et serveur
tournent sous le **même UID** (cf. « Résiduel connu »), contrairement aux compilés.

Détails : identifiants internes préfixés `__moodit_` (pas de collision) ; en Python le proxy de classe
référence le RPC via `globals()["__moodit_rpc"]` (le *name mangling* renommerait `__moodit_rpc`).

## Dépendances fragiles (à vérifier lors d'une mise à jour des images runner)

Ces points reposent sur des comportements précis de l'environnement. **Un test d'intégration réel les
couvre** (`ExecutionIntegrationTest`, cf. CI) — le lancer après toute mise à jour.

- **Sous-processus autorisés** dans le conteneur runner (le noteur lance le serveur), dans la limite
  de `--pids-limit`.
- **`child.stdout._handle.fd`** (interne Node non documenté) pour le `fs.readSync` **synchrone** en JS/TS/JSX.
- **`process.mainModule`** : vecteur d'évasion en JSX **corrigé** par l'isolation (le composant ne peut
  plus atteindre le nonce). À re-tester si le runtime React/Node change.
- **Compilation TS** : `tsc --noCheck` (transpilation seule — typage permissif à l'exécution) ;
  le grader lance `node student_server.js`, le `.js` transpilé.
- **Bash** : bash garde `grader.sh` ouvert (fd 255) même supprimé, et `/proc/<pid>/fd/255` le
  rouvre sous le même UID. Le noteur est donc un seul bloc `{ … }`, analysé en entier avant
  exécution, qui **vide** son fichier avant de l'effacer : le fd ne rouvre plus qu'un fichier vide.
  Ne pas sortir de commande du bloc. Même précaution pour `grader.php`.
- **Sorties du mode exec** : relues par chemin par root, donc rangées dans `/box/.sorties`
  (root 0700) et non dans `/box/work`, qui appartient à l'étudiant (il pouvait y substituer
  `run.err` pendant son exécution).
- **Compilés** : notés dans le runner Docker en mode « evaluate » (voir plus bas) ; le bouton
  « Exécuter » passe par le mode « exec » des mêmes images.

### Runner Docker des compilés (#116)

Go, Rust, C, C++, C# et Java sont notés dans un **conteneur jetable** `moodit-runner-*`
(réseau coupé, mémoire/PID/CPU bornés). Dans le conteneur, un **superviseur** (root) pilote la
notation ; le code soumis est **compilé ET exécuté sous l'UID étudiant** — le compilateur obéit à
un texte choisi par l'étudiant (`include_str!`, `.incbin`, cgo) et pouvait embarquer dans le
binaire tout fichier lisible par son processus : compilé par root, cela incluait le noteur, nonce
compris. Les sources du noteur naissent en 0600 root, et `src/` est verrouillé avant toute
compilation étudiante.
Le harnais est un CORPS qui renvoie un booléen — la seule forme notée (le format framework
est refusé en amont, voir plus bas).

**Harnais booléen — verdict NON FALSIFIABLE.**
Le harnais du prof est un corps qui renvoie vrai ou faux. Le superviseur le compile dans un
**programme séparé, lancé sous un UID séparé** (le noteur), et compile le code de l'étudiant
**seul** dans un autre programme (le serveur). Les deux communiquent par des tubes croisés ; le
noteur appelle des **bouchons typés** générés à partir des signatures réellement présentes dans le
code soumis, et il est le seul à détenir le nonce, qu'il émet sur **son** stderr. L'étudiant ne
peut donc ni lire le harnais, ni le modifier, ni forger son résultat — non parce qu'on le
détecterait, mais parce que son processus ne contient ni le secret, ni le verdict, ni le harnais.
Chaque appel porte un **identifiant imprévisible** (le stdout du code noté est le canal de
réponse : sans cela, il pouvait répondre avant la question). La **POO est proxifiée** : l'objet
vit chez l'étudiant, le noteur n'en manipule qu'une poignée, et les deux idiomes sont pris en
charge — constructeur (`new Rectangle(3, 4)`, `Rectangle::new`, `NewRectangle`) et littéral à
champs nommés en Go et Rust, où le langage n'a pas de constructeur. Les cinq canaux de forge
démontrés contre l'ancien modèle (lecture de l'artefact compilé, détournement du flux de sortie,
interposition de `printf`, `dup2`, lecture de sa propre mémoire) n'ont plus de cible.

**Il n'y a plus qu'un modèle.** Le format « vraie classe de test du framework » (JUnit, NUnit,
`go test`, `cargo test`, `moodit_check.h`) a existé dans une version intermédiaire de #116 : il
compilait le harnais AVEC le code de l'étudiant, donc le processus qui détenait le secret et
calculait le verdict était celui que l'étudiant contrôle. Cinq canaux de forge y ont été démontrés
et fermés l'un après l'autre, et il en restait toujours un. Ce format est **retiré** : un harnais
qui en porte le marqueur est refusé avec un diagnostic, avant toute prise de place sandbox.

**Plus de détection, et c'est le propos.** Le harnais et le nonce n'entrent dans aucun processus ni
fichier que le code soumis puisse atteindre : il n'y a rien à surveiller. La capacité `SYS_PTRACE`
n'est plus accordée au conteneur et `strace` a quitté les images — elles ne servaient qu'à repérer
une lecture du harnais, nécessaire quand il vivait dans un fichier ouvrable. Les événements
restants portent sur l'infrastructure (`budget_depasse`, `espace_sature`, `erreur_superviseur`) et
sur les canaris, qui vérifient que la chaîne tranche encore dans les deux sens.

Modèle de menace complet, statut par langage, limites assumées, protocole et suivis ouverts :
`docker/runners/README.md`. Filets d'intégration : `RpcGradingIntegrationTest` (notation) et
`RunnerSandboxIntegrationTest` (isolation du conteneur).

## Limites du bac à sable (#24)

- **Par exécution** : temps limite par cas (défaut 3 s en « exec » — plancher 10 s pour Java,
  dont la compilation JEP 330 vit dans la fenêtre de run —, 10 s par cas de notation,
  configurable par question jusqu'à 60 s) ; mémoire/PID/CPU bornés PAR CONTENEUR
  (`SANDBOX_MEMORY_MB` 1,5 Go, `SANDBOX_PIDS_LIMIT` 512, `SANDBOX_CPUS` 2 ; vérifiés au démarrage :
  au moins 6 Mo, 1 PID et 0,01 CPU, sinon le service refuse de démarrer — Docker lit 0 comme
  « illimité », un quota CFS nul (moins de 10 000 nanoCPU) ne borne plus rien et un quota sous
  1 ms fait refuser chaque démarrage par le noyau). `SANDBOX_CPUS` vaut au plus le nombre de CPU de
  l'hôte Docker : au-delà, le démon refuserait chaque conteneur, la valeur est donc plafonnée à ce
  nombre (lu au premier usage du démon, avertissement unique dans le journal). Rlimits du processus
  étudiant (fichiers, nproc, nofile) ; sorties tronquées (64 Ko en notation, 1,2 Mo en exec —
  le dump SQL de la phase 1 peut approcher `app.sql.max-dump-chars`).
- **Charge** (`ExecutionLimiter`) : au plus `EXEC_MAX_CONCURRENT` conteneurs runner simultanés (file
  d'attente de `EXEC_QUEUE_WAIT_MS`), et `EXEC_MAX_PER_USER` requêtes en cours par utilisateur sur
  `/exec/**`. Au-delà : 429 avec un message en français. Appels publics et appels internes
  (correction des soumissions, sans limite par utilisateur) ont chacun au plus
  `EXEC_MAX_CONCURRENT − 1` places : chaque côté en garde toujours une que l'autre ne peut pas prendre.
- **Budget global d'une correction INTERPRÉTÉE/SQL/vues** (`EXEC_INTERPRETED_BUDGET_MS`, 15 min ;
  4 min pour un « Tester » public) : ce chemin prend une place et un conteneur **par harnais**, son
  pire cas croissait donc linéairement et sans borne. Passé l'échéance, les harnais restants ne sont
  pas lancés et reçoivent un verdict « Non évalué » avec leur poids conservé — mêmes verdicts
  partiels que ceux rendus au mur d'un conteneur compilé — quand c'est le code soumis qui a
  consommé le budget (harnais interrompus au temps limite). Si c'est l'ATTENTE d'une place qui l'a
  mangé, en correction interne, la correction lève au contraire un 502 de cause `sans_verdict`,
  compté par core (règle détaillée dans `deploy/DEPLOY.md`). Variable lue par execution-service **et**
  par core-service (son miroir de délai de lecture, #216) : ne jamais la régler d'un seul côté.
- **Conteneurs runner** : réseau coupé (`--network none`), écritures de l'UID étudiant **confinées
  aux tmpfs bornés** `/box`, `/tmp` et `/dev/shm`, **dérivés de la mémoire du conteneur** (60 %,
  6 % et 2 % de `SANDBOX_MEMORY_MB`, planchers 256/32/16 Mo — cf. `DockerSandbox.boxSizeMb()` ;
  614/61/20 Mo avec le 1 Go de la prod) et comptés dedans, et bornés aussi en nombre de fichiers
  (`nr_inodes` : 32 768 / 4 096 / 1 024, cf. `DockerSandbox.BOX_INODES` — un fichier vide coûte de
  la mémoire noyau que la taille du tmpfs ne compte pas) — les
  images verrouillent leurs répertoires monde-inscriptibles (`/var/tmp`, `/go`, cargo…), le disque
  de l'hôte est donc hors d'atteinte du code étudiant — toutes les capacités retirées sauf le
  minimum du superviseur (chown/droits, setuid étudiant, kill, et `SYS_RESOURCE` pour l'ordre
  des victimes de l'OOM — voir plus bas), `no-new-privileges`,
  UID étudiant dédié ; détails dans `docker/runners/README.md` et `deploy/DEPLOY.md`.
  L'IPC System V, comptée dans la mémoire mais hors de ces tmpfs, est fermée par trois réglages du
  conteneur (`DockerSandbox.IPC_SYSCTLS`) : `kernel.shm_rmid_forced=1` (un segment de mémoire
  partagée disparaît dès qu'il n'est plus attaché, donc avec le processus soumis),
  `kernel.msgmni=0` (aucune file de messages) et `kernel.sem` avec semmni à 0 (aucun jeu de
  sémaphores). Journaux du conteneur (le verdict y passe) : json-file à options fixées
  (`DockerSandbox.LOG_OPTS`, un fichier de 128 Mo, écriture bloquante), pour qu'un `max-size` bas
  ou un `mode: non-blocking` réglé sur le démon ne troue pas le verdict.
- **Le superviseur n'est jamais tué par l'OOM** : sans lui, le conteneur meurt sans JSON (502 de
  cause `sans_verdict` si le superviseur avait écrit sa ligne témoin de prise en charge du code
  soumis, `indisponible` sinon ; core plafonne les `sans_verdict` à 3 par étudiant et par quiz,
  puis garde la tentative « à revoir » par l'enseignant — `docker/runners/README.md`, « Mort sans
  verdict »). Si
  cela arrive malgré tout (sortie 137 et `State.OOMKilled`, lu avant la suppression du conteneur),
  c'est journalisé en erreur dédiée : l'isolation est en défaut. Conteneur lancé à `oom_score_adj` -1000
  (`DockerSandbox.SUPERVISOR_OOM_SCORE_ADJ`) ; chaque processus lancé par le superviseur est
  remonté explicitement (`mark_oom_victim`, appliqué d'office par `run_proc` et `run_pair`) : 1000
  pour le code soumis et sa compilation, 500 pour le noteur des compilés et les compilations root.
  En mode exec, le noteur assemblé tourne sous l'UID étudiant, à 1000 comme le code soumis. La capacité `SYS_RESOURCE`, accordée au conteneur pour cette
  seule raison, rend la valeur irréversible : le code soumis ne peut plus la redescendre au niveau
  du superviseur, ce qui lui permettait, avec de la mémoire noyau tenue hors de son RSS (memfd,
  tampons de sockets, VMA), de faire tuer le PID 1 (sortie 137 mesurée). Le code soumis n'a aucune
  capacité. Requiert Docker rootful, sans `userns-remap` (l'UID étudiant est tiré au-delà de 2²⁴,
  hors des 65 536 UID qu'il mappe).
- **Verrous d'enregistrement POSIX refusés au code soumis** (filtre seccomp posé par le
  superviseur, `install_student_filter`) : le cgroup ne les compte pas, et 4 millions de verrous en
  16 s ajoutaient 872 Mo de mémoire noyau à l'hôte. `flock()` reste permis. Coût : SQLite sur
  fichier (« database is locked » ; `:memory:` fonctionne) et `FileChannel.lock()` en Java. Le
  même filtre refuse `io_setup` (ENOSYS) : la limite de l'AIO noyau, `fs.aio-max-nr`, est globale
  à l'hôte, et le code soumis la vidait en une seconde.
- **La compilation du code soumis n'est faite qu'une fois par job** (`compile_student`) : le
  programme étudiant est le même à chaque cas (en C#, tant que les harnais nomment la même
  classe). Son échec est rejoué aux suivants (un délai dépassé ou une mort par signal, une fois
  constaté deux fois) ; sa réussite, en recopiant le binaire gardé par root. Une boucle
  d'évaluation constante en Rust tenait une place 451 s pour trois cas ; 183 s désormais.
- **UID étudiant tiré entre 2²⁴ et 2³¹ − 2** : les limites par UID du noyau sont communes à l'hôte,
  et deux conteneurs simultanés ne doivent pas partager le leur.
  Mesures, vecteur par vecteur, et restes ouverts : `docker/runners/README.md`, « Conteneur mort
  sans verdict ».
- **Journaux relus par le service** : au plus 16 Mo par flux (`DockerSandbox.LOG_CAP_BYTES`) ;
  au-delà, la sortie n'est pas un verdict (502).
- **Arrêt du service** : les conteneurs en vol sont supprimés dès la fermeture du contexte
  (`ContextClosedEvent`, avant l'arrêt progressif du serveur web — `DockerSandbox.removeInFlight`),
  et plus aucun n'est lancé ensuite ; la notation en cours finit en 502. `OrphanSweeper` reste le
  filet d'une JVM tuée.

## Résiduel connu

L'isolation ramène la triche à « **produire les bonnes sorties = résoudre** ». Il reste que le **serveur
étudiant peut polluer son canal** : un étudiant qui **connaît déjà l'attendu** (en lisant des cas de
test visibles) pourrait forger une réponse. Ce n'est **pas** un laissez-passer (il faut connaître ou
calculer la bonne sortie) — c'est le problème classique des **cas de test connus**, atténué par des cas
**cachés**.

**UID partagé hors compilés.** Pour les interprétés, JSX/TSX, SQL et les vues, le mode « exec » du
runner exécute noteur et code soumis **sous le même UID**. Le code étudiant ne tourne pas dans le
noteur et ne reçoit pas le nonce, mais un étudiant déterminé peut encore inspecter les processus
voisins, selon la politique `ptrace` de l'hôte. La propriété « **verdict non falsifiable** » ne vaut
donc que pour les six langages compilés avec un harnais booléen, qui séparent les UID (cf.
`CodeAssembler.assembleBashRpc` et `docker/runners/README.md`).

Les noteurs **Node** (JavaScript, TypeScript, JSX/TSX) ignorent `SIGUSR1` avant de lancer le
processus du code soumis, et `node` est lancé avec `--disable-sigusr1` : sous le même UID, le code soumis
envoyait ce signal au noteur, dont Node ouvrait alors l'**inspecteur** sur `127.0.0.1:9229` (la
boucle locale existe même sans réseau) — lecture du nonce et verdict forgé, sans `ptrace`
(`ExecutionIntegrationTest.node_grader_inspector_cannot_be_opened_by_the_submission`). Le verdict
exige en outre que le noteur sorte en 0, ce qu'il ne fait que sur un harnais vrai.

Concrètement, la protection du mode « exec » tient à `kernel.yama.ptrace_scope ≥ 1` **sur l'hôte**
(les conteneurs en héritent) : à 0, le code soumis lit la mémoire du noteur, nonce et attendus
compris. Ubuntu le règle à 1 par défaut, Debian à 0. `deploy/update.sh` lit la valeur à chaque
déploiement et avertit si elle n'est pas au moins 1 ; vérifier à la main :
`cat /proc/sys/kernel/yama/ptrace_scope`.

## Tester

- Unitaires (structure des programmes assemblés) : `./gradlew test` (sans Docker).
- **Intégration (comportement réel contre les images runner)** : `ExecutionIntegrationTest`, exécuté
  par le job CI `integration` (construit les 10 images). Couvre Python/JS/TS/PHP/Bash/SQL **et** JSX/TSX (rendu
  statique + interactif), plus des « Exécuter » Java et Go. La notation des langages COMPILÉS a son
  propre filet : `RpcGradingIntegrationTest` (six langages, forge refusée), et l'isolation du
  conteneur `RunnerSandboxIntegrationTest`. Les cas JSX/TSX exigent le bundle `react-runtime.js` via `APP_VENDOR_DIR`
  (la CI l'extrait de l'étape `jsvendor`) ; sans lui, ils s'ignorent. En local : cf. `scripts/`.
  Couvre aussi les limites : un état SQL de plus de 100 Ko reçu complet, et une allocation bornée
  au-dessus de la limite mémoire, tuée par elle (avec un témoin sous la limite, qui réussit).
- **Runner des compilés** : `RpcGradingIntegrationTest` et `RunnerSandboxIntegrationTest` (même job CI ; construit d'abord les
  images `docker/runners/build.sh`). En local : démon Docker + images, sinon les tests s'ignorent.
