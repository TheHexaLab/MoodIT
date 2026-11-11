# Isolation & anti-triche de l'exécution du code

Ce document décrit **comment** le code non fiable de l'étudiant est isolé lors de la correction,
les **dépendances fragiles** à connaître avant une mise à jour, et le **résiduel** de sécurité restant.

## Le modèle par langage

| Groupe | Langages | Modèle | Verdict |
|---|---|---|---|
| Appel de fonction / classe (interprétés) | Python, JavaScript, TypeScript, PHP, Bash | **RPC 2 processus** | nonce émis par le noteur |
| Vues / composants | JSX, TSX | **RPC + proxy DOM** | nonce émis par le noteur |
| Données inertes | JSON, HTML | contenu non exécuté | nonce (harnais JS sur `data`/`doc`) |
| Compilés, harnais **booléen** | Go, Rust, C, C++, C#, Java | **runner Docker + RPC 2 processus, 2 UID** | nonce émis par le noteur |
| Compilés, harnais **framework** (héritage) | Go, Rust, C, C++, C#, Java | **runner Docker isolé** (#116, `docker/runners/`) | fail-closed multi-canaux + **canaris** |
| Requête / état | SQL | **isolation 2 phases** (dump) | sortie encadrée par sentinelles au nonce |

### Isolation RPC (interprétés + JSX/TSX)
Le **harnais du prof reste identique**. À l'assemblage, `CodeAssembler` produit **deux fichiers** :

- **`grader.*` (noteur)** : exécute le harnais avec des **proxys** pour chaque symbole étudiant
  (fonctions/classes découverts par regex). Contient le **nonce** et les **attendus**. S'**auto-supprime**
  au démarrage. **Aucun code étudiant** n'y tourne.
- **`student_server.*` (serveur)** : héberge le vrai code étudiant. Boucle RPC (JSON par ligne) : reçoit
  « appelle `f(args)` / `new C(args)` / méthode », exécute, renvoie la valeur. **Aucun nonce.**

Le noteur appelle les proxys → RPC synchrone → le serveur exécute → renvoie la valeur → le noteur
tranche le harnais et **émet le nonce s'il réussit**. Comme le code étudiant ne tourne **jamais** dans
le noteur, il ne peut ni lire le nonce ni forger le verdict : **passer = produire les bonnes sorties**.

Détails : identifiants internes préfixés `__moodit_` (pas de collision) ; en Python le proxy de classe
référence le RPC via `globals()["__moodit_rpc"]` (le *name mangling* renommerait `__moodit_rpc`).

## Dépendances fragiles (à vérifier lors d'une mise à jour des images runner)

Ces points reposent sur des comportements précis de l'environnement. **Un test d'intégration réel les
couvre** (`ExecutionIntegrationTest`, cf. CI) — le lancer après toute mise à jour.

- **Sous-processus autorisés** dans le sandbox isolate (le noteur lance le serveur). *Spike validé.*
- **`child.stdout._handle.fd`** (interne Node non documenté) pour le `fs.readSync` **synchrone** en JS/TS/JSX.
- **`process.mainModule`** : vecteur d'évasion en JSX **corrigé** par l'isolation (le composant ne peut
  plus atteindre le nonce). À re-tester si le runtime React/Node change.
- **Compilation TS** : `tsc --noCheck` (transpilation seule — typage permissif à l'exécution) ;
  le grader spawn `node student_server` → résolu vers le `.js` transpilé.
- **Bash** : `grader.sh` supprimé mais lisible via son fd déjà ouvert (sémantique unlink Unix).
- **Compilés** : notés dans le runner Docker en mode « evaluate » (voir plus bas) ; le bouton
  « Exécuter » passe par le mode « exec » des mêmes images.

### Runner Docker des compilés (#116)

Go, Rust, C, C++, C# et Java sont notés dans un **conteneur jetable** `moodit-runner-*`
(réseau coupé, mémoire/PID/CPU bornés). Dans le conteneur, un **superviseur** (root) compile,
verrouille les sources en 700 et exécute le code soumis sous un **UID dédié** tracé par strace.
Deux formes de harnais coexistent, et c'est la forme qui décide du modèle.

**Harnais booléen (la forme recommandée, et celle des gabarits) — verdict NON FALSIFIABLE.**
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

**Harnais au format framework (héritage #116) — résiduel assumé.** Un harnais déjà écrit comme un
vrai test du langage (JUnit, NUnit, go test, cargo test, `moodit_check.h`) continue de fonctionner,
par l'ancien chemin : compilé AVEC le code de l'étudiant, verdict **fail-closed** gardé par des
**canaris randomisés**. Cette forme est structurellement falsifiable, parce que le code noté
partage le processus qui détient le secret et calcule le verdict : le verdict n'y est tenu pour
infalsifiable en pratique qu'en **Java et Go**, et en **C, C++, C# et Rust** il subsiste un
résiduel in-process que les canaris ne rattrapent pas systématiquement — un tricheur peut
conditionner sa falsification sur « ma fonction a-t-elle été appelée », ce que les cas canaris ne
font jamais. **Pour un examen noté, préférer le harnais booléen.**

**Détection : seul le mode framework en a besoin, et seul lui en a.** Les tentatives (lecture du
harnais, rapport forgé) remontent en **événements** dans le détail des verdicts — `strace`,
canaris, jeton, sommaire authentifié. Le mode booléen, lui, n'exécute **pas** le code soumis sous
`strace` et ne produit aucun de ces événements : sa garantie est architecturale, pas
observationnelle. Il n'y a rien à détecter quand il n'y a rien à atteindre, et un `strace`
indisponible ne relâche donc rien de ce mode (contrairement au mode framework, cf.
`deploy/DEPLOY.md`).

Modèle de menace complet, statut par langage, limites assumées, protocole et suivis ouverts :
`docker/runners/README.md`. Filet d'intégration (matrice anti-triche) :
`DockerRunnerIntegrationTest`.

## Limites du bac à sable (#24)

- **Par exécution** : temps limite par cas (défaut 3 s en « exec » — plancher 10 s pour Java,
  dont la compilation JEP 330 vit dans la fenêtre de run —, 10 s par cas de notation,
  configurable par question jusqu'à 60 s) ; mémoire/PID/CPU bornés PAR CONTENEUR
  (`SANDBOX_MEMORY_MB` 1,5 Go, `SANDBOX_PIDS_LIMIT` 512, `SANDBOX_CPUS` 2) ; rlimits du processus
  étudiant (fichiers, nproc, nofile) ; sorties tronquées (64 Ko en notation, 1,2 Mo en exec —
  le dump SQL de la phase 1 peut approcher `app.sql.max-dump-chars`).
- **Charge** (`ExecutionLimiter`) : au plus `EXEC_MAX_CONCURRENT` conteneurs runner simultanés (file
  d'attente de `EXEC_QUEUE_WAIT_MS`), et `EXEC_MAX_PER_USER` requêtes en cours par utilisateur sur
  `/exec/**`. Au-delà : 429 avec un message en français. L'appel interne (correction des soumissions)
  ne compte que dans la limite globale.
- **Budget global d'une correction INTERPRÉTÉE/SQL/vues** (`EXEC_INTERPRETED_BUDGET_MS`, 15 min ;
  4 min pour un « Tester » public) : ce chemin prend une place et un conteneur **par harnais**, son
  pire cas croissait donc linéairement et sans borne. Passé l'échéance, les harnais restants ne sont
  pas lancés et reçoivent un verdict « Non évalué » avec leur poids conservé — mêmes verdicts
  partiels que ceux rendus au mur d'un conteneur compilé. Variable lue par execution-service **et**
  par core-service (son miroir de délai de lecture, #216) : ne jamais la régler d'un seul côté.
- **Conteneurs runner** : réseau coupé (`--network none`), écritures de l'UID étudiant **confinées
  aux tmpfs bornés** `/box`, `/tmp` et `/dev/shm`, **dérivés de la mémoire du conteneur** (60 %,
  6 % et 2 % de `SANDBOX_MEMORY_MB`, planchers 256/32/16 Mo — cf. `DockerSandbox.boxSizeMb()` ;
  614/61/20 Mo avec le 1 Go de la prod) et comptés dedans — les
  images verrouillent leurs répertoires monde-inscriptibles (`/var/tmp`, `/go`, cargo…), le disque
  de l'hôte est donc hors d'atteinte du code étudiant — toutes les capacités retirées sauf le
  minimum du superviseur (chown/droits, setuid étudiant, kill, strace), `no-new-privileges`,
  UID étudiant dédié ; détails dans `docker/runners/README.md` et `deploy/DEPLOY.md`.

## Résiduel connu

L'isolation ramène la triche à « **produire les bonnes sorties = résoudre** ». Il reste que le **serveur
étudiant peut polluer son canal** : un étudiant qui **connaît déjà l'attendu** (en lisant des cas de
test visibles) pourrait forger une réponse. Ce n'est **pas** un laissez-passer (il faut connaître ou
calculer la bonne sortie) — c'est le problème classique des **cas de test connus**, atténué par des cas
**cachés**. Le noteur (nonce + attendus) reste, lui, hors de portée du code étudiant.

## Tester

- Unitaires (structure des programmes assemblés) : `./gradlew test` (sans Docker).
- **Intégration (comportement réel contre les images runner)** : `ExecutionIntegrationTest`, exécuté
  par le job CI `integration` (construit les 10 images). Couvre Python/JS/TS/PHP/Bash/C/SQL **et** JSX/TSX (rendu
  statique + interactif). Les cas JSX/TSX exigent le bundle `react-runtime.js` via `APP_VENDOR_DIR`
  (la CI l'extrait de l'étape `jsvendor`) ; sans lui, ils s'ignorent. En local : cf. `scripts/`.
  Couvre aussi les limites : un état SQL de plus de 100 Ko reçu complet, et une boucle d'allocation
  tuée par la limite mémoire.
- **Runner des compilés** : `DockerRunnerIntegrationTest` (même job CI ; construit d'abord les
  images `docker/runners/build.sh`). En local : démon Docker + images, sinon les tests s'ignorent.
