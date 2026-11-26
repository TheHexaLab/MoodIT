package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;

import com.moodit.execution_service.sandbox.DockerEvaluator;
import com.moodit.execution_service.sandbox.NoVerdictException;
import com.moodit.execution_service.sandbox.RunnerExec;
import com.moodit.execution_service.sandbox.SandboxException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Évalue une soumission contre chaque harnais. Deux chemins (#116) :
 * <ul>
 *   <li><b>Langages COMPILÉS</b> → {@link DockerEvaluator} : conteneur runner jetable par
 *       soumission (réseau coupé), SUPERVISEUR de confiance (root) qui compile, verrouille les
 *       sources en 700, et compile le harnais du prof dans un programme SÉPARÉ (le noteur,
 *       sous son propre UID) tandis que le code soumis est compilé seul dans un autre. Un cas
 *       est réussi si, et seulement si, le NONCE du cas paraît sur le stderr du noteur
 *       (FAIL-CLOSED), ce que le code soumis ne peut pas produire : il ne détient ni le nonce,
 *       ni le harnais. Le harnais du prof est un CORPS qui renvoie un booléen — un harnais au
 *       format framework est refusé en amont, avec un diagnostic.</li>
 *   <li><b>Interprétés / SQL / vues</b> → mode « exec » du runner (ex-Piston), verdict par NONCE ALÉATOIRE : un
 *       code de sortie 0 seul ne suffit pas (falsifiable par un {@code exit(0)} anticipé) ; il
 *       faut le nonce secret que SEUL le harnais émet en cas de succès, ET une sortie 0 du
 *       noteur (un noteur interrompu après avoir émis le nonce ne vaut pas réussite). Le code
 *       étudiant vit dans un processus séparé qui ne voit jamais le nonce (cf.
 *       {@link CodeAssembler}).</li>
 * </ul>
 */
@Service
public class ExecutionService {

    private static final org.slf4j.Logger log =
            org.slf4j.LoggerFactory.getLogger(ExecutionService.class);

    private static final SecureRandom RNG = new SecureRandom();

    private final CodeAssembler assembler;
    private final RunnerExec runner;
    private final ExecutionLimiter limiter;
    private final DockerEvaluator dockerEvaluator;

    /** Taille max du dump d'état transféré phase 1 → phase 2 (borne anti-DoS). Configurable. */
    @Value("${app.sql.max-dump-chars:524288}")
    private int maxSqlDumpChars = 524288;

    /**
     * Budget GLOBAL de la boucle interprétée/SQL/vues, miroir du mur d'un conteneur de notation
     * compilée ({@code DockerEvaluator.MAX_WALL_MS}, 15 min). Le chemin compilé lance UN conteneur
     * borné par son mur ; le chemin interprété lance un conteneur et prend une place PAR HARNAIS
     * (jusqu'à 100 autorisés par {@code EvaluateRequest}), donc son pire cas croissait LINÉAIREMENT
     * et sans borne : des heures de conteneurs enchaînés longtemps après que l'appelant a renoncé,
     * et un délai de lecture du même ordre à budgéter côté core (ExecutionClient, #216). Passé
     * l'échéance, les harnais restants ne sont plus LANCÉS et reçoivent un verdict explicite —
     * mêmes verdicts partiels que ceux que le superviseur rend au mur de son conteneur.
     * Visibilité paquet : les tests l'abaissent pour exercer l'échéance sans attendre.
     */
    @Value("${app.exec.interpreted-budget-ms:900000}")
    long interpretedBudgetMs = 15 * 60_000;

    /** Sans borne de charge ni runner de notation compilée (tests unitaires de la logique de verdict). */
    public ExecutionService(CodeAssembler assembler, RunnerExec runner) {
        this(assembler, runner, new ExecutionLimiter(Integer.MAX_VALUE, 0, Integer.MAX_VALUE), null);
    }

    /** Pour les tests : runner Docker injectable, sans borne de charge. */
    public ExecutionService(CodeAssembler assembler, RunnerExec runner, DockerEvaluator dockerEvaluator) {
        this(assembler, runner, new ExecutionLimiter(Integer.MAX_VALUE, 0, Integer.MAX_VALUE),
                dockerEvaluator);
    }

    @Autowired
    public ExecutionService(CodeAssembler assembler, RunnerExec runner, ExecutionLimiter limiter,
            DockerEvaluator dockerEvaluator) {
        this.assembler = assembler;
        this.runner = runner;
        this.limiter = limiter;
        this.dockerEvaluator = dockerEvaluator;
    }

    /** Un passage au runner, dans une place de la limite globale (#24) : file bornée, sinon 429. */
    private RunnerExec.Result execute(String runtime, List<RunnerExec.File> files) {
        return execute(runtime, files, null, null);
    }

    /** Variante complète : {@code timeoutMs} = temps limite demandé par le prof ({@code null} → défaut). */
    private RunnerExec.Result execute(String runtime, List<RunnerExec.File> files,
            String stdin, Integer timeoutMs) {
        // Temps passe a ATTENDRE une place (de la demande a l'obtention) : la seule part du budget
        // interprete qui vient de la charge du serveur, donc des autres. Cumule par fil, et lu par
        // la boucle d'evaluation pour distinguer une panne de charge d'une solution lente.
        long requestedAt = System.nanoTime();
        return limiter.withSandboxSlot(() -> {
            long startedAt = System.nanoTime();
            WAIT_NS.get()[0] += startedAt - requestedAt;
            RunnerExec.Result result = runner.execute(runtime, files, stdin, timeoutMs);
            // Execution INTERROMPUE (delai ou memoire) : temps consomme par le code soumis lui-meme,
            // lu sur le SIGNAL de l'execution — jamais sur un texte, que la sortie de l'etudiant
            // pouvait imiter.
            if (interrupted(result)) {
                INTERRUPTED_NS.get()[0] += System.nanoTime() - startedAt;
            }
            return result;
        });
    }

    /** Attente de place cumulee pendant l'evaluation en cours sur ce fil (ns). */
    private static final ThreadLocal<long[]> WAIT_NS = ThreadLocal.withInitial(() -> new long[1]);

    /** Temps des executions interrompues (delai, memoire) pendant l'evaluation en cours (ns). */
    private static final ThreadLocal<long[]> INTERRUPTED_NS = ThreadLocal.withInitial(() -> new long[1]);

    private static boolean interrupted(RunnerExec.Result result) {
        // Jamais null : RunnerExec.execute rend un résultat ou lève (sortie illisible, muette).
        RunnerExec.Stage compile = result.compile();
        RunnerExec.Stage run = result.run();
        return (compile != null && compile.signal() != null) || (run != null && run.signal() != null);
    }

    /** Jeton aléatoire imprévisible, injecté dans le harnais et vérifié en sortie. */
    private static String newNonce() {
        byte[] bytes = new byte[24];
        RNG.nextBytes(bytes);
        return "MOODIT_OK_" + HexFormat.of().formatHex(bytes);
    }

    /**
     * Ligne que le superviseur insère à la place du milieu d'une sortie trop longue
     * ({@code read_capped}, {@code drain_pipe} et {@code bound_json} de {@code supervisor.py} :
     * changer ce libellé là-bas impose de le changer ici, sans quoi un dump SQL tronqué n'est plus
     * refusé).
     */
    static final String SUPERVISOR_TRUNCATION_MARKER = "(sortie tronquée au milieu";

    /**
     * Verdicts de refus si le code soumis contient un octet NUL, sinon {@code null}. Refusé avant
     * tout conteneur, dans tous les langages : les programmes générés le reçoivent tel quel, et
     * leurs lecteurs ne le traitent pas comme Java. Le shell {@code sqlite3} lit son programme
     * ligne par ligne et s'arrête au NUL — la fin de la ligne disparaît, la suivante s'y colle :
     * une chaîne que le découpeur Java voyait fermée restait ouverte, et le texte qui suivait
     * sortait de la vue qui confine la réponse, avant le harnais (verdict forgé, #23). Aucun
     * code légitime n'en contient.
     */
    static List<TestResult> nulRejection(String code, List<TestCaseInput> cases) {
        if (code == null || code.indexOf(0) < 0) {
            return null;
        }
        return cases.stream()
                .map(c -> new TestResult(c.name(), c.effectiveWeight(), false,
                        "Le code soumis contient un caractère nul (octet 0), refusé à la correction : "
                                + "le retirer, puis resoumettre."))
                .toList();
    }

    public List<TestResult> evaluate(EvaluateRequest request) {
        List<TestResult> nul = nulRejection(request.code(), request.testCases());
        if (nul != null) {
            return nul;
        }
        // Langages COMPILÉS (#116) : notés dans un CONTENEUR RUNNER jetable (superviseur root,
        // harnais du prof compilé dans un programme SÉPARÉ sous son propre UID, code soumis seul
        // dans un autre, verdict = le nonce du cas sur le stderr du noteur). Un conteneur = une
        // place de la limite globale, comme toute exécution.
        if (CodeAssembler.isCompiled(request.language())) {
            if (dockerEvaluator == null) {
                throw new SandboxException("Runner Docker non configuré pour les langages compilés");
            }
            // Rejet du marqueur réservé AVANT la prise de place : aucun conteneur n'est
            // nécessaire, et sous saturation le verdict explicite vaut mieux qu'un 429.
            List<TestResult> rejected = DockerEvaluator.reservedMarkerRejection(
                    request.code(), request.testCases());
            if (rejected != null) {
                return rejected;
            }
            // Un harnais au format framework (une vraie classe de test) n'est plus noté : cette
            // forme était compilée AVEC le code de l'étudiant, donc falsifiable. Refus explicite
            // AVANT la prise de place, avec le corps booléen à écrire à la place.
            List<TestResult> framework = DockerEvaluator.frameworkHarnessRejection(
                    request.language(), request.testCases());
            if (framework != null) {
                return framework;
            }
            // Même logique pour un NOM DE CLASSE RÉSERVÉ (Java) : sans ce refus, le code soumis
            // était écrasé ou sauté côté superviseur, et le 0 arrivait avec un message qui
            // n'explique pas la cause (« Aucun fichier de code soumis »).
            List<TestResult> reserved = DockerEvaluator.reservedNameRejection(
                    request.language(), request.code(), request.testCases());
            if (reserved != null) {
                return reserved;
            }
            // Mur plafonné selon l'appelant : une correction interne a droit au budget complet,
            // un « Tester » public est borné (route réservée aux éditeurs de quiz, mais
            // jusqu'à 100 cas fournis par l'appelant).
            long maxWall = limiter.isInternal()
                    ? Long.MAX_VALUE : DockerEvaluator.PUBLIC_WALL_MS;
            return limiter.withSandboxSlot(() -> dockerEvaluator.evaluate(
                    request.language(), request.code(), request.testCases(), request.timeoutMs(),
                    maxWall));
        }
        long budgetMs = interpretedBudgetMs();
        // Un budget absurde (Long.MAX_VALUE) fait SATURER toNanos et déborder l'addition : la
        // comparaison par DIFFÉRENCE ci-dessous (`nanoTime() - deadline >= 0`) reste juste malgré
        // le débordement — ne jamais l'écrire `nanoTime() >= deadline`.
        long budgetNs = java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(budgetMs);
        long startNs = System.nanoTime();
        long deadline = startNs + budgetNs;
        WAIT_NS.get()[0] = 0;
        INTERRUPTED_NS.get()[0] = 0;
        List<TestResult> results = new ArrayList<>();
        boolean exhausted = false;
        for (TestCaseInput testCase : request.testCases()) {
            // Le PREMIER harnais part toujours : un budget mal configuré (0, négatif) doit
            // dégrader la correction, pas la vider de tout verdict réel. L'échéance est ensuite
            // consultée AVANT de lancer un harnais — celui qui est déjà parti va au bout, d'où
            // le dépassement d'une unité (deux pour un harnais SQL de modification) que le
            // miroir de budget d'ExecutionClient prévoit.
            // Comparaison par DIFFÉRENCE (idiome de nanoTime, comme ExecutionLimiter.remainingMs) :
            // l'origine de nanoTime est arbitraire, un `>=` direct se trompe au passage par zéro.
            if (!results.isEmpty() && (exhausted || System.nanoTime() - deadline >= 0)) {
                if (!exhausted) {
                    log.warn("Budget d'évaluation dépassé ({} ms, {} harnais sur {} évalués) : "
                            + "les harnais restants ne sont pas lancés",
                            budgetMs, results.size(), request.testCases().size());
                    exhausted = true;
                    // Chemin INTERNE : si le TRAVAIL seul (ecoule moins l'attente de place) tenait
                    // dans le budget, c'est l'attente — la charge creee par les autres — qui l'a
                    // fait deborder. Ce n'est pas une note : 502, la tentative est supprimee et
                    // l'etudiant resoumet. Sinon (solution lente, question a beaucoup de
                    // harnais), c'est reproductible : note PARTIELLE, jamais un 502 a chaque
                    // renvoi qui rendrait la question impossible a noter.
                    // ET l'attente l'emporte sur le temps des harnais INTERROMPUS : une solution
                    // qui boucle, dans une file chargee, atteignait son delai a chaque harnais
                    // sans que le travail mesure depasse le budget — elle partait en 502, un
                    // essai de plus. Mais un seul harnais interrompu ne suffit pas a mettre
                    // toute l'attente sur le compte de l'etudiant : quand la file a coute plus
                    // que ses propres interruptions, c'est bien la charge qui a fait deborder.
                    // Cause « sans verdict » (NoVerdictException), comptee par core (#116, S4) :
                    // le code soumis peut s'arreter juste sous le temps limite a chaque harnais
                    // (aucune interruption) et laisser la file faire le reste. Non compte, ce 502
                    // offrait un nouvel essai a volonte sur une question a tentative unique. Un
                    // etudiant honnete pris dans la meme charge est compte lui aussi ; au plafond,
                    // sa tentative est gardee « a revoir » et l'enseignant la relance — jamais une
                    // fausse note.
                    long waitNs = WAIT_NS.get()[0];
                    long workNs = (System.nanoTime() - startNs) - waitNs;
                    if (limiter.isInternal() && workNs < budgetNs
                            && waitNs > INTERRUPTED_NS.get()[0]) {
                        throw new NoVerdictException("Notation incomplète (charge du serveur) : "
                                + "la tentative est à reprendre");
                    }
                }
                results.add(new TestResult(testCase.name(), testCase.effectiveWeight(), false,
                        "Non évalué : budget d'évaluation dépassé (les harnais précédents ont "
                                + "consommé le temps alloué à cette correction)."));
                continue;
            }
            // Un nonce DIFFÉRENT par harnais : imprévisible d'un test à l'autre.
            results.add(runOne(request.language(), request.code(), testCase, newNonce(),
                    request.timeoutMs(), request.startCode()));
        }
        return results;
    }

    /**
     * Exécute le code TEL QUEL (sans harnais) et renvoie sa sortie brute (stdout/stderr/exit).
     * Sert au bouton « play » des éditeurs — l'étudiant/prof voit sa sortie et, en cas d'exception,
     * la stack trace (stderr). Un échec du programme (exit ≠ 0) n'est PAS une erreur HTTP : la
     * sortie est renvoie normalement (200), c'est le résultat attendu du « run ».
     */
    public RunResult run(RunRequest request) {
        CodeAssembler.Assembled assembled = assembler.assembleRun(request.language(), request.code());
        RunnerExec.Result result = execute(assembled.runtime(), assembled.files());

        RunnerExec.Stage compile = result.compile();
        String compileOutput = compile == null ? null : firstNonBlank(compile.stderr(), compile.stdout());
        // Échec de compilation (langages compilés) : pas d'étape run, on remonte la sortie de compil.
        if (compileFailed(compile)) {
            return new RunResult("", compileFailureDetail(compile),
                    compile.code(), compile.signal(), compileOutput, compileKilled(compile));
        }

        RunnerExec.Stage run = result.run();
        if (run == null) {
            return new RunResult("", "Aucune sortie d'exécution", null, null, compileOutput, false);
        }
        boolean timedOut = run.signal() != null;
        return new RunResult(trim(run.stdout()), trim(run.stderr()), run.code(), run.signal(),
                compileOutput, timedOut);
    }

    private TestResult runOne(String language, String code, TestCaseInput testCase,
            String nonce, Integer timeoutMs, String startCode) {
        int weight = testCase.effectiveWeight();

        // SQL en mode MODIFICATION (harnais avec « -- @student ») : exécution ISOLÉE en deux phases
        // (bac à sable jetable pour l'étudiant, puis noteur séparé). Cf. runSqlIsolated.
        if (CodeAssembler.isSql(language) && CodeAssembler.sqlHasStudentMarker(testCase.harnessCode())) {
            return runSqlIsolated(code, testCase, nonce, weight, timeoutMs);
        }

        CodeAssembler.Assembled assembled = assembler.assemble(language, code, testCase.harnessCode(),
                nonce, startCode);
        RunnerExec.Result result = execute(assembled.runtime(), assembled.files(), null, timeoutMs);

        // Échec de compilation (ex. TypeScript) → test échoué, message = stderr de compilation.
        RunnerExec.Stage compile = result.compile();
        if (compileFailed(compile)) {
            return new TestResult(testCase.name(), weight, false, compileFailureDetail(compile));
        }

        RunnerExec.Stage run = result.run();

        // SQL : le verdict se lit sur la SORTIE (dernière ligne == 1), pas via l'exit code — SQLite
        // renvoie 0 même pour un booléen faux. Un exit non-zéro = vraie erreur SQL (syntaxe, table
        // manquante…) → échec, message = stderr.
        if ("sqlite3".equals(assembled.runtime())) {
            return sqlResult(testCase.name(), weight, run, nonce);
        }

        // Verdict ANTI-TRICHE : réussi SEULEMENT si le harnais a émis le nonce secret (sur stderr ;
        // stdout par sécurité). Un exit(0) anticipé ou une neutralisation d'exit n'émet pas le nonce
        // → échec. Un signal (timeout/OOM) → échec. Le noteur sort aussi en 0 — chaque noteur ne
        // le fait que sur un harnais vrai : un nonce obtenu par un autre chemin (le code soumis
        // partage le stderr) ne suffit plus si le harnais, lui, a rendu faux.
        boolean passed = run != null && run.signal() == null
                && Integer.valueOf(0).equals(run.code())
                && (contains(run.stderr(), nonce) || contains(run.stdout(), nonce));
        return new TestResult(testCase.name(), weight, passed, passed ? null : runFailureDetail(run));
    }

    /**
     * Budget d'une correction interprétée, plafonné selon l'appelant comme le mur du chemin
     * compilé : une correction interne a droit au budget complet, un « Tester » public est borné
     * au même plafond que les compilés (PUBLIC_WALL_MS) — la route accepte jusqu'à 100 cas
     * fournis par l'appelant.
     */
    long interpretedBudgetMs() {
        return limiter.isInternal() ? interpretedBudgetMs
                : Math.min(interpretedBudgetMs, DockerEvaluator.PUBLIC_WALL_MS);
    }

    /**
     * SQL en mode « modification » — exécution en DEUX PHASES ISOLÉES :
     * <ol>
     *   <li>Phase 1 : le code étudiant tourne dans un bac à sable JETABLE (tables de travail seules,
     *       aucune donnée de référence ni verdict) ; on récupère un DUMP de l'état final.</li>
     *   <li>Phase 2 : un NOTEUR séparé recharge cet état réduit aux seules tables de travail du prof
     *       ({@code CREATE TABLE}/{@code INSERT}, cf. {@link CodeAssembler#filterDumpToData}, qui
     *       refuse un schéma réécrit pour cacher d'autres instructions) — ni vue, ni déclencheur,
     *       ni {@code PRAGMA} de l'étudiant ne s'y exécute — puis lance la référence + le verdict
     *       du prof.</li>
     * </ol>
     * Le SQL de l'étudiant ne s'exécute JAMAIS dans le processus qui note : l'isolation est
     * structurelle (processus/base) ; le seul texte étudiant qui passe en phase 2 est le dump,
     * réduit à des définitions de tables et des INSERT découpés comme les découpe SQLite.
     */
    private TestResult runSqlIsolated(String code, TestCaseInput testCase,
            String nonce, int weight, Integer timeoutMs) {
        // Phase 1 — bac à sable. Son nonce n'est PAS celui du verdict (#23) : le code soumis tourne
        // dans ce programme, et même s'il parvenait à y lire les sentinelles du dump, il n'en
        // tirerait rien qui vaille en phase 2.
        String dumpNonce = newNonce();
        CodeAssembler.Assembled p1 = assembler.assembleSqlPhase1(code, testCase.harnessCode(), dumpNonce);
        RunnerExec.Stage run1 = execute("sqlite3", p1.files(), null, timeoutMs).run();
        if (run1 == null || run1.signal() != null) {
            return new TestResult(testCase.name(), weight, false,
                    "Interrompu en phase 1 (dépassement de temps ou de mémoire probable)");
        }
        if (run1.code() != null && run1.code() != 0) {
            // Erreur en phase 1 = le code de L'ÉTUDIANT ; on lui remonte son stderr (utile à déboguer).
            return new TestResult(testCase.name(), weight, false,
                    firstNonBlank(run1.stderr(), run1.message(), "Erreur SQL (ton code)"));
        }
        String dump = linesBetween(run1.stdout(),
                CodeAssembler.sqlDumpStart(dumpNonce), CodeAssembler.sqlDumpEnd(dumpNonce));
        if (dump == null) {
            return new TestResult(testCase.name(), weight, false, "État de la base introuvable après ton code");
        }
        // Sortie TRONQUÉE par le superviseur (au-delà de son plafond en OCTETS, il garde la tête et
        // la queue) : les deux sentinelles survivent, mais le dump a perdu son milieu, et la
        // phase 2 aurait noté un état partiel — une ligne fautive retirée par la coupe passait
        // pour supprimée (#23). La borne en caractères ci-dessous ne le voyait pas : des
        // caractères de 3 octets franchissent le plafond en octets bien avant elle. Refusé fermé ;
        // un code soumis qui imprime lui-même le marqueur ne pénalise que lui. Cherché DANS le
        // dump seulement : une coupe qui ampute l'état y laisse forcément sa ligne, alors qu'une
        // sortie de débogage géante AVANT le dump peut être tronquée sans toucher à l'état — la
        // refuser notait 0 une réponse juste.
        if (dump.length() > maxSqlDumpChars || dump.contains(SUPERVISOR_TRUNCATION_MARKER)) {
            return new TestResult(testCase.name(), weight, false, "État de la base trop volumineux");
        }
        // Liste blanche = tables déclarées par le prof ; découple le filtrage des internes de sqlite.
        String data = CodeAssembler.filterDumpToData(dump, CodeAssembler.sqlWorkingTables(testCase.harnessCode()));
        if (data == null) {
            // Schéma réécrit en phase 1 (writable_schema) pour faire exécuter du SQL en phase 2 :
            // refusé fermé, jamais rejoué.
            return new TestResult(testCase.name(), weight, false, "État de la base invalide après ton code");
        }

        // Phase 2 — noteur isolé. Une erreur ici vient du HARNAIS (prof) : message générique, on ne
        // fuit pas son stderr (structure des tables de référence) à l'étudiant.
        CodeAssembler.Assembled p2 = assembler.assembleSqlPhase2(data, testCase.harnessCode(), nonce);
        RunnerExec.Stage run2 = execute("sqlite3", p2.files(), null, timeoutMs).run();
        if (run2 != null && run2.signal() != null) {
            return new TestResult(testCase.name(), weight, false,
                    "Interrompu en phase 2 (dépassement de temps ou de mémoire probable)");
        }
        if (run2 == null || (run2.code() != null && run2.code() != 0)) {
            return new TestResult(testCase.name(), weight, false, "Le harnais n'a pas pu évaluer ton résultat");
        }
        return sqlResult(testCase.name(), weight, run2, nonce);
    }

    private static boolean contains(String haystack, String needle) {
        return haystack != null && haystack.contains(needle);
    }

    /**
     * Verdict d'un test SQL : réussi si la valeur du verdict vaut « 1 ». Le verdict est lu UNIQUEMENT
     * entre les sentinelles {@code <nonce>_VERDICT_START}/{@code _END} (cf. CodeAssembler) : tout ce
     * que l'étudiant a pu afficher arrive avant et est ignoré, et il ne peut pas forger le nonce.
     * Sentinelles absentes (ex. un {@code /*} qui les a avalées) → échec.
     */
    private static TestResult sqlResult(String name, int weight, RunnerExec.Stage run, String nonce) {
        if (run == null) {
            return new TestResult(name, weight, false, "Aucune sortie SQL");
        }
        if (run.signal() != null) {
            return new TestResult(name, weight, false,
                    "Interrompu (signal " + run.signal() + ") — dépassement de temps ou de mémoire probable");
        }
        if (run.code() != null && run.code() != 0) {
            return new TestResult(name, weight, false,
                    firstNonBlank(run.stderr(), run.message(), "Erreur SQL"));
        }
        String verdict = sqlVerdict(run.stdout(), nonce);
        if (verdict == null) {
            return new TestResult(name, weight, false,
                    firstNonBlank(run.stderr(), "Verdict du harnais introuvable (sortie corrompue ?)"));
        }
        boolean passed = "1".equals(verdict);
        return new TestResult(name, weight, passed, passed ? null
                : "Le harnais a renvoyé faux (valeur : " + (verdict.isEmpty() ? "aucune" : verdict) + ")");
    }

    /**
     * Valeur du verdict SQL : dernière ligne non vide STRICTEMENT entre les deux sentinelles (chaîne
     * vide si aucune — ex. verdict NULL). {@code null} si les sentinelles sont absentes ou si celle
     * de début est en double (cf. {@link #linesBetween}).
     */
    private static String sqlVerdict(String stdout, String nonce) {
        String block = linesBetween(stdout, CodeAssembler.sqlVerdictStart(nonce), CodeAssembler.sqlVerdictEnd(nonce));
        if (block == null) {
            return null;
        }
        String verdict = "";
        for (String line : block.split("\n")) {
            if (!line.strip().isEmpty()) {
                verdict = line.strip();
            }
        }
        return verdict;
    }

    /**
     * Texte STRICTEMENT entre la ligne == {@code start} et la 1ʳᵉ ligne == {@code end} qui suit
     * (bornes exclues). {@code null} si l'une des sentinelles manque, ou si {@code start} figure
     * sur PLUS D'UNE ligne (#23) : le programme n'en imprime qu'une, une seconde ne peut venir que
     * d'une sortie forgée, et choisir l'une ou l'autre reviendrait à parier sur l'ordre. Sert à
     * isoler le dump (phase 1) et le verdict (phase unique / phase 2) de tout ce que l'étudiant a
     * pu afficher autour.
     */
    private static String linesBetween(String output, String start, String end) {
        if (output == null) {
            return null;
        }
        String[] lines = output.split("\n", -1);
        int s = -1;
        int e = -1;
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].strip();
            if (line.equals(start)) {
                if (s >= 0) {
                    return null;
                }
                s = i;
            } else if (s >= 0 && e == -1 && line.equals(end)) {
                e = i;
            }
        }
        if (s < 0 || e < 0) {
            return null;
        }
        return String.join("\n", java.util.Arrays.asList(lines).subList(s + 1, e));
    }

    /**
     * Compilation TUÉE (temps ou mémoire) : le superviseur la rend sans code, avec un signal.
     * Seul le code était lu : elle passait pour réussie, l'étape run manquait, et l'interface
     * affichait « Aucune sortie d'exécution » sans dire que la compilation avait été interrompue.
     */
    private static boolean compileKilled(RunnerExec.Stage compile) {
        return compile != null && compile.code() == null && compile.signal() != null;
    }

    private static boolean compileFailed(RunnerExec.Stage compile) {
        return compile != null
                && ((compile.code() != null && compile.code() != 0) || compileKilled(compile));
    }

    /** Compilation tuée : « Interrompu », comme une exécution tuée (le budget lit le signal, pas ce texte). */
    private static String compileFailureDetail(RunnerExec.Stage compile) {
        if (compileKilled(compile)) {
            return "Interrompu à la compilation (signal " + compile.signal()
                    + ") — dépassement de temps ou de mémoire probable";
        }
        // stdout EN DERNIER RECOURS : tsc écrit ses diagnostics sur la sortie standard, stderr
        // vide, et le détail se réduisait à « Échec de compilation », sans dire où.
        return firstNonBlank(compile.stderr(), compile.message(), compile.stdout(),
                "Échec de compilation");
    }

    /** Message d'échec exploitable pour le prof (signal = timeout/OOM, sinon stderr). */
    private static String runFailureDetail(RunnerExec.Stage run) {
        if (run == null) {
            return "Aucune sortie d'exécution";
        }
        if (run.signal() != null) {
            return "Interrompu (signal " + run.signal() + ") — dépassement de temps ou de mémoire probable";
        }
        return firstNonBlank(run.stderr(), run.message(), "Le harnais a renvoyé faux");
    }

    /** Sortie brute prête à renvoyer : null → "", et bornée pour éviter des charges utiles énormes. */
    private static String trim(String value) {
        if (value == null) {
            return "";
        }
        return value.length() > 20000 ? value.substring(0, 20000) + "\n… (sortie tronquée)" : value;
    }

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v.length() > 2000 ? v.substring(0, 2000) : v;
            }
        }
        return null;
    }
}
