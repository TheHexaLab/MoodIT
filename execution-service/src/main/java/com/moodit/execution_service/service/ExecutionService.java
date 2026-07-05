package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
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
 * ISOLÉE. (Résiduel connu : un étudiant qui LIT la source assemblée peut extraire le nonce/harnais
 * — non éliminable dans ce modèle sans passer au « juge par sortie ».)
 */
@Service
public class ExecutionService {

    private static final SecureRandom RNG = new SecureRandom();

    private final CodeAssembler assembler;
    private final PistonClient piston;

    public ExecutionService(CodeAssembler assembler, PistonClient piston) {
        this.assembler = assembler;
        this.piston = piston;
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
     * Exécute le code TEL QUEL (sans harnais) et renvoie sa sortie brute (stdout/stderr/exit).
     * Sert au bouton « play » des éditeurs — l'étudiant/prof voit sa sortie et, en cas d'exception,
     * la stack trace (stderr). Un échec du programme (exit ≠ 0) n'est PAS une erreur HTTP : la
     * sortie est renvoie normalement (200), c'est le résultat attendu du « run ».
     */
    public RunResult run(RunRequest request) {
        CodeAssembler.Assembled assembled = assembler.assembleRun(request.language(), request.code());
        PistonClient.Result result = piston.execute(assembled.pistonLanguage(), request.version(), assembled.files());

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
        CodeAssembler.Assembled assembled = assembler.assemble(language, code, testCase.harnessCode(), nonce);
        PistonClient.Result result = piston.execute(assembled.pistonLanguage(), version, assembled.files());
        int weight = testCase.effectiveWeight();

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
            return sqlResult(testCase.name(), weight, run);
        }

        // Verdict ANTI-TRICHE : réussi SEULEMENT si le harnais a émis le nonce secret (sur stderr ;
        // stdout par sécurité). Un exit(0) anticipé ou une neutralisation d'exit n'émet pas le nonce
        // → échec. Un signal (timeout/OOM) → échec.
        boolean passed = run != null && run.signal() == null
                && (contains(run.stderr(), nonce) || contains(run.stdout(), nonce));
        return new TestResult(testCase.name(), weight, passed, passed ? null : runFailureDetail(run));
    }

    private static boolean contains(String haystack, String needle) {
        return haystack != null && haystack.contains(needle);
    }

    /** Verdict d'un test SQL : réussi si la dernière ligne non vide de stdout vaut « 1 ». */
    private static TestResult sqlResult(String name, int weight, PistonClient.Stage run) {
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
        String last = lastNonBlank(run.stdout());
        boolean passed = "1".equals(last);
        return new TestResult(name, weight, passed, passed ? null
                : "Le harnais a renvoyé faux (dernière valeur : " + (last == null ? "aucune" : last) + ")");
    }

    /** Dernière ligne non vide d'une sortie (le verdict SQL, après d'éventuelles lignes de debug). */
    private static String lastNonBlank(String output) {
        if (output == null) {
            return null;
        }
        String[] lines = output.split("\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].strip();
            if (!line.isEmpty()) {
                return line;
            }
        }
        return null;
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
