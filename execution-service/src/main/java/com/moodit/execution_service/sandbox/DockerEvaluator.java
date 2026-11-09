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
    /**
     * Plafond du mur pour un appel PUBLIC (« Tester » d'un prof). La route
     * {@code /exec/evaluate} est réservée aux ÉDITEURS DE QUIZ (enseignant/admin/gardien,
     * cf. PermissionService) mais accepte jusqu'à 100 cas fournis par l'appelant : sans
     * ce plafond, une seule requête tenait la place publique un quart d'heure, et un étudiant
     * pouvait refuser le sandbox à tout le monde en boucle. Au-delà, le superviseur rend des
     * verdicts partiels (« non exécuté : budget dépassé »), ce qui reste lisible pour le prof.
     */
    public static final long PUBLIC_WALL_MS = 4 * 60_000;
    /** Marge laissée au superviseur pour clore et imprimer son JSON avant le mur. */
    private static final long CLOSING_MARGIN_MS = 20_000;

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

    /**
     * Verdicts de rejet si {@code code} contient le marqueur réservé, sinon {@code null}.
     * À appeler AVANT de prendre une place du sandbox (aucun conteneur n'est nécessaire —
     * sous saturation, le rejet explicite vaut mieux qu'un 429).
     */
    /**
     * Verdicts explicites si au moins un harnais est resté à l'ancien format, sinon
     * {@code null}. Comme {@link #reservedMarkerRejection}, à appeler AVANT de prendre une
     * place du sandbox : aucun conteneur ne peut rien en faire.
     */
    public static List<TestResult> legacyHarnessRejection(String language, List<TestCaseInput> cases) {
        String runnerLanguage;
        try {
            runnerLanguage = HarnessProjects.runnerLanguage(language);
        } catch (RuntimeException e) {
            return null;   // langage non compilé : pas notre affaire
        }
        boolean anyLegacy = cases.stream()
                .anyMatch(c -> legacyHarnessDetail(runnerLanguage, c.harnessCode()) != null);
        if (!anyLegacy) {
            return null;
        }
        return cases.stream()
                .map(c -> {
                    String detail = legacyHarnessDetail(runnerLanguage, c.harnessCode());
                    return new TestResult(c.name(), c.effectiveWeight(), false,
                            detail != null ? detail : "Non évalué : un autre harnais de cette "
                                    + "question est resté à l'ancien format.");
                })
                .toList();
    }

    public static List<TestResult> reservedMarkerRejection(String code, List<TestCaseInput> cases) {
        if (code == null || !code.contains(RESERVED_MARKER)) {
            return null;
        }
        return cases.stream()
                .map(c -> new TestResult(c.name(), c.effectiveWeight(), false,
                        "Marqueur réservé « __MOODIT_ » dans le code soumis — retire-le pour être corrigé."))
                .toList();
    }

    public List<TestResult> evaluate(String language, String code, List<TestCaseInput> cases,
            Integer timeoutMs) {
        return evaluate(language, code, cases, timeoutMs, MAX_WALL_MS);
    }

    /**
     * Marqueur OBLIGATOIRE d'un harnais au format « vrai test du framework » (#116), par
     * langage du runner. Un harnais d'avant cette version est un CORPS qui renvoie un booléen :
     * il ne compile pas dans le runner, et l'étudiant n'y lirait qu'un « Échec de compilation »
     * incompréhensible. V7 ne convertit que les gabarits (questions futures) : celles déjà en
     * base doivent être converties à la main, d'où ce diagnostic explicite.
     */
    private static java.util.regex.Pattern frameworkMarker(String runnerLanguage) {
        return switch (runnerLanguage) {
            // Toutes les formes idiomatiques, y compris PARAMÉTRÉES et qualifiées : un contrôle
            // littéral rejetait « [TestCase(3, 4)] » (NUnit) et « @ParameterizedTest » (JUnit 5),
            // pourtant parfaitement valides — l'étudiant recevait alors 0 avec un diagnostic faux.
            case "java" -> java.util.regex.Pattern.compile(
                    "@\\s*(?:\\w+\\s*\\.\\s*)*(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\\b");
            case "csharp" -> java.util.regex.Pattern.compile(
                    "\\[\\s*(?:\\w+\\s*\\.\\s*)*(?:Test|TestCase|TestCaseSource|Theory|TestFixture)\\b");
            case "go" -> java.util.regex.Pattern.compile("func\\s+Test\\w*\\s*\\(");
            case "rust" -> java.util.regex.Pattern.compile(
                    "#\\s*\\[\\s*(?:\\w+\\s*::\\s*)*test\\s*\\]|#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)");
            default -> java.util.regex.Pattern.compile("MOODIT_TEST\\s*\\(");   // c / cpp
        };
    }

    /** Forme ATTENDUE, citée dans le diagnostic (lisible par un prof, contrairement à la regex). */
    private static String frameworkExample(String runnerLanguage) {
        return switch (runnerLanguage) {
            case "java" -> "@Test (ou @ParameterizedTest…)";
            case "csharp" -> "[Test] (ou [TestCase(…)]…)";
            case "go" -> "func TestXxx(t *testing.T)";
            case "rust" -> "#[test]";
            default -> "MOODIT_TEST(nom)";
        };
    }

    /** Détail d'un harnais resté à l'ancien format, ou {@code null} s'il est au bon format. */
    static String legacyHarnessDetail(String runnerLanguage, String harnessCode) {
        if (harnessCode != null && frameworkMarker(runnerLanguage).matcher(harnessCode).find()) {
            return null;
        }
        return "Ce harnais est resté à l'ancien format (un corps qui renvoie un booléen). "
                + "Depuis #116, un harnais de langage compilé est un VRAI test du framework : "
                + "il doit déclarer un test (" + frameworkExample(runnerLanguage) + "). "
                + "À convertir dans l'éditeur de quiz.";
    }

    /** {@code maxWallMs} : plafond du mur du conteneur — {@link #PUBLIC_WALL_MS} hors correction interne. */
    public List<TestResult> evaluate(String language, String code, List<TestCaseInput> cases,
            Integer timeoutMs, long maxWallMs) {
        List<TestResult> rejected = reservedMarkerRejection(code, cases);
        if (rejected != null) {
            return rejected;
        }
        // Borné des DEUX côtés : une valeur stockée aberrante (négative, nulle, > 60 s) ne doit
        // jamais produire un mur négatif (SandboxException systématique) ni un job sans fin.
        long perRun = Math.min(Math.max(timeoutMs == null ? DEFAULT_RUN_TIMEOUT_MS : timeoutMs, 1),
                RunnerExec.MAX_RUN_TIMEOUT_MS);
        String runnerLanguage = HarnessProjects.runnerLanguage(language);
        if ("java".equals(runnerLanguage) || "csharp".equals(runnerLanguage)) {
            // Miroir du plancher VM du superviseur (JVM/mono froids) : le MUR doit couvrir le
            // temps réellement accordé par cas, pas le temps limite court du prof.
            perRun = Math.max(perRun, 10_000);
        }
        // Mur du conteneur, et budget du superviseur. INVARIANT :
        //     budget + pire cas d'UN cas + marge de clôture ≤ mur
        // Le superviseur ne teste son budget qu'AVANT de démarrer un cas : un cas lancé juste
        // avant l'échéance doit pouvoir aller jusqu'au bout (compilation + run) ET laisser le
        // temps d'imprimer le JSON. Une marge fixe plus courte qu'un cas laissait une fenêtre
        // où le conteneur était tué au mur — tout le travail perdu, 502, tentative supprimée.
        long perCase = perRun + PER_CASE_OVERHEAD_MS + COMPILE_BUDGET_MS;
        long wallCandidate = BASE_OVERHEAD_MS + (cases.size() + 2L) * perCase;
        long cap = Math.min(maxWallMs, MAX_WALL_MS);
        long wall = Math.min(cap, wallCandidate);
        long budget = Math.max(1_000, wall - perCase - CLOSING_MARGIN_MS);
        HarnessProjects.Project project =
                HarnessProjects.build(language, code, cases, (int) perRun, budget);

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

        // Défense en PROFONDEUR : le superviseur neutralise déjà les verdicts quand les canaris
        // sont incohérents, mais Java ne doit pas lui faire confiance aveuglément — une
        // régression côté superviseur ne doit pas pouvoir produire un « réussi ».
        boolean canariesIncoherents = "incoherents".equals(root.path("canaries").asString(""));

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
            if (canariesIncoherents && passed) {
                passed = false;
                detail = "⚠ Incohérence détectée pendant la notation (falsification probable)."
                        + (detail == null || detail.isBlank() ? "" : "\n" + detail);
            }
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
