package com.moodit.execution_service.service;

import com.moodit.execution_service.assembly.CodeAssembler;
import com.moodit.execution_service.dto.EvaluateRequest;
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

    private static String firstNonBlank(String... values) {
        for (String v : values) {
            if (v != null && !v.isBlank()) {
                return v.length() > 2000 ? v.substring(0, 2000) : v;
            }
        }
        return null;
    }
}
