package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonClient;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Évalue une soumission contre chaque harnais : assemble code+harnais, exécute dans Piston, en
 * déduit le verdict. Un harnais réussit si le programme se termine en {@code exit 0} SANS signal
 * (pas de timeout/OOM) et sans échec de compilation. Chaque test tourne dans une exécution Piston
 * ISOLÉE (indépendante des autres).
 */
@Service
public class ExecutionService {

    private final CodeAssembler assembler;
    private final PistonClient piston;

    public ExecutionService(CodeAssembler assembler, PistonClient piston) {
        this.assembler = assembler;
        this.piston = piston;
    }

    public List<TestResult> evaluate(EvaluateRequest request) {
        List<TestResult> results = new ArrayList<>();
        for (TestCaseInput testCase : request.testCases()) {
            results.add(runOne(request.language(), request.version(), request.code(), testCase));
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

    private TestResult runOne(String language, String version, String code, TestCaseInput testCase) {
        CodeAssembler.Assembled assembled = assembler.assemble(language, code, testCase.harnessCode());
        PistonClient.Result result = piston.execute(assembled.pistonLanguage(), version, assembled.files());
        int weight = testCase.effectiveWeight();

        // Échec de compilation (langages compilés) → test échoué, message = stderr de compilation.
        PistonClient.Stage compile = result.compile();
        if (compile != null && compile.code() != null && compile.code() != 0) {
            return new TestResult(testCase.name(), weight, false,
                    firstNonBlank(compile.stderr(), compile.message(), "Échec de compilation"));
        }

        PistonClient.Stage run = result.run();
        boolean passed = run != null && run.signal() == null && run.code() != null && run.code() == 0;
        return new TestResult(testCase.name(), weight, passed, passed ? null : runFailureDetail(run));
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
