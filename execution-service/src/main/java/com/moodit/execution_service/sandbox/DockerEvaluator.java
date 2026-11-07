package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Notation des langages COMPILÉS (#116) : construit le projet de test
 * ({@link HarnessProjects}), l'exécute dans un conteneur runner jetable ({@link DockerSandbox})
 * et traduit le JSON du superviseur en verdicts. FAIL-CLOSED : un cas absent de la réponse, un
 * JSON illisible ou des canaris incohérents ne deviennent JAMAIS un « réussi ».
 *
 * Les ÉVÉNEMENTS de détection du superviseur (lecture du harnais tentée, rapport forgé,
 * canaris incohérents) sont journalisés côté serveur et annexés au détail du cas concerné —
 * visibles du prof dans l'éditeur ; leur acheminement vers le journal d'audit est un suivi (#116).
 */
@Component
public class DockerEvaluator {

    private static final Logger log = LoggerFactory.getLogger(DockerEvaluator.class);
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    /** Marge par cas pour le va-et-vient du superviseur (strace, collecte, kill), ms. */
    private static final long PER_CASE_OVERHEAD_MS = 10_000;
    private static final long BASE_OVERHEAD_MS = 30_000;
    /**
     * Budget de COMPILATION PAR CAS — miroir de COMPILE_TIMEOUT_S du superviseur (90 s) :
     * chaque cas (harnais différent) recompile son projet. Beaucoup de cas lents peuvent
     * atteindre le plafond MAX_WALL_MS (15 min) — limite assumée, documentée dans le README.
     */
    private static final long COMPILE_BUDGET_MS = 90_000;
    private static final long DEFAULT_RUN_TIMEOUT_MS = 10_000;
    private static final long MAX_WALL_MS = 15 * 60_000;

    private final DockerSandbox sandbox;
    private final String imagePrefix;
    private final String imageTag;

    @org.springframework.beans.factory.annotation.Autowired
    public DockerEvaluator(DockerSandbox sandbox,
            @Value("${app.sandbox.image-prefix:moodit-runner-}") String imagePrefix,
            @Value("${app.sandbox.image-tag:latest}") String imageTag) {
        this.sandbox = sandbox;
        this.imagePrefix = imagePrefix;
        this.imageTag = imageTag;
    }

    public DockerSandbox sandbox() {
        return sandbox;
    }

    /** Image runner d'un langage canonique (C++ partage l'image C — même toolchain). */
    public String imageFor(String runnerLanguage) {
        String name = "cpp".equals(runnerLanguage) ? "c" : runnerLanguage;
        return imagePrefix + name + ":" + imageTag;
    }

    /**
     * Marqueur réservé des gabarits runtime (canaris {@code __MOODIT_A__}/{@code __MOODIT_B__},
     * jeton {@code __MOODIT_T__}) : le superviseur substitue ces gabarits dans TOUS les fichiers
     * du cas — code étudiant compris (en Rust il partage même le fichier du harnais). Un code
     * soumis qui contient ce préfixe recevrait donc les vraies valeurs : rejet immédiat, verdict
     * explicite, sans lancer de conteneur.
     */
    private static final String RESERVED_MARKER = "__MOODIT_";

    public List<TestResult> evaluate(String language, String code, List<TestCaseInput> cases,
            Integer timeoutMs) {
        if (code != null && code.contains(RESERVED_MARKER)) {
            return cases.stream()
                    .map(c -> new TestResult(c.name(), c.effectiveWeight(), false,
                            "Marqueur réservé « __MOODIT_ » dans le code soumis — retire-le pour être corrigé."))
                    .toList();
        }
        // Borné des DEUX côtés : une valeur stockée aberrante (négative, nulle, > 60 s) ne doit
        // jamais produire un mur négatif (SandboxException systématique) ni un job sans fin.
        long perRun = Math.min(Math.max(timeoutMs == null ? DEFAULT_RUN_TIMEOUT_MS : timeoutMs, 1),
                RunnerExec.MAX_RUN_TIMEOUT_MS);
        HarnessProjects.Project project = HarnessProjects.build(language, code, cases, (int) perRun);
        // Chaque cas (cas réels + 2 canaris) recompile SON harnais : compilation (budget du
        // superviseur) + run (temps limite du prof) + marge, PAR CAS.
        long wall = Math.min(MAX_WALL_MS,
                BASE_OVERHEAD_MS
                        + (cases.size() + 2L) * (perRun + PER_CASE_OVERHEAD_MS + COMPILE_BUDGET_MS));

        DockerSandbox.ContainerRun run = sandbox.run(imageFor(project.runnerLanguage()),
                project.files(), wall);
        return toResults(run, cases);
    }

    private List<TestResult> toResults(DockerSandbox.ContainerRun run, List<TestCaseInput> cases) {
        JsonNode root;
        try {
            root = MAPPER.readTree(run.stdout());
        } catch (RuntimeException e) {
            log.warn("Sortie du superviseur illisible (exit {}) : {}", run.exitCode(),
                    truncate(run.stderr()));
            throw new SandboxException("Réponse du superviseur de notation illisible");
        }
        if (root.has("error")) {
            throw new SandboxException("Superviseur de notation : " + root.get("error").asString());
        }

        Map<Integer, JsonNode> byIndex = new HashMap<>();
        for (JsonNode result : root.path("results")) {
            byIndex.put(result.path("index").asInt(-1), result);
        }

        // Événements de détection : journalisés, et annexés au détail du cas concerné.
        Map<Integer, String> eventByCase = new HashMap<>();
        for (JsonNode event : root.path("events")) {
            String type = event.path("type").asString("");
            String detail = event.path("detail").asString("");
            int caseIndex = event.path("case").asInt(-1);
            log.warn("Notation compilée — événement {} (cas {}) : {}", type, caseIndex, detail);
            if (isSuspicious(type) && caseIndex >= 0 && caseIndex < cases.size()) {
                eventByCase.merge(caseIndex, type, (a, b) -> a + ", " + b);
            }
        }

        List<TestResult> results = new ArrayList<>();
        for (int i = 0; i < cases.size(); i++) {
            TestCaseInput testCase = cases.get(i);
            JsonNode node = byIndex.get(i);
            boolean passed = node != null && node.path("passed").asBoolean(false);
            String detail = node == null ? "Notation incomplète (cas sans verdict)"
                    : (node.path("detail").isString() ? node.path("detail").asString() : null);
            String suspicious = eventByCase.get(i);
            if (suspicious != null) {
                // Une tentative de lecture détectée FAIT ÉCHOUER le cas — pas une simple
                // annotation : lire son propre binaire de test (seule voie d'extraction du
                // jeton sur les natifs) peut RÉUSSIR, et aucun code honnête ne le fait ;
                // toute ouverture de src/ au run est suspecte par construction (verrouillé).
                passed = false;
                detail = "⚠ Comportement suspect détecté (" + suspicious + ") — cas refusé."
                        + (detail == null || detail.isBlank() ? "" : "\n" + detail);
            }
            results.add(new TestResult(testCase.name(), testCase.effectiveWeight(), passed, detail));
        }
        return results;
    }

    private static boolean isSuspicious(String type) {
        return switch (type) {
            case "lecture_source_tentee", "lecture_binaire_tentee", "rapport_incoherent",
                 "canari_incoherent", "jeton_absent" -> true;
            default -> false;
        };
    }

    private static String truncate(String value) {
        if (value == null) {
            return "";
        }
        return value.length() > 1000 ? value.substring(0, 1000) + "…" : value;
    }
}
