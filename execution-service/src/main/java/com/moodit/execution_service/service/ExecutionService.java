package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;

import com.moodit.execution_service.sandbox.DockerEvaluator;
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
 *   <li><b>Interprétés / SQL / vues</b> → mode « exec » du runner (ex-Piston), verdict par NONCE ALÉATOIRE : il ne dépend PAS
 *       de l'exit code (falsifiable par un {@code exit(0)} anticipé), mais de la présence d'un
 *       nonce secret que SEUL le harnais émet en cas de succès ; le code étudiant vit dans un
 *       processus séparé qui ne voit jamais le nonce (cf. {@link CodeAssembler}).</li>
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

    /**
     * Plafond du budget configurable (24 h) : au-delà, la conversion en nanosecondes sature et
     * l'échéance déborde. Très au-dessus de tout réglage sensé — c'est un garde-fou, pas un
     * réglage ; le délai de lecture de core (ExecutionClient.EXEC_BUDGET_MS) reste la vraie borne.
     */
    private static final long MAX_BUDGET_MS = 24L * 60 * 60 * 1000;

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
        return limiter.withSandboxSlot(() -> runner.execute(runtime, files, stdin, timeoutMs));
    }

    /** Jeton aléatoire imprévisible, injecté dans le harnais et vérifié en sortie. */
    private static String newNonce() {
        byte[] bytes = new byte[24];
        RNG.nextBytes(bytes);
        return "MOODIT_OK_" + HexFormat.of().formatHex(bytes);
    }

    public List<TestResult> evaluate(EvaluateRequest request) {
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
            // Mur plafonné selon l'appelant : une correction interne a droit au budget complet,
            // un « Tester » public est borné (route réservée aux éditeurs de quiz, mais
            // jusqu'à 100 cas fournis par l'appelant).
            long maxWall = limiter.isInternal()
                    ? Long.MAX_VALUE : DockerEvaluator.PUBLIC_WALL_MS;
            return limiter.withSandboxSlot(() -> dockerEvaluator.evaluate(
                    request.language(), request.code(), request.testCases(), request.timeoutMs(),
                    maxWall));
        }
        // Budget plafonné selon l'appelant, comme le mur du chemin compilé : une correction
        // interne a droit au budget complet, un « Tester » public est borné au même plafond que
        // les compilés (PUBLIC_WALL_MS) — la route accepte jusqu'à 100 cas fournis par l'appelant.
        long budgetMs = limiter.isInternal() ? interpretedBudgetMs
                : Math.min(interpretedBudgetMs, DockerEvaluator.PUBLIC_WALL_MS);
        // Budget BORNÉ avant conversion : toNanos SATURE à Long.MAX_VALUE au-delà de ~292 ans,
        // et l'addition déborderait alors silencieusement en une échéance NÉGATIVE — déjà
        // dépassée, donc un seul harnais évalué sur cent. Une valeur de configuration absurde
        // doit être ramenée, pas transformée en corruption de note.
        long clampedBudgetMs = Math.max(0, Math.min(budgetMs, MAX_BUDGET_MS));
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.MILLISECONDS.toNanos(clampedBudgetMs);
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
                }
                results.add(new TestResult(testCase.name(), testCase.effectiveWeight(), false,
                        "Non évalué : budget d'évaluation dépassé (les harnais précédents ont "
                                + "consommé le temps alloué à cette correction)."));
                continue;
            }
            // Un nonce DIFFÉRENT par harnais : imprévisible d'un test à l'autre.
            results.add(runOne(request.language(), request.code(), testCase, newNonce(),
                    request.timeoutMs()));
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
        if (compile != null && compile.code() != null && compile.code() != 0) {
            return new RunResult("",
                    firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation"),
                    compile.code(), compile.signal(), compileOutput, false);
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
            String nonce, Integer timeoutMs) {
        int weight = testCase.effectiveWeight();

        // SQL en mode MODIFICATION (harnais avec « -- @student ») : exécution ISOLÉE en deux phases
        // (bac à sable jetable pour l'étudiant, puis noteur séparé). Cf. runSqlIsolated.
        if (CodeAssembler.isSql(language) && CodeAssembler.sqlHasStudentMarker(testCase.harnessCode())) {
            return runSqlIsolated(code, testCase, nonce, weight, timeoutMs);
        }

        CodeAssembler.Assembled assembled = assembler.assemble(language, code, testCase.harnessCode(), nonce);
        RunnerExec.Result result = execute(assembled.runtime(), assembled.files(), null, timeoutMs);

        // Échec de compilation (ex. TypeScript) → test échoué, message = stderr de compilation.
        RunnerExec.Stage compile = result.compile();
        if (compile != null && compile.code() != null && compile.code() != 0) {
            return new TestResult(testCase.name(), weight, false,
                    firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation"));
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
        // → échec. Un signal (timeout/OOM) → échec.
        boolean passed = run != null && run.signal() == null
                && (contains(run.stderr(), nonce) || contains(run.stdout(), nonce));
        return new TestResult(testCase.name(), weight, passed, passed ? null : runFailureDetail(run));
    }

    /**
     * SQL en mode « modification » — exécution en DEUX PHASES ISOLÉES :
     * <ol>
     *   <li>Phase 1 : le code étudiant tourne dans un bac à sable JETABLE (tables de travail seules,
     *       aucune donnée de référence ni verdict) ; on récupère un DUMP de l'état final.</li>
     *   <li>Phase 2 : un NOTEUR séparé recharge cet état réduit aux seules tables de travail du prof
     *       ({@code CREATE TABLE}/{@code INSERT}, cf. {@link CodeAssembler#filterDumpToData}) — donc
     *       aucun SQL étudiant ne s'y exécute — puis lance la référence + le verdict du prof.</li>
     * </ol>
     * Le SQL de l'étudiant ne s'exécute JAMAIS dans le processus qui note : l'isolation est
     * structurelle (processus/base), pas un filtrage lexical.
     */
    private TestResult runSqlIsolated(String code, TestCaseInput testCase,
            String nonce, int weight, Integer timeoutMs) {
        // Phase 1 — bac à sable.
        CodeAssembler.Assembled p1 = assembler.assembleSqlPhase1(code, testCase.harnessCode(), nonce);
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
                CodeAssembler.sqlDumpStart(nonce), CodeAssembler.sqlDumpEnd(nonce));
        if (dump == null) {
            return new TestResult(testCase.name(), weight, false, "État de la base introuvable après ton code");
        }
        if (dump.length() > maxSqlDumpChars) {
            return new TestResult(testCase.name(), weight, false, "État de la base trop volumineux");
        }
        // Liste blanche = tables déclarées par le prof ; découple le filtrage des internes de sqlite.
        String data = CodeAssembler.filterDumpToData(dump, CodeAssembler.sqlWorkingTables(testCase.harnessCode()));

        // Phase 2 — noteur isolé. Une erreur ici vient du HARNAIS (prof) : message générique, on ne
        // fuit pas son stderr (structure des tables de référence) à l'étudiant.
        CodeAssembler.Assembled p2 = assembler.assembleSqlPhase2(data, testCase.harnessCode(), nonce);
        RunnerExec.Stage run2 = execute("sqlite3", p2.files(), null, timeoutMs).run();
        if (run2 == null || run2.signal() != null || (run2.code() != null && run2.code() != 0)) {
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
     * vide si aucune — ex. verdict NULL). {@code null} si les sentinelles sont absentes.
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
     * Texte STRICTEMENT entre la 1ʳᵉ ligne == {@code start} et la 1ʳᵉ ligne == {@code end} qui suit
     * (bornes exclues). {@code null} si l'une des sentinelles manque. Sert à isoler le dump (phase 1)
     * et le verdict (phase unique / phase 2) de tout ce que l'étudiant a pu afficher autour.
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
            if (s < 0) {
                if (line.equals(start)) {
                    s = i;
                }
            } else if (line.equals(end)) {
                e = i;
                break;
            }
        }
        if (s < 0 || e < 0) {
            return null;
        }
        return String.join("\n", java.util.Arrays.asList(lines).subList(s + 1, e));
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
