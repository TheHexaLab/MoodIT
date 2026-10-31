# Isolation & anti-triche de l'exécution du code

Ce document décrit **comment** le code non fiable de l'étudiant est isolé lors de la correction,
les **dépendances fragiles** à connaître avant une mise à jour, et le **résiduel** de sécurité restant.

## Le modèle par langage

| Groupe | Langages | Modèle | Verdict |
|---|---|---|---|
| Appel de fonction / classe (interprétés) | Python, JavaScript, TypeScript, PHP, Bash | **RPC 2 processus** | nonce émis par le noteur |
| Vues / composants | JSX, TSX | **RPC + proxy DOM** | nonce émis par le noteur |
| Données inertes | JSON, HTML | contenu non exécuté | nonce (harnais JS sur `data`/`doc`) |
| Compilés | Go, Rust, C, C++, C#, Java | source **absente au runtime** | nonce |
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

## Dépendances fragiles (à vérifier lors d'une mise à jour Piston / runtime)

Ces points reposent sur des comportements précis de l'environnement. **Un test d'intégration réel les
couvre** (`ExecutionIntegrationTest`, cf. CI) — le lancer après toute mise à jour.

- **Sous-processus autorisés** dans le sandbox isolate (le noteur lance le serveur). *Spike validé.*
- **`child.stdout._handle.fd`** (interne Node non documenté) pour le `fs.readSync` **synchrone** en JS/TS/JSX.
- **`process.mainModule`** : vecteur d'évasion en JSX **corrigé** par l'isolation (le composant ne peut
  plus atteindre le nonce). À re-tester si le runtime React/Node change.
- **Compilation TS** : fichiers nommés sans extension → Piston écrit `.ts` et compile `.js`.
- **Bash** : `grader.sh` supprimé mais lisible via son fd déjà ouvert (sémantique unlink Unix).
- **Compilés** : la source n'est pas présente dans le dossier d'exécution (vérifié : `fopen(main.c)=NULL`).

## Limites du bac à sable (#24)

- **Par exécution** (envoyées par `PistonClient` à chaque appel) : `run_timeout` 3 s,
  `compile_timeout` 10 s, `run_memory_limit` 256 Mo, `compile_memory_limit` 512 Mo
  (`PISTON_RUN_MEMORY_LIMIT_BYTES` / `PISTON_COMPILE_MEMORY_LIMIT_BYTES`). Piston a les mêmes plafonds
  côté serveur (compose) : une valeur plus haute côté execution-service serait refusée.
- **Sortie** : `PISTON_OUTPUT_MAX_SIZE` = 1 Mio par flux (compose). Le défaut de Piston (1 024
  caractères) tronquait le dump SQL de la phase 1, qui peut atteindre `app.sql.max-dump-chars` (512 Ki).
- **Charge** (`ExecutionLimiter`) : au plus `EXEC_MAX_CONCURRENT` appels Piston simultanés (file
  d'attente de `EXEC_QUEUE_WAIT_MS`), et `EXEC_MAX_PER_USER` requêtes en cours par utilisateur sur
  `/exec/**`. Au-delà : 429 avec un message en français. L'appel interne (correction des soumissions)
  ne compte que dans la limite globale.
- **Conteneur** : réseau `sandbox` dédié (execution-service seul), pas de `privileged` (capacités
  minimales, cf. `deploy/DEPLOY.md`), image épinglée par digest (`piston/Dockerfile`).

## Résiduel connu

L'isolation ramène la triche à « **produire les bonnes sorties = résoudre** ». Il reste que le **serveur
étudiant peut polluer son canal** : un étudiant qui **connaît déjà l'attendu** (en lisant des cas de
test visibles) pourrait forger une réponse. Ce n'est **pas** un laissez-passer (il faut connaître ou
calculer la bonne sortie) — c'est le problème classique des **cas de test connus**, atténué par des cas
**cachés**. Le noteur (nonce + attendus) reste, lui, hors de portée du code étudiant.

## Tester

- Unitaires (structure des programmes assemblés) : `./gradlew test` (sans Piston).
- **Intégration (comportement réel contre Piston)** : `ExecutionIntegrationTest`, exécuté par le job CI
  `integration` (démarre Piston + runtimes). Couvre Python/JS/TS/PHP/Bash/C/SQL **et** JSX/TSX (rendu
  statique + interactif). Les cas JSX/TSX exigent le bundle `react-runtime.js` via `APP_VENDOR_DIR`
  (la CI l'extrait de l'étape `jsvendor`) ; sans lui, ils s'ignorent. En local : cf. `scripts/`.
  Couvre aussi les limites : un état SQL de plus de 100 Ko reçu complet, et une boucle d'allocation
  tuée par la limite mémoire.
