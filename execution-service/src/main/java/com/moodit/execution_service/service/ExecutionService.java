package com.moodit.execution_service.service;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.StructuredCase;
import com.moodit.execution_service.dto.StructuredEvaluateRequest;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

/**
 * Évalue une soumission contre chaque harnais : assemble code+harnais, exécute dans Piston, en
 * déduit le verdict. ANTI-TRICHE : le verdict ne dépend PAS de l'exit code (falsifiable par un
 * {@code exit(0)} anticipé ou une neutralisation d'exit), mais de la présence d'un NONCE ALÉATOIRE
 * secret que SEUL le harnais émet en cas de succès. Chaque test tourne dans une exécution Piston
 * ISOLÉE. Interprétés comme compilés sont notés en DEUX processus : le code étudiant vit dans un
 * processus SÉPARÉ et ne voit jamais le nonce (détenu par le noteur ; cf. {@link CodeAssembler}).
 * Pour les compilés, le binaire unique se dédouble (fork / re-exec) et le nonce est injecté au RUNTIME
 * via l'entrée standard, lue par le seul PARENT. Un étudiant ne peut donc l'extraire : il n'est ni
 * dans sa mémoire (processus distinct), ni dans la source, ni dans le binaire.
 */
@Service
public class ExecutionService {

    private static final SecureRandom RNG = new SecureRandom();
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final CodeAssembler assembler;
    private final PistonClient piston;
    private final ExecutionLimiter limiter;

    /** Taille max du dump d'état transféré phase 1 → phase 2 (borne anti-DoS). Configurable. */
    @Value("${app.sql.max-dump-chars:524288}")
    private int maxSqlDumpChars = 524288;

    /** Sans borne de charge effective (tests unitaires de la logique de verdict). */
    public ExecutionService(CodeAssembler assembler, PistonClient piston) {
        this(assembler, piston, new ExecutionLimiter(Integer.MAX_VALUE, 0, Integer.MAX_VALUE));
    }

    @Autowired
    public ExecutionService(CodeAssembler assembler, PistonClient piston, ExecutionLimiter limiter) {
        this.assembler = assembler;
        this.piston = piston;
        this.limiter = limiter;
    }

    /** Un appel au sandbox, dans une place de la limite globale (#24) : file bornée, sinon 429. */
    private PistonClient.Result execute(String language, String version, List<PistonClient.File> files) {
        return execute(language, version, files, null);
    }

    /** Variante avec {@code stdin} (secret injecté au runtime pour les langages compilés). */
    private PistonClient.Result execute(String language, String version, List<PistonClient.File> files,
            String stdin) {
        return limiter.withSandboxSlot(() -> piston.execute(language, version, files, stdin));
    }

    /** Jeton aléatoire imprévisible, injecté dans le harnais et vérifié en sortie. */
    private static String newNonce() {
        byte[] bytes = new byte[24];
        RNG.nextBytes(bytes);
        return "MOODIT_OK_" + HexFormat.of().formatHex(bytes);
    }

    public List<TestResult> evaluate(EvaluateRequest request) {
        List<TestResult> results = new ArrayList<>();
        for (TestCaseInput testCase : request.testCases()) {
            // Un nonce DIFFÉRENT par harnais : imprévisible d'un test à l'autre.
            results.add(runOne(request.language(), request.version(), request.code(), testCase, newNonce()));
        }
        return results;
    }

    /**
     * Évalue une question par CAS STRUCTURÉS (#116). Le code étudiant est assemblé en SERVEUR qui
     * ÉVALUE les EXPRESSIONS des cas (sans harnais, sans nonce) et émet, par cas et dans l'ordre, DEUX
     * lignes : statut (1=ok, 0=exception) puis la valeur en texte. On exécute UNE fois (Piston est
     * one-shot), puis on compare ICI chaque valeur à l'attendu — qui ne touche JAMAIS le sandbox. Le
     * verdict et les attendus restent donc hors de portée de l'étudiant, quel que soit le langage.
     */
    public List<TestResult> evaluateStructured(StructuredEvaluateRequest request) {
        List<CodeAssembler.ServerCase> serverCases = request.cases().stream()
                .map(c -> new CodeAssembler.ServerCase(c.expr(), kindOf(c.expected())))
                .toList();
        CodeAssembler.Assembled asm =
                assembler.assembleServer(request.language(), request.code(), serverCases);
        PistonClient.Result result = execute(asm.pistonLanguage(), request.version(), asm.files());

        // Échec de compilation → tous les cas échouent avec le message de compilation.
        PistonClient.Stage compile = result.compile();
        if (compile != null && compile.code() != null && compile.code() != 0) {
            String msg = firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation");
            return request.cases().stream()
                    .map(c -> new TestResult(c.name(), c.effectiveWeight(), false, msg)).toList();
        }

        PistonClient.Stage run = result.run();
        // Deux lignes par cas : statut (1/0) puis valeur. split(-1) conserve les lignes vides.
        String[] lines = (run == null || run.stdout() == null) ? new String[0] : run.stdout().split("\n", -1);
        List<TestResult> out = new ArrayList<>();
        for (int i = 0; i < request.cases().size(); i++) {
            StructuredCase c = request.cases().get(i);
            int weight = c.effectiveWeight();
            if (run != null && run.signal() != null) {
                out.add(new TestResult(c.name(), weight, false,
                        "Interrompu (signal " + run.signal() + ") — dépassement de temps ou de mémoire probable"));
                continue;
            }
            if (2 * i + 1 >= lines.length) {
                out.add(new TestResult(c.name(), weight, false,
                        firstNonBlank(run == null ? null : run.stderr(), "Aucune réponse du serveur pour ce cas")));
                continue;
            }
            String status = lines[2 * i].trim();
            String payload = lines[2 * i + 1];
            if (!"1".equals(status)) {
                out.add(new TestResult(c.name(), weight, false,
                        "L'expression a échoué (exception/panique) pour ce cas"));
                continue;
            }
            JsonNode value;
            try {
                value = MAPPER.readTree(payload);
            } catch (RuntimeException e) {
                // Valeur non-JSON (chaîne brute émise par un serveur sans lib JSON) → traitée en chaîne.
                value = MAPPER.readTree(MAPPER.writeValueAsString(payload));
            }
            boolean passed = jsonMatches(value, c.expected(), c.compareMode());
            out.add(new TestResult(c.name(), weight, passed, passed ? null
                    : "Attendu " + c.expected() + ", obtenu " + value));
        }
        return out;
    }

    /** Kind de l'attendu (pour l'émission typée des serveurs C/C++) : int/double/bool/string. */
    private static String kindOf(JsonNode expected) {
        if (expected == null) return "string";
        // Composé : le kind vient de la borne de la 1re condition (bornes supposées de même nature).
        if (expected.isObject() && expected.has("conditions")) {
            JsonNode conds = expected.path("conditions");
            return (conds.isArray() && !conds.isEmpty())
                    ? kindOf(parseConditionValue(conds.get(0).path("value")))
                    : "string";
        }
        if (expected.isBoolean()) return "bool";
        if (expected.isIntegralNumber()) return "int";
        if (expected.isNumber()) return "double";
        return "string";
    }



    /** Compare une sortie à l'attendu selon le mode : {@code exact}, {@code unordered} (collection sans
     *  ordre), les relationnels {@code gt}/{@code ge}/{@code lt}/{@code le} (la borne — l'attendu —
     *  reste hors sandbox), {@code ne} (différent), {@code contains}/{@code regex} (sur chaîne) et
     *  {@code compound} (combinaison ET/OU). Les comparaisons numériques sont faites sur la valeur
     *  ({@code 10} vaut {@code 10.0}) ; une marge de tolérance s'exprime en composant une plage
     *  ({@code ge a} ET {@code le b}). */
    private static boolean jsonMatches(JsonNode actual, JsonNode expected, String mode) {
        if (actual == null) actual = MAPPER.nullNode();
        if (expected == null) expected = MAPPER.nullNode();
        switch (mode) {
            case "unordered":
                if (!actual.isArray() || !expected.isArray() || actual.size() != expected.size()) {
                    return actual.equals(expected);
                }
                List<String> a = new ArrayList<>();
                List<String> b = new ArrayList<>();
                actual.forEach(n -> a.add(n.toString()));
                expected.forEach(n -> b.add(n.toString()));
                a.sort(null);
                b.sort(null);
                return a.equals(b);
            case "gt":
            case "ge":
            case "lt":
            case "le": {
                // Relationnels : n'ont de sens qu'entre nombres ; sinon, inconcluant → échec.
                if (!actual.isNumber() || !expected.isNumber()) return false;
                double d = actual.asDouble();
                double e = expected.asDouble();
                return switch (mode) {
                    case "gt" -> d > e;
                    case "ge" -> d >= e;
                    case "lt" -> d < e;
                    default -> d <= e; // le
                };
            }
            case "ne":
                if (actual.isNumber() && expected.isNumber()) return actual.asDouble() != expected.asDouble();
                return !actual.equals(expected);
            case "contains":
                // Sous-chaîne : la valeur (texte) contient l'attendu (texte, la borne cachée).
                return asPlainString(actual).contains(asPlainString(expected));
            case "regex":
                // Recherche d'un motif (java.util.regex) dans la valeur ; ancrer avec ^…$ pour un
                // match complet. Motif invalide → échec (jamais d'exception qui casserait la notation).
                try {
                    return java.util.regex.Pattern.compile(asPlainString(expected))
                            .matcher(asPlainString(actual)).find();
                } catch (java.util.regex.PatternSyntaxException e) {
                    return false;
                }
            case "compound":
                return matchesCompound(actual, expected);
            default: // exact
                if (actual.isNumber() && expected.isNumber()) return actual.asDouble() == expected.asDouble();
                return actual.equals(expected);
        }
    }

    /**
     * Comparaison COMPOSÉE : {@code expected} = {@code {"conditions":[{"compare","value"}…],
     * "connectors":["and"|"or"…]}}. Chaque sous-condition est évaluée contre {@code actual} (via
     * {@link #jsonMatches}), puis combinée avec priorité ET &gt; OU, sans parenthèses : des groupes
     * ET reliés par des OU. Liste vide / forme invalide → échec. L'attendu (les bornes) reste hors
     * sandbox comme pour un cas simple.
     */
    private static boolean matchesCompound(JsonNode actual, JsonNode expected) {
        JsonNode conds = expected == null ? null : expected.path("conditions");
        if (conds == null || !conds.isArray() || conds.isEmpty()) return false;
        JsonNode conns = expected.path("connectors");
        boolean orAcc = false;
        boolean andAcc = evalCondition(actual, conds.get(0));
        for (int k = 1; k < conds.size(); k++) {
            String conn = (k - 1 < conns.size()) ? conns.get(k - 1).asString() : "and";
            if ("or".equalsIgnoreCase(conn)) {
                orAcc = orAcc || andAcc;   // ferme le groupe ET courant, en ouvre un nouveau
                andAcc = evalCondition(actual, conds.get(k));
            } else {
                andAcc = andAcc && evalCondition(actual, conds.get(k));
            }
        }
        return orAcc || andAcc;
    }

    /** Évalue UNE sous-condition {@code {compare, value}} ({@code value} = texte JSON, comme un attendu simple). */
    private static boolean evalCondition(JsonNode actual, JsonNode cond) {
        if (cond == null) return false;
        String cmp = cond.path("compare").asString();
        if (cmp == null || cmp.isBlank()) cmp = "exact";
        return jsonMatches(actual, parseConditionValue(cond.path("value")), cmp.toLowerCase(java.util.Locale.ROOT));
    }

    /** La borne d'une sous-condition est stockée en TEXTE JSON : on la parse (repli : chaîne brute). */
    private static JsonNode parseConditionValue(JsonNode valueNode) {
        if (valueNode == null || valueNode.isMissingNode() || valueNode.isNull()) return MAPPER.nullNode();
        if (valueNode.isString()) {
            try {
                return MAPPER.readTree(valueNode.asString());
            } catch (RuntimeException e) {
                return valueNode; // valeur non-JSON → comparée comme chaîne
            }
        }
        return valueNode;
    }

    /** Texte « nu » d'un nœud pour les comparaisons de chaîne : contenu si c'est une chaîne JSON,
     *  sinon sa forme JSON (ex. {@code 123}). Null/absent → chaîne vide. */
    private static String asPlainString(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) return "";
        return n.isString() ? n.asString() : n.toString();
    }

    /**
     * Exécute le code TEL QUEL (sans harnais) et renvoie sa sortie brute (stdout/stderr/exit).
     * Sert au bouton « play » des éditeurs — l'étudiant/prof voit sa sortie et, en cas d'exception,
     * la stack trace (stderr). Un échec du programme (exit ≠ 0) n'est PAS une erreur HTTP : la
     * sortie est renvoie normalement (200), c'est le résultat attendu du « run ».
     */
    public RunResult run(RunRequest request) {
        CodeAssembler.Assembled assembled = assembler.assembleRun(request.language(), request.code());
        PistonClient.Result result = execute(assembled.pistonLanguage(), request.version(), assembled.files());

        PistonClient.Stage compile = result.compile();
        String compileOutput = compile == null ? null : firstNonBlank(compile.stderr(), compile.stdout());
        // Échec de compilation (langages compilés) : pas d'étape run, on remonte la sortie de compil.
        if (compile != null && compile.code() != null && compile.code() != 0) {
            return new RunResult("",
                    firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation"),
                    compile.code(), compile.signal(), compileOutput, false);
        }

        PistonClient.Stage run = result.run();
        if (run == null) {
            return new RunResult("", "Aucune sortie d'exécution", null, null, compileOutput, false);
        }
        boolean timedOut = run.signal() != null;
        return new RunResult(trim(run.stdout()), trim(run.stderr()), run.code(), run.signal(),
                compileOutput, timedOut);
    }

    private TestResult runOne(String language, String version, String code, TestCaseInput testCase,
            String nonce) {
        int weight = testCase.effectiveWeight();

        // SQL en mode MODIFICATION (harnais avec « -- @student ») : exécution ISOLÉE en deux phases
        // (bac à sable jetable pour l'étudiant, puis noteur séparé). Cf. runSqlIsolated.
        if (CodeAssembler.isSql(language) && CodeAssembler.sqlHasStudentMarker(testCase.harnessCode())) {
            return runSqlIsolated(version, code, testCase, nonce, weight);
        }

        CodeAssembler.Assembled assembled = assembler.assemble(language, code, testCase.harnessCode(), nonce);
        // Langages compilés : le nonce est injecté au runtime via stdin — lu par le seul PROCESSUS
        // NOTEUR (parent), jamais par le processus qui exécute le code étudiant (cf. CodeAssembler).
        String stdin = CodeAssembler.isCompiled(language) ? nonce + "\n" : null;
        PistonClient.Result result = execute(assembled.pistonLanguage(), version, assembled.files(), stdin);

        // Échec de compilation (langages compilés) → test échoué, message = stderr de compilation.
        PistonClient.Stage compile = result.compile();
        if (compile != null && compile.code() != null && compile.code() != 0) {
            return new TestResult(testCase.name(), weight, false,
                    firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation"));
        }

        PistonClient.Stage run = result.run();

        // SQL : le verdict se lit sur la SORTIE (dernière ligne == 1), pas via l'exit code — SQLite
        // renvoie 0 même pour un booléen faux. Un exit non-zéro = vraie erreur SQL (syntaxe, table
        // manquante…) → échec, message = stderr.
        if ("sqlite3".equals(assembled.pistonLanguage())) {
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
    private TestResult runSqlIsolated(String version, String code, TestCaseInput testCase,
            String nonce, int weight) {
        // Phase 1 — bac à sable.
        CodeAssembler.Assembled p1 = assembler.assembleSqlPhase1(code, testCase.harnessCode(), nonce);
        PistonClient.Stage run1 = execute("sqlite3", version, p1.files()).run();
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
        // Liste blanche = tables déclarées par le prof ; découple le filtrage des internes de Piston.
        String data = CodeAssembler.filterDumpToData(dump, CodeAssembler.sqlWorkingTables(testCase.harnessCode()));

        // Phase 2 — noteur isolé. Une erreur ici vient du HARNAIS (prof) : message générique, on ne
        // fuit pas son stderr (structure des tables de référence) à l'étudiant.
        CodeAssembler.Assembled p2 = assembler.assembleSqlPhase2(data, testCase.harnessCode(), nonce);
        PistonClient.Stage run2 = execute("sqlite3", version, p2.files()).run();
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
    private static TestResult sqlResult(String name, int weight, PistonClient.Stage run, String nonce) {
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
    private static String runFailureDetail(PistonClient.Stage run) {
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
