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
 * Les ÉVÉNEMENTS du superviseur (compilation rejouée, erreur interne, cas sauté…) sont
 * journalisés côté serveur seulement : ils portent l'index du cas quand ils en concernent un
 * (pas {@code canari_incoherent}, qui porte sur tout le job), mais ne sont jamais annexés aux
 * verdicts et n'en modifient aucun. Des canaris incohérents, eux, invalident les verdicts (« Incohérence détectée »).
 */
@Component
public class DockerEvaluator {

    private static final Logger log = LoggerFactory.getLogger(DockerEvaluator.class);
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    /** Marge par cas pour le va-et-vient du superviseur (collecte, kill du groupe), ms. */
    private static final long PER_CASE_OVERHEAD_MS = 10_000;
    private static final long BASE_OVERHEAD_MS = 30_000;
    /**
     * Budget de COMPILATION PAR CAS — miroir de COMPILE_TIMEOUT_S du superviseur (90 s) :
     * chaque cas (harnais différent) recompile son projet. Beaucoup de cas lents peuvent
     * atteindre le plafond MAX_WALL_MS (15 min) — limite assumée, documentée dans le README.
     */
    private static final long COMPILE_BUDGET_MS = 90_000;
    /**
     * Budget de la LECTURE DES SIGNATURES du superviseur — miroir de son LIST_TIMEOUT_S.
     * C'est un processus de plus dans le même cas ({@code javap -p} sur les classes du code
     * soumis, pour générer les bouchons typés) : sans ce terme, le pire cas dépassait ce que
     * l'invariant ci-dessous budgète, et un cas lancé juste avant l'échéance se faisait tuer au
     * mur — tous les verdicts du job perdus.
     */
    private static final long LIST_BUDGET_MS = 5_000;
    /**
     * Outils C/C++ PAR CAS autour des deux compilations — miroir de {@code C_PROBE_BUDGET_S}
     * (20 s : délai TOTAL des sondes des noms réservés, {@code gcc -fsyntax-only}) et de
     * {@code NM_TIMEOUT_S} (10 s : {@code nm --defined-only} sur le binaire soumis) du
     * superviseur. Les sondes avaient chacune le délai d'une compilation (90 s) et {@code nm}
     * aussi, sans que le mur les compte.
     */
    private static final long C_TOOLS_BUDGET_MS = 30_000;
    /**
     * Préprocesseur seul ({@code gcc -E -fdirectives-only}), UNE fois par job en C/C++ — miroir
     * de {@code C_PREPROCESS_TIMEOUT_S} du superviseur (10 s).
     */
    private static final long C_PREPROCESS_BUDGET_MS = 10_000;
    private static final long DEFAULT_RUN_TIMEOUT_MS = 10_000;
    static final long MAX_WALL_MS = 15 * 60_000;
    /**
     * Plafond du mur pour un appel PUBLIC (« Tester » d'un prof). La route
     * {@code /exec/evaluate} est réservée aux ÉDITEURS DE QUIZ (enseignant/admin/gardien,
     * cf. PermissionService) mais accepte jusqu'à 100 cas fournis par l'appelant : sans
     * ce plafond, une seule requête tenait la place publique un quart d'heure, et un seul compte
     * éditeur pouvait refuser le sandbox à tout le monde en boucle. Au-delà, le superviseur rend des
     * verdicts partiels (« non exécuté : budget dépassé »), ce qui reste lisible pour le prof.
     */
    public static final long PUBLIC_WALL_MS = 4 * 60_000;
    /**
     * Verdicts des canaris acceptés (cf. canary_verdict, supervisor.py). « aucun » n'en fait pas
     * partie : le superviseur ne le rend que pour un job SANS canaris, et HarnessProjects.build
     * en ajoute toujours deux. Le recevoir veut dire « canaris non jugés » — exactement ce que la
     * garde ci-dessous refuse.
     */
    private static final java.util.Set<String> CANARY_VERDICTS =
            java.util.Set.of("ok", "indetermines", "incoherents");
    /**
     * Événements du FONCTIONNEMENT NORMAL du superviseur (compilation du code soumis faite une
     * fois par job, puis rejouée) : journalisés en DEBUG, pour ne pas noyer les vrais signaux.
     */
    static final java.util.Set<String> ROUTINE_EVENTS =
            java.util.Set.of("compilation_rejouee", "echec_compilation_rejoue");
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
     * Marqueur réservé des gabarits runtime (canaris {@code __MOODIT_A__}/{@code __MOODIT_B__})
     * et du marqueur de harnais {@code __MOODIT_HARNAIS__}. Le superviseur ne substitue les
     * gabarits que dans le fichier du harnais, jamais dans le fichier soumis : le refus est une
     * défense en profondeur. En Java, il évite aussi qu'un fichier soumis portant
     * {@code __MOODIT_HARNAIS__} soit pris pour le harnais et sauté (« Aucun fichier de code
     * soumis »). Rejet immédiat, verdict explicite, sans lancer de conteneur.
     */
    private static final String RESERVED_MARKER = "__MOODIT_";

    /**
     * Verdicts de rejet si {@code code} contient le marqueur réservé, sinon {@code null}.
     * À appeler AVANT de prendre une place du sandbox (aucun conteneur n'est nécessaire —
     * sous saturation, le rejet explicite vaut mieux qu'un 429).
     */
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
     * Verdicts explicites si un harnais est une VRAIE CLASSE DE TEST du framework, sinon
     * {@code null}. Comme {@link #reservedMarkerRejection}, à appeler AVANT de prendre une place
     * du sandbox : ce format n'est plus noté.
     *
     * <p>Il l'a été, dans une version intermédiaire de #116, et c'était un mauvais choix : le
     * harnais était compilé AVEC le code de l'étudiant, donc le processus qui détenait le secret
     * et calculait le verdict était celui que l'étudiant contrôle. Cinq canaux de forge y ont été
     * démontrés et fermés l'un après l'autre, et il en restait toujours un. Ce format n'a jamais
     * été déployé — aucune question existante n'en dépend — et le laisser vivre revenait à offrir
     * au prof un chemin dont on sait qu'il est contournable, sans qu'il le sache.
     */
    public static List<TestResult> frameworkHarnessRejection(String language,
            List<TestCaseInput> cases) {
        String runnerLanguage;
        try {
            runnerLanguage = HarnessProjects.runnerLanguage(language);
        } catch (RuntimeException e) {
            return null;   // langage non compilé : pas notre affaire
        }
        boolean any = cases.stream()
                .anyMatch(c -> frameworkMarkerFound(runnerLanguage, c.harnessCode()));
        if (!any) {
            return null;
        }
        return cases.stream()
                .map(c -> new TestResult(c.name(), c.effectiveWeight(), false,
                        frameworkMarkerFound(runnerLanguage, c.harnessCode())
                                ? "Ce harnais est une classe de test du framework ("
                                        + frameworkExample(runnerLanguage) + "). Cette forme "
                                        + "n'est plus notée : elle était compilée avec le code de "
                                        + "l'étudiant, qui pouvait donc forger son résultat. "
                                        + "Écrire à la place un CORPS qui renvoie un booléen, par "
                                        + "exemple « return Solution.solution() == 42; » — c'est "
                                        + "le gabarit proposé dans l'éditeur."
                                : "Non évalué : un autre harnais de cette question est une classe "
                                        + "de test du framework."))
                .toList();
    }

    /**
     * Refus amont d'un NOM DE CLASSE RÉSERVÉ (Java) : {@code harnais_rpc} porte la même clé de
     * fichier que le harnais du prof — qui écrasait alors le code soumis — et le préfixe
     * {@code Moodit} est celui des fichiers du superviseur, sautés à la copie. Dans les deux
     * cas, le verdict était « Aucun fichier de code soumis » : un 0 avec un message qui
     * n'explique pas la cause. Légal mais réservé → refus AVANT toute prise de place, avec le
     * nom fautif, comme pour le marqueur {@code __MOODIT_} et le format framework.
     *
     * <p>Java seulement : c'est le seul langage où le nom du fichier déposé vient de la classe
     * publique du code soumis — ailleurs, les noms de fichiers sont fixes.
     */
    public static List<TestResult> reservedNameRejection(String language, String code,
            List<TestCaseInput> cases) {
        String runnerLanguage;
        try {
            runnerLanguage = HarnessProjects.runnerLanguage(language);
        } catch (RuntimeException e) {
            return null;   // langage non compilé : pas notre affaire
        }
        if (!"java".equals(runnerLanguage)) {
            return null;
        }
        String className = HarnessProjects.javaTypeName(code == null ? "" : code);
        if (className == null) {
            return null;
        }
        String detail;
        if (HarnessProjects.javaTypeNameUnsafe(className)) {
            // Testé AVANT la longueur : le nom n'est pas cité (il porte un caractère de contrôle).
            detail = "Le nom de classe contient un caractère de contrôle ou invisible : il sert "
                    + "de nom de fichier. Retaper le nom — par exemple « Solution » — et "
                    + "resoumettre.";
        } else if (HarnessProjects.javaTypeNameTooLong(className)) {
            // Le nom devient un nom de fichier : au-delà de la limite du système de fichiers, le
            // dépôt dans le conteneur échouait (502, tentative supprimée) au lieu d'une note.
            detail = "Le nom de classe « " + className.substring(0, className.offsetByCodePoints(0, 40)) + "… » est trop long "
                    + "(plus de " + HarnessProjects.MAX_JAVA_TYPE_NAME_BYTES + " octets) : il "
                    + "sert de nom de fichier. Raccourcir le nom — par exemple « Solution » — et "
                    + "resoumettre.";
        } else if (className.startsWith("Moodit") || "harnais_rpc".equals(className)) {
            detail = "Le nom de classe « " + className + " » est réservé par la notation "
                    + "(« harnais_rpc » et le préfixe « Moodit » appartiennent aux fichiers du "
                    + "superviseur). Renommer la classe — par exemple « Solution » — et resoumettre.";
        } else {
            return null;
        }
        return cases.stream()
                .map(c -> new TestResult(c.name(), c.effectiveWeight(), false, detail))
                .toList();
    }

    /** Forme ATTENDUE, citée dans le diagnostic (lisible par un prof, contrairement à la regex). */
    private static String frameworkExample(String runnerLanguage) {
        return switch (runnerLanguage) {
            case "java" -> "@Test";
            case "csharp" -> "[Test]";
            case "go" -> "func TestXxx(t *testing.T)";
            case "rust" -> "#[test]";
            default -> "MOODIT_TEST(nom)";
        };
    }

    /**
     * Nombre de COMPILATIONS que le superviseur fera pour UN cas.
     *
     * <p>DEUX par cas — le noteur et le code soumis sont deux programmes séparés — et TROIS en
     * Java, où le code soumis est d'abord compilé seul pour que ses signatures soient lues sur
     * ses classes. Le mur du conteneur n'en budgétait qu'une : un cas lancé juste avant
     * l'échéance du budget, dont les compilations approchent leur propre plafond, se faisait
     * tuer au mur — tous les verdicts du job perdus, 502, tentative supprimée (la régression
     * #216). Ne dépend plus du contenu des cas : le format framework, seul à compiler un unique
     * projet, est retiré.
     */
    static long compilesPerCase(String runnerLanguage) {
        return "java".equals(runnerLanguage) ? 3 : 2;
    }

    /**
     * Délais des OUTILS que le superviseur lance pour UN cas, hors compilations : l'inventaire
     * {@code javap} ({@link #LIST_BUDGET_MS}, compté pour tous les langages — surestimer est sans
     * danger), plus en C/C++ les sondes des noms réservés et {@code nm} ({@link #C_TOOLS_BUDGET_MS}).
     * Chaque terme est multiplié par le nombre de cas : en oublier un rendait le mur plus court
     * que le pire cas réel (#216).
     */
    static long toolsPerCaseMs(String runnerLanguage) {
        return LIST_BUDGET_MS + (cFamily(runnerLanguage) ? C_TOOLS_BUDGET_MS : 0);
    }

    /** Délais des outils lancés UNE fois par job : le préprocesseur seul en C/C++. */
    static long toolsPerJobMs(String runnerLanguage) {
        return cFamily(runnerLanguage) ? C_PREPROCESS_BUDGET_MS : 0;
    }

    private static boolean cFamily(String runnerLanguage) {
        return "c".equals(runnerLanguage) || "cpp".equals(runnerLanguage);
    }

    /**
     * Ce harnais est-il un VRAI test du framework ? Faux = harnais booléen, qui prend le chemin
     * NON FALSIFIABLE (noteur dans un processus et un UID séparés, cf. HarnessProjects).
     */
    static boolean frameworkMarkerFound(String runnerLanguage, String harnessCode) {
        // Cherché sur le CODE seulement : un `// pas de @Test ici` ou une chaîne
        // "prof@Test.ca" dans un harnais booléen valide le faisait refuser, et toute la
        // question rendait 0 avec un diagnostic trompeur. Ce refus n'est qu'un diagnostic : un
        // vrai test framework qui y échapperait ne compilerait pas comme corps booléen.
        return harnessCode != null && frameworkMarker(runnerLanguage)
                .matcher(HarnessProjects.withoutCommentsOrLiterals(harnessCode)).find();
    }

    private static java.util.regex.Pattern frameworkMarker(String runnerLanguage) {
        return switch (runnerLanguage) {
            // Toutes les formes idiomatiques, y compris PARAMÉTRÉES et qualifiées : un contrôle
            // littéral rejetait « [TestCase(3, 4)] » (NUnit) et « @ParameterizedTest » (JUnit 5),
            // pourtant parfaitement valides — l'étudiant recevait alors 0 avec un diagnostic faux.
            // Qualification bornee a huit segments : le moteur Java repete un groupe par recursion.
            case "java" -> java.util.regex.Pattern.compile(
                    "@\\s*(?:\\w+\\s*\\.\\s*){0,8}(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\\b");
            // Un ATTRIBUT, pas un indexeur : `tab[Test]`, `F()[Test]`, `d?[Test]`, `g()[0][Test]`
            // ou `"abc"[Test]` dans un corps booléen légitime faisait refuser toute la question.
            // Un attribut ouvre une DÉCLARATION : en début de ligne, ou après `{`, `}` ou `;`,
            // derrière d'autres attributs éventuels (`[Category("a")][Test]`), le marqueur en
            // tête ou après une virgule de la liste (`[Category("a"), Test]`). Un vrai test qui y
            // échapperait ne compilerait pas comme corps booléen : diagnostic au prof, pas de note.
            case "csharp" -> java.util.regex.Pattern.compile(
                    "(?m)(?:^|(?<=[{};]))[ \\t]*(?:\\[[^\\[\\]\\n]*\\][ \\t]*){0,8}"
                    + "\\[\\s*(?:[^\\[\\]\\n]*,\\s*)?(?:\\w+\\s*\\.\\s*){0,8}"
                    + "(?:Test|TestCase|TestCaseSource|Theory|TestFixture)\\b[^\\[\\]\\n]*\\]"
                    // ... SUIVI d'une déclaration (autre attribut, modificateur, ou type puis nom
                    // puis `(`) : un initialiseur d'index `{ [Mode.Test] = 3 }` ou un indexeur
                    // écrit en continuation (`[Test] == 3`) n'en sont pas (revue #246).
                    + "\\s*(?:\\[|(?:public|private|protected|internal|static|async|void|override"
                    + "|virtual|sealed|abstract|partial|class)\\b|[\\w.<>,?\\[\\]]+\\s+\\w+\\s*[(<])");
            case "go" -> java.util.regex.Pattern.compile("func\\s+Test\\w*\\s*\\(");
            case "rust" -> java.util.regex.Pattern.compile(
                    "#\\s*\\[\\s*(?:\\w+\\s*::\\s*){0,8}test\\s*\\]|#\\s*\\[\\s*cfg\\s*\\(\\s*test\\s*\\)");
            default -> java.util.regex.Pattern.compile("MOODIT_TEST\\s*\\(");   // c / cpp
        };
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
        Walls walls = walls(runnerLanguage, cases.size(), perRun, maxWallMs);
        HarnessProjects.Project project =
                HarnessProjects.build(language, code, cases, (int) perRun, walls.budgetMs());

        DockerSandbox.ContainerRun run = sandbox.run(imageFor(project.runnerLanguage()),
                project.files(), walls.wallMs());
        // Interne = tout appel qui n'est pas plafonne au mur PUBLIC (la correction d'une
        // soumission, ou la surcharge sans plafond). Seul ce chemin enregistre une note.
        return toResults(run, cases, maxWallMs > PUBLIC_WALL_MS);
    }

    /** Mur du conteneur et budget du superviseur d'un job de notation. */
    record Walls(long wallMs, long budgetMs) { }

    /**
     * Mur du conteneur, et budget du superviseur. INVARIANT :
     *     budget + pire cas d'UN cas + marge de clôture ≤ mur
     * Le superviseur ne teste son budget qu'AVANT de démarrer un cas : un cas lancé juste avant
     * l'échéance doit pouvoir aller jusqu'au bout (compilations + run) ET laisser le temps
     * d'imprimer le JSON — sans quoi le conteneur était tué au mur, tout le travail perdu, 502,
     * tentative supprimée.
     *
     * <p>Le budget porte un plancher PROPORTIONNEL (60 % du mur), en plus de la formule
     * stricte. Dériver le budget du seul pire cas THÉORIQUE (compilations au plafond de 90 s)
     * le faisait tomber à 1 s sous le plafond public de 4 min — le pire cas d'un SEUL cas y
     * dépasse le mur entier (295 s en Java) : le « Tester » du prof ne notait qu'un cas, voire
     * aucun quand un canari passait en premier, sur les six langages compilés.
     *
     * <p>Ce plancher ne joue que sur le chemin PUBLIC (mur plafonné à 4 min), où il remplace la
     * formule stricte : il relâche l'invariant budget + pireCas + marge ≤ mur, y compris là où
     * la formule stricte restait satisfiable (Go, Rust, C# : 15 s de budget strict avec le
     * temps limite par défaut ; C/C++ et Java, elle, cédait déjà). Assumé : la conséquence d'un
     * mur atteint y est un 502 sur le « Tester » du prof, sans tentative supprimée — le chemin
     * interne, lui, garde la formule stricte.
     */
    static Walls walls(String runnerLanguage, int caseCount, long perRunMs, long maxWallMs) {
        long perCase = perRunMs + PER_CASE_OVERHEAD_MS
                + compilesPerCase(runnerLanguage) * COMPILE_BUDGET_MS
                + toolsPerCaseMs(runnerLanguage);
        // Le préprocesseur du job tourne au PREMIER cas, pas à l'échéance : il entre dans le mur
        // (travail total), pas dans le pire cas d'un cas lancé juste avant l'échéance.
        long wallCandidate = BASE_OVERHEAD_MS + toolsPerJobMs(runnerLanguage)
                + (caseCount + 2L) * perCase;
        long cap = Math.min(maxWallMs, MAX_WALL_MS);
        long wall = Math.min(cap, wallCandidate);
        long strict = wall - perCase - CLOSING_MARGIN_MS;
        // Plancher proportionnel au seul chemin PUBLIC, comme le dit le javadoc : applique aussi
        // en interne, il l'emportait des 56 s de temps limite en Java (mur plafonne a 15 min) et
        // rompait l'invariant de quelques secondes — sur le seul chemin qui enregistre une note.
        long budget = Math.max(1_000,
                maxWallMs <= PUBLIC_WALL_MS ? Math.max(strict, wall * 3 / 5) : strict);
        return new Walls(wall, budget);
    }

    private List<TestResult> toResults(DockerSandbox.ContainerRun run, List<TestCaseInput> cases,
            boolean internal) {
        JsonNode root;
        try {
            root = MAPPER.readTree(run.stdout());
        } catch (RuntimeException e) {
            log.warn("Sortie du superviseur illisible (exit {}) : {}", run.exitCode(),
                    truncate(run.stderr()));
            throw deadSupervisor(run, "Réponse du superviseur de notation illisible");
        }
        // Jackson 3 ne lève PAS sur une sortie vide : readTree("") rend un MissingNode (et
        // « null » un NullNode). Sans cette garde, `results` était simplement vide, chaque cas
        // recevait « Notation incomplète » passed=false — une liste de verdicts VALIDE aux yeux
        // de core, qui persistait un 0 sur une tentative UNIQUE. Un superviseur mort sans JSON
        // (OOM du cgroup — les tmpfs comptent dans la mémoire —, image cassée) n'est pas une note :
        // 502 (cf. deadSupervisor pour sa cause ; une collecte des journaux expirée lève dès
        // DockerSandbox.run et n'arrive pas ici).
        if (!root.isObject()) {
            log.warn("Superviseur de notation muet (exit {}) : {}", run.exitCode(),
                    truncate(run.stderr()));
            throw deadSupervisor(run, "Le superviseur de notation n'a rendu aucun verdict (exit "
                    + run.exitCode() + ")");
        }
        if (root.has("error")) {
            throw new SandboxException("Superviseur de notation : " + root.get("error").asString());
        }
        // Notation INCOMPLETE : une erreur interne du superviseur en traitant le code soumis, ou un
        // cas INTERROMPU par la plateforme (cause « interrompu » côté superviseur : compilation
        // du noteur, inventaire javap, javac du serveur RPC Java ou sonde des noms réservés,
        // expirés ou tués). Ces
        // derniers arrivaient ici comme des verdicts ordinaires (passed=false) : un 0 définitif
        // que personne ne pouvait rejouer (regradeAttempt n'accepte que « à revoir »). Sur
        // le chemin interne, ce n'est pas une note (502, tentative a reprendre), mais c'est
        // COMPTE « sans verdict » (#116, S4). Seule la cause « erreur » peut venir du code soumis
        // (l'extraction des signatures et les bouchons le lisent) ; « interrompu » ne le peut pas
        // (bornes du superviseur, cf. platform_aborted), mais le drapeau « incomplet » ne sépare
        // pas les deux : un incident de plateforme compte donc aussi. Un bogue deterministe du superviseur sur
        // une soumission honnete finit ainsi « a revoir ». Un budget epuise, lui, reste une note partielle :
        // dans le conteneur l'attente de place a deja eu lieu, le budget ne mesure que le
        // travail, et son epuisement est reproductible. Le « Tester » garde ses verdicts.
        // Les canaris sont lus AVANT : un verdict de falsification ne doit jamais devenir une
        // tentative a reprendre. Le superviseur le garantit deja ; Java ne lui fait pas confiance
        // aveuglement (defense en profondeur, comme pour les verdicts ci-dessous).
        // Le verdict des canaris est EXIGÉ, et parmi les valeurs connues : le superviseur ne
        // transmet pas les résultats des canaris eux-mêmes, ce champ est donc tout ce que Java
        // peut relire. Absent ou inconnu (superviseur régressé, sortie d'un autre format), rien
        // ne dit que les canaris ont été jugés : c'est une panne (502), jamais une note —
        // sans cette garde, les « réussi » d'une telle sortie étaient acceptés tels quels.
        // Panne de PLATEFORME (cause « indisponible », non comptée contre l'étudiant) : le
        // superviseur émet toujours ce champ avec ses verdicts, dans le même print ; s'il manque
        // dans un JSON valide, c'est une image runner d'une autre version que le service
        // (build.sh non relancé après un déploiement), pas le code soumis.
        String canaries = root.path("canaries").asString("");
        if (!CANARY_VERDICTS.contains(canaries)) {
            log.warn("Verdict des canaris absent ou inconnu (« {} »)", truncate(canaries));
            throw new SandboxException(
                    "Réponse du superviseur de notation incomplète (verdict des canaris)");
        }
        boolean canariesInconsistent = "incoherents".equals(canaries);
        if (internal && !canariesInconsistent && root.path("incomplet").asBoolean(false)) {
            log.warn("Notation compilée incomplète (cause non imputable) : tentative à reprendre");
            throw new NoVerdictException(
                    "Notation incomplète (panne du noteur) : la tentative est à reprendre");
        }

        // Défense en PROFONDEUR : le superviseur neutralise déjà les verdicts quand les canaris
        // sont incohérents, mais Java ne doit pas lui faire confiance aveuglément — une
        // régression côté superviseur ne doit pas pouvoir produire un « réussi ».

        Map<Integer, JsonNode> byIndex = new HashMap<>();
        for (JsonNode result : root.path("results")) {
            byIndex.put(result.path("index").asInt(-1), result);
        }

        // Événements du superviseur : JOURNALISÉS, et rien de plus. Ils portent sur
        // l'INFRASTRUCTURE (espace_sature, budget_depasse, erreur_superviseur), sur la chaîne
        // de notation elle-même (canari_incoherent) ou, en DEBUG, sur son fonctionnement normal
        // (compilation du code soumis rejouée d'un cas à l'autre : un par cas, à chaque job) ;
        // le verdict du cas, lui, vient du superviseur, et une incohérence de canaris est
        // traitée plus bas pour TOUS les cas. Il n'y a plus d'événement qui accuse un cas en
        // particulier : les lectures tracées, les jetons manquants et les rapports incohérents
        // appartenaient au format framework, retiré de #116.
        for (JsonNode event : root.path("events")) {
            String type = event.path("type").asString("");
            if (ROUTINE_EVENTS.contains(type)) {
                log.debug("Notation compilée — {} (cas {})", type, event.path("case").asInt(-1));
                continue;
            }
            log.warn("Notation compilée — événement {} (cas {}) : {}",
                    type, event.path("case").asInt(-1), event.path("detail").asString(""));
        }

        List<TestResult> results = new ArrayList<>();
        for (int i = 0; i < cases.size(); i++) {
            TestCaseInput testCase = cases.get(i);
            JsonNode node = byIndex.get(i);
            boolean passed = node != null && node.path("passed").asBoolean(false);
            String detail = node == null ? "Notation incomplète (cas sans verdict)"
                    : (node.path("detail").isString() ? node.path("detail").asString() : null);
            if (canariesInconsistent && passed) {
                passed = false;
                detail = "⚠ Incohérence détectée pendant la notation (falsification probable)."
                        + (detail == null || detail.isBlank() ? "" : "\n" + detail);
            }
            results.add(new TestResult(testCase.name(), testCase.effectiveWeight(), passed, detail));
        }
        return results;
    }

    /**
     * Ligne témoin que le superviseur écrit sur SON stderr juste avant de prendre en charge le
     * code soumis (miroir de {@code SUBMITTED_CODE_STAGE} dans {@code supervisor.py}).
     */
    static final String SUBMITTED_CODE_STAGE = "moodit-supervisor: submitted-code-stage";

    /**
     * Exception d'un superviseur mort sans verdict (sortie vide ou illisible), dans les deux
     * modes. Cause « sans verdict », comptée par core contre l'étudiant (#116, S4), seulement si
     * le superviseur avait pris en charge le code soumis : sa ligne témoin est alors dans son
     * stderr, et le code soumis a pu provoquer la mort. Sans elle, il est mort pendant sa propre
     * mise en place (image cassée, job non reçu, version incompatible), avant qu'aucun code
     * soumis ne tourne : panne de plateforme, cause « indisponible ». Le code soumis ne peut
     * pas effacer la ligne : ses sorties vont dans des tubes et des fichiers, jamais sur le
     * stderr du superviseur.
     */
    static SandboxException deadSupervisor(DockerSandbox.ContainerRun run, String message) {
        logSupervisorOomKill(run);
        if (run.stderr() == null || !run.stderr().contains(SUBMITTED_CODE_STAGE)) {
            return new SandboxException(message + " — avant la prise en charge du code soumis");
        }
        return new NoVerdictException(message);
    }

    /**
     * S3 (#116) : un superviseur tué par l'OOM — sortie 137 et {@code State.OOMKilled} — signale
     * une isolation ROMPUE (il est à oom_score_adj -1000 et le code soumis ne peut plus abaisser le
     * sien). Journalisé à part, en erreur, pour être vu et corrigé ; la réponse reste un 502.
     */
    static void logSupervisorOomKill(DockerSandbox.ContainerRun run) {
        if (run.supervisorOomKilled()) {
            log.error("Superviseur de notation TUÉ PAR L'OOM (exit 137, OOMKilled) : isolation "
                    + "rompue, le superviseur devait rester hors d'atteinte de l'OOM");
        }
    }

    private static String truncate(String value) {
        if (value == null) {
            return "";
        }
        return value.length() > 1000 ? value.substring(0, 1000) + "…" : value;
    }
}
