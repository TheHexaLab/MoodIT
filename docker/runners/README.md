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

| Propriété | Mécanisme | Limite assumée |
|---|---|---|
| **Verdict infalsifiable en pratique** | fail-closed multi-canaux + **canaris** (un cas qui doit réussir, un qui doit échouer, valeurs tirées au sort, position mélangée — attrapent un forgeage depuis un init/constructeur, exécuté partout) + **jeton de fin d'exécution** (aléatoire par cas, substitué au runtime, imprimé par le point de sortie du framework APRÈS tous les tests — attrape un forgeage depuis la fonction notée : son `exit(0)` saute le jeton, `jeton_absent`) | obtenir le jeton exige de lire la source verrouillée (EACCES + `lecture_source_tentee`) ou son propre binaire (`lecture_binaire_tentee` sur les natifs) → bruyant ; résiduel : en Java/C# une réflexion en-processus sur les constantes chargées, et en Rust `include_str!` (harnais dans le même fichier), peuvent extraire le jeton sans lecture tracée — falsification laborieuse mais silencieuse possible pour un étudiant déterminé |
| **Harnais illisible par l'étudiant** | sources `700` root après compilation, processus étudiant sous UID dédié → `EACCES` ; tentative **tracée** (`lecture_source_tentee`) | les constantes compilées dans les artefacts (binaire de test, `.class`) restent extractibles par un étudiant déterminé |
| **Pas de fuite réseau** | `--network none` | — |
| **Pas d'épuisement de ressources** | mémoire/PID/CPU du conteneur + écritures étudiantes **confinées aux tmpfs bornés** `/box` (768 Mo) et `/tmp` (64 Mo), comptés dans la mémoire (répertoires monde-inscriptibles des images verrouillés → le disque de l'hôte est hors d'atteinte du code étudiant) + rlimits (fichiers, nproc, nofile — posés sur les DEUX chemins, strace compris) + temps limite par cas (prof, max 60 s) + budget mural du conteneur | — |
| **Isolation entre cas** | dossier par cas, groupe de processus tué au timeout, et **balayage des survivants UID étudiant entre deux cas** (un `fork` + `setsid` échappe au kill de groupe) | pendant UN cas, les processus étudiants du même cas partagent l'UID (ptrace entre eux possible selon le `ptrace_scope` de l'hôte) — sans portée inter-cas grâce au balayage |
| **Détection** | événements remontés dans le détail des verdicts + logs serveur : `canari_incoherent`, `rapport_incoherent`, `jeton_absent`, `lecture_source_tentee`, `lecture_binaire_tentee`, `trace_indisponible`, `erreur_superviseur` | l'acheminement vers le journal d'audit (Gardien) est un suivi |

Le **hardcoding** (un étudiant qui code `if (x == 5) return 10;` pour les entrées visibles de
l'énoncé) n'est pas une falsification : c'est la limite de tout système de tests fixes — la parade
est pédagogique (varier les cas).

## Protocole

- `execution-service` construit l'arborescence (`HarnessProjects`) : `cases/<i>/src/…` par cas,
  `job.json` (`{language, timeout_ms, cases:[{index, name} | {index, canary:"pass"|"fail"}]}`).
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
  (la correction reste « en cours » et sera rejouée).

Images du mode « exec » : `python` (numpy/pandas/scipy/sympy), `node` (+ tsc — JS, TS et les
harnais JS de JSON/HTML/JSX/TSX, bundles vendor fournis avec le job), `php`, `bash`, `sqlite`.
Les compilés réutilisent leurs images de notation pour le bouton « Exécuter ».
