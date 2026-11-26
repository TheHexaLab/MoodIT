package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

import org.mockito.ArgumentCaptor;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Traduction FAIL-CLOSED du JSON du superviseur en verdicts (#116) : un cas sans verdict, un JSON
 * cassé, un verdict de canaris absent ou inconnu, ou une erreur du superviseur ne deviennent
 * jamais un « réussi ». Les événements du superviseur sont journalisés côté serveur seulement :
 * ils portent l'index du cas quand ils en concernent un (pour le journal), mais ne sont jamais
 * annexés aux verdicts et n'en modifient aucun.
 */
class DockerEvaluatorTest {

    private final DockerSandbox sandbox = mock(DockerSandbox.class);
    private final DockerEvaluator evaluator = new DockerEvaluator(sandbox, "moodit-runner-", "latest");

    private static final List<TestCaseInput> TWO_CASES = List.of(
            new TestCaseInput("premier", "h1", 2),
            new TestCaseInput("second", "h2", 3));

    private void supervisorReturns(String json) {
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun(json, "", 0));
    }

    @Test
    void maps_verdicts_by_index_with_names_and_weights() {
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"name":"premier","passed":true,"detail":null,"ms":10},
                  {"index":1,"name":"second","passed":false,"detail":"attendu 12","ms":20}
                ],"events":[],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results).containsExactly(
                new TestResult("premier", 2, true, null),
                new TestResult("second", 3, false, "attendu 12"));
    }

    @Test
    void routine_compilation_replays_are_not_warnings() {
        // La compilation rejouée d'un cas à l'autre est émise à CHAQUE job compilé : en WARN,
        // elle noyait les vrais signaux (espace saturé, erreur du superviseur).
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(DockerEvaluator.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        ch.qos.logback.classic.Level saved = logger.getLevel();
        logger.setLevel(ch.qos.logback.classic.Level.DEBUG);
        logger.addAppender(appender);
        try {
            supervisorReturns("""
                    {"v":1,"results":[
                      {"index":0,"passed":true,"ms":1},{"index":1,"passed":false,"ms":1}
                    ],"events":[{"type":"compilation_rejouee","case":1},
                                {"type":"echec_compilation_rejoue","case":3},
                                {"type":"espace_sature","case":1,"detail":"plein"}],
                     "canaries":"ok"}
                    """);
            List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
            assertThat(results).extracting(TestResult::passed).containsExactly(true, false);
            // Journalisés, jamais annexés : le « plein » de l'événement du cas 1 n'entre pas
            // dans son détail (les deux verdicts n'en portent aucun).
            assertThat(results).extracting(TestResult::detail).containsExactly(null, null);
            assertThat(appender.list)
                    .filteredOn(e -> e.getLevel() == ch.qos.logback.classic.Level.WARN)
                    .extracting(ch.qos.logback.classic.spi.ILoggingEvent::getFormattedMessage)
                    .singleElement().asString().contains("espace_sature");
            assertThat(appender.list)
                    .filteredOn(e -> e.getLevel() == ch.qos.logback.classic.Level.DEBUG)
                    .hasSize(2);
        } finally {
            logger.detachAppender(appender);
            logger.setLevel(saved);
        }
    }

    @Test
    void case_without_verdict_fails_closed() {
        supervisorReturns("""
                {"v":1,"results":[{"index":0,"passed":true,"ms":1}],"events":[],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(1).passed()).isFalse();
        assertThat(results.get(1).detail()).contains("Notation incomplète");
    }

    @Test
    void incomplete_grading_is_internal_failure_but_visible_to_tester() {
        // Le superviseur signale une notation INCOMPLETE : une erreur interne de son propre code,
        // survenue en traitant le code soumis (qui peut donc la provoquer).
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null,"ms":1},
                  {"index":1,"passed":false,"detail":"Erreur interne du noteur","ms":0}
                ],"events":[],"canaries":"ok","incomplet":true}
                """);
        // Chemin INTERNE (la correction d'une soumission) : ce n'est pas une note. Avant, le cas
        // saute arrivait en passed=false et core l'enregistrait — un 0 définitif sur une
        // tentative UNIQUE, pour une panne du noteur ou de la plateforme. « Incomplet » ne
        // vient que des causes « erreur » (bogue du superviseur) et « interrompu » (plateforme) ;
        // un budget épuisé, lui, reste une note partielle. Cause « sans verdict » : core compte
        // ces échecs (S4).
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(NoVerdictException.class);
        // Chemin PUBLIC (« Tester ») : les verdicts restent rendus, detail compris.
        List<TestResult> r = evaluator.evaluate("Go", "code", TWO_CASES, null,
                DockerEvaluator.PUBLIC_WALL_MS);
        assertThat(r.get(0).passed()).isTrue();
        assertThat(r.get(1).detail()).contains("Erreur interne");
    }

    @Test
    void interrupted_case_is_no_verdict_internally_and_readable_in_tester() {
        // CONTRAT côté Java : tout job « incomplet » est sans verdict en interne et lisible au
        // « Tester », quel que soit le détail — ici celui d'un cas INTERROMPU par la plateforme.
        // Que le superviseur marque bien ces cas « incomplet » (cause « interrompu ») est vérifié
        // côté Python (test_supervisor.py, test_platform_aborted_* et suivants) : ce test-ci
        // fournit lui-même « incomplet » et ne protège pas contre une régression du superviseur.
        String aborted = "Le harnais n'a pas fini de compiler (temps limite de compilation "
                + "dépassé ou compilateur arrêté) : rejouer la correction.";
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null,"ms":1},
                  {"index":1,"passed":false,"detail":"%s","ms":0}
                ],"events":[],"canaries":"ok","incomplet":true}
                """.formatted(aborted));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(NoVerdictException.class);
        List<TestResult> r = evaluator.evaluate("Go", "code", TWO_CASES, null,
                DockerEvaluator.PUBLIC_WALL_MS);
        assertThat(r.get(1).passed()).isFalse();
        assertThat(r.get(1).detail()).isEqualTo(aborted);
    }

    @Test
    void framework_marker_does_not_overflow_the_stack() {
        // Le moteur Java repete un groupe par recursion : une qualification sans fin
        // (`@a.a.a.…`) faisait deborder la pile au lieu de repondre « pas un framework ».
        assertThat(DockerEvaluator.frameworkMarkerFound("java", "@" + "a.".repeat(50_000))).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp", "[" + "a.".repeat(50_000))).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("rust", "#[" + "a::".repeat(50_000))).isFalse();
        // Les formes reelles, qualifiees, restent reconnues.
        assertThat(DockerEvaluator.frameworkMarkerFound("java", "@org.junit.jupiter.api.Test")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[NUnit.Framework.TestCase(1)] public void T(int x) { }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("rust", "#[tokio::test]")).isTrue();
    }

    @Test
    void framework_marker_in_comment_or_string_is_not_a_framework() {
        // Un harnais booléen VALIDE qui mentionne le marqueur en commentaire ou dans une chaîne
        // était refusé : tous les cas de la question à 0, avec un diagnostic trompeur.
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "// pas de @Test ici\nreturn Solution.f() == 1;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "return Solution.isEmail(\"prof@Test.ca\");")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "/* @Test */ return true;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("rust",
                "// pas de #[test]\nsolution::f() == 1")).isFalse();
        // Littéraux qui DÉCLENCHERAIENT le motif sur le texte brut (attribut suivi d'une
        // déclaration) : seul le blanchiment des chaînes les fait passer pour des données.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "return Solution.F(\"x;[Test] public void T(\") == 1;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("go",
                "// func TestX(t *testing.T)\nreturn f() == 1")).isFalse();
        // Un indexeur C# n'est pas un attribut, même quand l'indice porte le nom d'un marqueur.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "return Solution.Notes(tab)[Test] == tab[TestCase] && d?[Theory] == 1;")).isFalse();
        // Revue #246 : indexeur après un autre indexeur ou après une chaîne, chaîne brute Go et
        // chaîne verbatim C# — des corps booléens valides.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "return Grille()[0][Test] == 1 && \"abc\"[Test] == 'a';")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "var p = @\"C:\\\";\nvar q = @\"\n[Test] public void T() { }\";\n"
                        + "return Solution.F(p + q) == 1;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("go",
                "return f(`func TestX(`) == 1")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("go",
                "q := `\"`\nreturn f(\"func TestX(\") == 1")).isFalse();
        // Initialiseur d'index et indexeur en continuation : pas des attributs (revue #246).
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "var d = new Dictionary<Mode, int> { [Mode.Test] = 3 };\nreturn d[Mode.Test] == 3;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "var d = new Dictionary<Mode, int> {\n    [Mode.Test] = 3\n};\nreturn true;")).isFalse();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "return Solution.Notes()\n    [Test] == 3;")).isFalse();
        // Le même marqueur dans le CODE reste refusé.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "int[] tab = { 1 };\n[Test] public void T() { }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[Category(\"a\")][Test] public void T() { }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[Test]\n[Category(\"a\")]\nvoid T() { }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[Test] Task T() { return null; }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "public class T {\n    [Category(\"a\"), Test]\n    public void A() { }\n}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "public class T { [TestCase(3, 4)] public void A(int x, int y) { } }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "// commentaire\n@Test\nvoid t() { }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("go",
                "func TestX(t *testing.T) { }")).isTrue();
    }

    @Test
    void forgery_wins_over_incomplete_on_java_side_too() {
        // Le superviseur ne signale jamais « incomplet » avec des canaris incoherents, mais Java
        // ne lui fait pas confiance aveuglement : une regression cote superviseur ne doit pas
        // transformer une falsification en tentative a reprendre (502).
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null,"ms":1},
                  {"index":1,"passed":false,"detail":"Erreur interne du noteur","ms":0}
                ],"events":[],"canaries":"incoherents","incomplet":true}
                """);
        List<TestResult> r = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(r.get(0).passed()).isFalse();
        assertThat(r.get(0).detail()).contains("falsification");
    }

    @Test
    void dead_container_without_json_throws_instead_of_grading_zero() {
        // Jackson 3 ne lève PAS sur une sortie vide : readTree("") rend un MissingNode. Sans
        // garde, `results` était simplement vide, chaque cas recevait « Notation incomplète »
        // passed=false — une liste de verdicts VALIDE aux yeux de core, qui persistait un 0
        // sur une tentative UNIQUE. Un superviseur mort APRÈS sa ligne témoin (OOM du cgroup,
        // tué pendant le code soumis) n'est jamais un 0 : NoVerdictException → 502 de cause
        // « sans_verdict », que core compte par étudiant et par quiz (S4). Mort AVANT la ligne
        // témoin (image cassée) : panne « indisponible », test suivant ; journaux non lus à
        // temps : SandboxException dès DockerSandbox.run, jamais une sortie vide ici.
        for (String stdout : new String[] {"", "   \n", "null"}) {
            when(sandbox.run(any(), anyMap(), anyLong())).thenReturn(new DockerSandbox.ContainerRun(
                    stdout, DockerEvaluator.SUBMITTED_CODE_STAGE + " tué (OOM ?)", 137));
            assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                    .as("stdout %s doit lever, pas noter 0", "«" + stdout + "»")
                    .isInstanceOf(NoVerdictException.class);
        }
    }

    @Test
    void supervisor_dead_before_the_submitted_code_is_a_platform_failure() {
        // Sans sa ligne témoin, le superviseur est mort pendant sa propre mise en place (image
        // cassée, job non reçu) : aucun code soumis n'a tourné. Panne « indisponible », jamais
        // comptée contre l'étudiant — sinon une image cassée envoyait toute une classe « à
        // revoir » au troisième essai. Même règle pour une sortie illisible.
        for (String stdout : new String[] {"", "pas du json"}) {
            for (String stderr : new String[] {"", "Traceback: ImportError", null}) {
                when(sandbox.run(any(), anyMap(), anyLong()))
                        .thenReturn(new DockerSandbox.ContainerRun(stdout, stderr, 1));
                assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                        .as("«%s» / «%s»", stdout, stderr)
                        .isInstanceOf(SandboxException.class)
                        .isNotInstanceOf(NoVerdictException.class)
                        .hasMessageContaining("avant la prise en charge du code soumis");
            }
        }
    }

    @Test
    void unreadable_json_throws_sandbox_exception() {
        // stderr volumineux : tronqué dans le journal, jamais dans l'exception.
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("pas du json",
                        DockerEvaluator.SUBMITTED_CODE_STAGE + "x".repeat(5000), 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(NoVerdictException.class);
        // stderr absent : le journal reste robuste (aucune NPE).
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("toujours pas du json", null, 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class);
    }

    @Test
    void pre_container_rejections_ignore_languages_that_are_not_compiled() {
        // Format framework et noms réservés : propres aux compilés. Un langage interprété (ou
        // inconnu) n'est pas leur affaire — aucun refus, la notation suit son propre chemin.
        List<TestCaseInput> cases = List.of(new TestCaseInput("a", "@Test void t() {}", 1));
        for (String language : new String[] {"Python", "SQL", "cobol"}) {
            assertThat(DockerEvaluator.frameworkHarnessRejection(language, cases)).as(language).isNull();
            assertThat(DockerEvaluator.reservedNameRejection(language, "class MooditX {}", cases))
                    .as(language).isNull();
        }
    }

    @Test
    void reserved_class_names_are_a_java_only_rule() {
        // Seul Java tire le nom du fichier déposé de la classe publique du code soumis :
        // ailleurs, les noms de fichiers sont fixes, et un nom « réservé » ou très long n'y
        // gêne rien. Le refuser hors de Java rendrait 0 à une réponse juste.
        List<TestCaseInput> cases = List.of(new TestCaseInput("a", "return true;", 1));
        assertThat(DockerEvaluator.reservedNameRejection("C#", "public class MooditCalcul { }", cases))
                .isNull();
        assertThat(DockerEvaluator.reservedNameRejection("C++", "class MooditPile {}", cases))
                .isNull();
        String longName = "A".repeat(201);
        assertThat(DockerEvaluator.reservedNameRejection("C++", "class " + longName + " {}", cases))
                .isNull();
        assertThat(DockerEvaluator.reservedNameRejection("Go",
                "package main\ntype " + longName + " struct{}", cases)).isNull();
        // Témoin : la même règle s'applique bien en Java.
        assertThat(DockerEvaluator.reservedNameRejection("Java", "public class MooditCalcul { }", cases))
                .singleElement().satisfies(r -> assertThat(r.detail()).contains("réservé"));
    }

    @Test
    void supervisor_stderr_is_logged_up_to_1000_characters() {
        // Le stderr du superviseur entre dans le journal tronqué à 1000 caractères : complet
        // jusqu'à la borne, coupé avec « … » au-delà.
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(DockerEvaluator.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            String atLimit = DockerEvaluator.SUBMITTED_CODE_STAGE
                    + "x".repeat(1000 - DockerEvaluator.SUBMITTED_CODE_STAGE.length());
            for (String stderr : new String[] {atLimit, atLimit + "y"}) {
                appender.list.clear();
                when(sandbox.run(any(), anyMap(), anyLong()))
                        .thenReturn(new DockerSandbox.ContainerRun("pas du json", stderr, 1));
                assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                        .isInstanceOf(NoVerdictException.class);
                assertThat(appender.list).first().extracting(e -> e.getFormattedMessage())
                        .asString().endsWith(" : " + (stderr == atLimit ? atLimit : atLimit + "…"));
            }
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void supervisor_error_throws_sandbox_exception() {
        supervisorReturns("{\"v\":1,\"error\":\"fichiers du job non reçus\"}");
        // Erreur DÉCLARÉE par le superviseur (dépôt du job raté) : panne d'infrastructure, pas
        // une notation sans verdict — core ne la compte pas.
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class)
                .isNotInstanceOf(NoVerdictException.class)
                .hasMessageContaining("fichiers du job non reçus");
    }

    @Test
    void supervisor_killed_by_oom_is_logged_as_an_isolation_failure() {
        // S3 (#116) : sortie 137 ET OOMKilled, sans verdict → erreur dédiée dans le journal ; la
        // réponse reste un 502 « sans verdict ». OOMKilled seul (un processus soumis tué, verdict
        // rendu) ou 137 seul (mur, kill) n'en est pas un.
        ch.qos.logback.classic.Logger logger = (ch.qos.logback.classic.Logger)
                org.slf4j.LoggerFactory.getLogger(DockerEvaluator.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            for (String stdout : new String[] {"", "pas du json"}) {   // muet, illisible
            for (boolean oom : new boolean[] {false, true}) {
                for (long exit : new long[] {1, 137}) {
                    appender.list.clear();
                    when(sandbox.run(any(), anyMap(), anyLong()))
                            .thenReturn(new DockerSandbox.ContainerRun(stdout,
                                    DockerEvaluator.SUBMITTED_CODE_STAGE, exit, oom));
                    assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                            .isInstanceOf(NoVerdictException.class);
                    assertThat(appender.list)
                            .filteredOn(e -> e.getLevel() == ch.qos.logback.classic.Level.ERROR)
                            .as("«%s» oom=%s exit=%s", stdout, oom, exit)
                            .hasSize(oom && exit == 137 ? 1 : 0);
                }
            }
            }
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void cpp_image_shares_the_c_one() {
        assertThat(evaluator.imageFor("cpp")).isEqualTo("moodit-runner-c:latest");
        assertThat(evaluator.imageFor("java")).isEqualTo("moodit-runner-java:latest");
    }

    @Test
    void wall_budget_bounded_and_language_image_used() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        evaluator.evaluate("C++", "code",
                List.of(new TestCaseInput("t", "return doubler(5) == 10;", 1)), 5000);
        // 30 s de base + (1 cas + 2 canaris) × (5 s + 10 s de marge + DEUX compilations de 90 s
        // — le noteur et le code soumis sont deux programmes — + 5 s d'inventaire + 30 s d'outils
        // C/C++ : sondes des noms réservés et nm) + 10 s de préprocesseur par job = 730 s.
        verify(sandbox).run(eq("moodit-runner-c:latest"), anyMap(), eq(730_000L));
        // Ce que le SUPERVISEUR reçoit : le temps limite par cas tel quel, et le budget du job
        // dérivé du même mur (sans lui, le superviseur ne s'arrête pas avant le mur et le démon
        // tue le conteneur : tout le travail est perdu).
        JsonNode job = lastJob();
        assertThat(job.path("timeout_ms").asLong()).isEqualTo(5_000);
        assertThat(job.path("budget_ms").asLong())
                .isEqualTo(DockerEvaluator.walls("cpp", 1, 5_000, Long.MAX_VALUE).budgetMs());
    }

    @Test
    void java_short_time_limit_raised_to_the_vm_floor_in_the_job() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // 1 s demandée par le prof : la JVM froide met 2 à 5 s à démarrer. Le superviseur relève
        // déjà son temps limite à 10 s, mais le job doit porter la MÊME valeur que celle qui
        // dimensionne le mur et le budget — sinon le mur ne couvre pas le temps réellement
        // accordé par cas.
        evaluator.evaluate("Java", "code",
                List.of(new TestCaseInput("t", "return Solution.doubler(5) == 10;", 1)), 1_000);
        JsonNode job = lastJob();
        assertThat(job.path("timeout_ms").asLong()).isEqualTo(10_000);
        DockerEvaluator.Walls walls = DockerEvaluator.walls("java", 1, 10_000, Long.MAX_VALUE);
        assertThat(job.path("budget_ms").asLong()).isEqualTo(walls.budgetMs());
        verify(sandbox).run(eq("moodit-runner-java:latest"), anyMap(), eq(walls.wallMs()));
    }

    @Test
    void csharp_short_time_limit_raised_to_the_vm_floor_in_the_job() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Même plancher VM qu'en Java : mono froid met plusieurs secondes à démarrer, et le
        // superviseur relève aussi son temps limite C# à 10 s. Le job, le mur et le budget
        // doivent porter cette valeur, pas la seconde demandée par le prof.
        evaluator.evaluate("C#", "code",
                List.of(new TestCaseInput("t", "return Solution.Doubler(5) == 10;", 1)), 1_000);
        JsonNode job = lastJob();
        assertThat(job.path("timeout_ms").asLong()).isEqualTo(10_000);
        DockerEvaluator.Walls walls = DockerEvaluator.walls("csharp", 1, 10_000, Long.MAX_VALUE);
        assertThat(job.path("budget_ms").asLong()).isEqualTo(walls.budgetMs());
        verify(sandbox).run(eq("moodit-runner-csharp:latest"), anyMap(), eq(walls.wallMs()));
    }

    /** {@code job.json} du DERNIER conteneur demandé au sandbox. */
    private JsonNode lastJob() {
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, String>> files = ArgumentCaptor.forClass(Map.class);
        verify(sandbox, atLeastOnce()).run(any(), files.capture(), anyLong());
        return JsonMapper.builder().build().readTree(files.getValue().get("job.json"));
    }

    @Test
    void absurd_time_limit_bounded_never_negative_wall() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Négatif (valeur stockée aberrante) en Java : le PLANCHER VM (10 s — miroir du
        // superviseur, JVM froide) l'emporte — le mur reste positif et couvre le temps réel
        // accordé. Le plancher de 1 ms, lui, est mesuré en Go ci-dessous.
        evaluator.evaluate("Java", "code",
                List.of(new TestCaseInput("t", "return Solution.doubler(5) == 10;", 1)), -100_000);
        // TROIS compilations en Java : le code soumis seul (pour lire ses signatures), le noteur,
        // le serveur. 30 s + 3 × (10 s de plancher VM + 10 s + 3 × 90 s + 5 s) = 915 s, donc
        // PLAFONNÉ au mur maximal de 15 min — trois compilations par cas coûtent cher, et une
        // question à plusieurs cas lents est notée partiellement plutôt que tuée au mur.
        verify(sandbox).run(eq("moodit-runner-java:latest"), anyMap(), eq(15 * 60_000L));
        JsonNode javaJob = lastJob();
        assertThat(javaJob.path("timeout_ms").asLong()).isEqualTo(10_000);
        assertThat(javaJob.path("budget_ms").asLong())
                .isEqualTo(DockerEvaluator.walls("java", 1, 10_000, Long.MAX_VALUE).budgetMs());

        // Le plancher VM de Java masque celui de 1 ms : un langage SANS plancher VM (Go) le
        // mesure seul. Négatif ou nul : ramené à 1 ms dans le job, et le mur en découle —
        // 30 s + 3 × (1 ms + 10 s + 2 × 90 s + 5 s) = 615,003 s. Sans le plancher, le job
        // portait la valeur aberrante telle quelle et le mur raccourcissait d'autant.
        for (int absurd : new int[] {-100_000, 0}) {
            org.mockito.Mockito.clearInvocations(sandbox);
            evaluator.evaluate("Go", "code",
                    List.of(new TestCaseInput("t", "return doubler(5) == 10", 1)), absurd);
            verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(), eq(615_003L));
            JsonNode flooredJob = lastJob();
            assertThat(flooredJob.path("timeout_ms").asLong()).as("temps limite %d", absurd)
                    .isEqualTo(1);
            assertThat(flooredJob.path("budget_ms").asLong()).as("budget %d", absurd)
                    .isEqualTo(DockerEvaluator.walls("go", 1, 1, Long.MAX_VALUE).budgetMs());
        }
        org.mockito.Mockito.clearInvocations(sandbox);

        // Au-delà du plafond de l'éditeur (60 s) : ramené à 60 s par cas.
        evaluator.evaluate("Go", "code",
                List.of(new TestCaseInput("t", "return doubler(5) == 10", 1)), 999_999);
        // 60 s plafonnés + 10 s + 2 × 90 s + 5 s = 255 s par cas, × 3, + 30 s = 795 s.
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(), eq(795_000L));
        JsonNode goJob = lastJob();
        assertThat(goJob.path("timeout_ms").asLong()).isEqualTo(60_000);
        assertThat(goJob.path("budget_ms").asLong())
                .isEqualTo(DockerEvaluator.walls("go", 1, 60_000, Long.MAX_VALUE).budgetMs());
    }

    @Test
    void wall_covers_real_compilations_of_every_language() {
        // Le chemin non falsifiable compile DEUX programmes par cas — le noteur et le code
        // soumis — et TROIS en Java, où les signatures sont lues sur les classes compilées. Le
        // mur n'en budgétait qu'une : un cas lancé juste avant l'échéance du budget se faisait
        // tuer au mur, ce qui perdait tous les verdicts du job (#216).
        assertThat(DockerEvaluator.compilesPerCase("cpp")).isEqualTo(2);
        assertThat(DockerEvaluator.compilesPerCase("go")).isEqualTo(2);
        assertThat(DockerEvaluator.compilesPerCase("java")).isEqualTo(3);
    }

    @Test
    void wall_covers_c_and_cpp_tools_around_the_compilations() {
        // run_c_rpc lance aussi, par cas, les sondes des noms réservés (C_PROBE_BUDGET_S, 20 s
        // en tout) et `nm` sur le binaire soumis (NM_TIMEOUT_S, 10 s), et une fois par job le
        // préprocesseur seul (C_PREPROCESS_TIMEOUT_S, 10 s). Le mur ne les comptait pas : un
        // cas lancé juste avant l'échéance pouvait le dépasser (#216).
        assertThat(DockerEvaluator.toolsPerCaseMs("c")).isEqualTo(5_000 + 30_000);
        assertThat(DockerEvaluator.toolsPerCaseMs("cpp")).isEqualTo(5_000 + 30_000);
        assertThat(DockerEvaluator.toolsPerCaseMs("go")).isEqualTo(5_000);
        assertThat(DockerEvaluator.toolsPerCaseMs("java")).isEqualTo(5_000);
        assertThat(DockerEvaluator.toolsPerJobMs("cpp")).isEqualTo(10_000);
        assertThat(DockerEvaluator.toolsPerJobMs("rust")).isZero();
        // Un cas, mur non plafonné : 30 s + 10 s (préprocesseur) + 3 × pireCas, et l'invariant
        // « budget + pireCas + marge de clôture ≤ mur » exact.
        long worstCaseCpp = 10_000 + 10_000 + 2 * 90_000 + 5_000 + 30_000;
        DockerEvaluator.Walls cpp = DockerEvaluator.walls("cpp", 1, 10_000, Long.MAX_VALUE);
        assertThat(cpp.wallMs()).isEqualTo(30_000 + 10_000 + 3 * worstCaseCpp);
        assertThat(cpp.budgetMs()).isEqualTo(cpp.wallMs() - worstCaseCpp - 20_000);
    }

    @Test
    void reserved_marker_in_submitted_code_rejected_without_container() {
        // __MOODIT_ est le préfixe réservé des gabarits runtime (canaris __MOODIT_A__/__MOODIT_B__,
        // marqueur __MOODIT_HARNAIS__). Le superviseur ne substitue que dans le fichier du
        // harnais, jamais dans le fichier soumis : ce rejet est une défense en profondeur (et, en
        // Java, évite qu'un fichier soumis porteur du marqueur soit pris pour le harnais). Rejet
        // explicite AVANT tout conteneur — chaque cas échoue avec le même détail.
        // Poids absent sur un cas (champ optionnel de l'API) : le rejet passe par
        // effectiveWeight() — pas de NPE à l'unboxing.
        List<TestCaseInput> casesWithoutWeight = List.of(
                new TestCaseInput("premier", "h1", 2), new TestCaseInput("second", "h2", null));
        List<TestResult> results = evaluator.evaluate("Go",
                "package main\nfunc f() { println(\"[MOODIT] jeton=__MOODIT_T__\") }",
                casesWithoutWeight, null);
        assertThat(results).hasSize(2);
        assertThat(results).allSatisfy(r -> {
            assertThat(r.passed()).isFalse();
            assertThat(r.detail()).contains("Marqueur réservé");
        });
        org.mockito.Mockito.verifyNoInteractions(sandbox);
    }

    // ── Détection du format framework retiré, pour le refuser (#116) ─────────────

    @Test
    void framework_marker_detected_only_on_real_framework_tests() {
        // Il n'y a plus qu'une forme notée : le corps booléen. `frameworkMarkerFound` est le
        // DÉTECTEUR du format retiré — ExecutionService s'en sert pour REFUSER un harnais au
        // format framework avec un diagnostic, avant toute prise de place sandbox. Un booléen
        // ne doit jamais le déclencher (refus à tort), un vrai test toujours (sinon il partirait
        // au conteneur comme corps booléen, ne compilerait pas, et le prof n'aurait pas le
        // diagnostic).
        record CaseSpec(String lang, String booleanForm, String framework) { }
        List<CaseSpec> specs = List.of(
                new CaseSpec("java", "return Solution.doubler(5) == 10;", "@Test void t() {}"),
                new CaseSpec("csharp", "return Solution.Doubler(5) == 10;", "[Test] public void T() {}"),
                new CaseSpec("go", "return doubler(5) == 10", "func TestT(t *testing.T) {}"),
                new CaseSpec("rust", "doubler(5) == 10", "#[test] fn t() {}"),
                new CaseSpec("c", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"),
                new CaseSpec("cpp", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"));
        for (CaseSpec c : specs) {
            assertThat(DockerEvaluator.frameworkMarkerFound(c.lang(), c.booleanForm()))
                    .as("harnais booléen en " + c.lang() + " → aucun marqueur, pas de refus")
                    .isFalse();
            assertThat(DockerEvaluator.frameworkMarkerFound(c.lang(), c.framework()))
                    .as("harnais framework en " + c.lang() + " → marqueur détecté, refus")
                    .isTrue();
        }
    }

    @Test
    void parameterized_and_qualified_forms_recognized_as_framework() {
        // Formes IDIOMATIQUES qu'un contrôle littéral prenait pour des harnais booléens.
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[TestCase(3, 4, 12)] public void Aire(…) {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("csharp",
                "[ TestCaseSource(nameof(Cas)) ] void T() {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "@ParameterizedTest @ValueSource(ints = {1}) void t(int n) {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java",
                "@org.junit.jupiter.api.Test void t() {}")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("java", "@RepeatedTest(3) void t() {}"))
                .isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("rust",
                "#[cfg(test)] mod m { #[test] fn t() {} }")).isTrue();
        assertThat(DockerEvaluator.frameworkMarkerFound("cpp", "MOODIT_TEST (aire) { }")).isTrue();
    }

    @Test
    void wall_capped_for_public_call() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // 10 cas × (60 s + 10 s + 2 × 90 s + 5 s) dépasserait largement le plafond public (4 min).
        List<TestCaseInput> many = java.util.stream.IntStream.range(0, 10)
                .mapToObj(i -> new TestCaseInput("c" + i, "h", 1)).toList();
        evaluator.evaluate("Go", "code", many, 60_000, DockerEvaluator.PUBLIC_WALL_MS);
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(),
                eq(DockerEvaluator.PUBLIC_WALL_MS));
    }

    @Test
    void inconsistent_canaries_neutralize_verdicts_java_side() {
        // Défense en PROFONDEUR : même si le superviseur renvoyait « passed », Java refuse.
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":null},
                  {"index":1,"passed":true,"detail":null}
                ],"events":[],"canaries":"incoherents"}
                """);
        List<TestResult> results = evaluator.evaluate("C", "code", TWO_CASES, null);
        assertThat(results).allSatisfy(r -> {
            assertThat(r.passed()).isFalse();
            assertThat(r.detail()).contains("Incohérence détectée");
        });
    }

    @Test
    void inconsistent_canaries_keep_the_case_detail_under_the_warning() {
        // Le détail du cas reste lisible sous l'avertissement ; un détail vide n'ajoute rien.
        supervisorReturns("""
                {"v":1,"results":[
                  {"index":0,"passed":true,"detail":"sortie du noteur"},
                  {"index":1,"passed":true,"detail":"  "}
                ],"events":[],"canaries":"incoherents"}
                """);
        List<TestResult> results = evaluator.evaluate("C", "code", TWO_CASES, null);
        assertThat(results.get(0).detail()).isEqualTo(
                "⚠ Incohérence détectée pendant la notation (falsification probable).\nsortie du noteur");
        assertThat(results.get(1).detail()).isEqualTo(
                "⚠ Incohérence détectée pendant la notation (falsification probable).");
    }

    @Test
    void missing_or_unknown_canary_verdict_is_a_failure_not_a_grade() {
        // Revue #246 : seul « incoherents » était relu. Un superviseur régressé qui omettait le
        // champ (ou rendait une valeur inconnue) voyait ses « réussi » acceptés, sans que rien
        // n'atteste que les canaris avaient été jugés. Panne (502), sur les deux chemins. Panne
        // de PLATEFORME, non comptée contre l'étudiant : le superviseur émet toujours ce champ
        // avec ses verdicts, son absence vient d'une image d'une autre version que le service.
        // « aucun » : verdict d'un job SANS canaris, or chaque job en porte deux — non jugés.
        for (String verdict : List.of("", ",\"canaries\":\"OK\"", ",\"canaries\":null",
                ",\"canaries\":true", ",\"canaries\":\"aucun\"")) {
            supervisorReturns("{\"v\":1,\"results\":[{\"index\":0,\"passed\":true},"
                    + "{\"index\":1,\"passed\":true}],\"events\":[]" + verdict + "}");
            assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                    .as(verdict).isInstanceOf(SandboxException.class)
                    .isNotInstanceOf(NoVerdictException.class)
                    .hasMessageContaining("canaris");
            assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null,
                    DockerEvaluator.PUBLIC_WALL_MS))
                    .as(verdict).isInstanceOf(SandboxException.class);
        }
        // Témoins : les verdicts sans accusation laissent passer les notes du superviseur.
        for (String verdict : List.of("ok", "indetermines")) {
            supervisorReturns("{\"v\":1,\"results\":[{\"index\":0,\"passed\":true},"
                    + "{\"index\":1,\"passed\":false}],\"events\":[],\"canaries\":\"" + verdict + "\"}");
            List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
            assertThat(results.get(0).passed()).as(verdict).isTrue();
            assertThat(results.get(1).passed()).as(verdict).isFalse();
        }
    }

    @Test
    void no_dockerfile_leaves_a_dangling_continuation() throws java.io.IOException {
        // Un `\` en fin de ligne suivi d'une ligne VIDE fait avaler l'instruction suivante par
        // le RUN en cours. L'image ne se construit plus, et le message d'erreur accuse la
        // commande du RUN — pas la continuation. C'est arrivé en retirant les téléchargements
        // du format framework (#116) : le `COPY` du superviseur s'est retrouvé dans le RUN, et
        // seule une construction réelle, donc la CI, pouvait le dire. Ce test le dit en 2 ms.
        // Les instructions Dockerfile : une continuation suivie de l'une d'elles l'avale, SANS
        // qu'il y ait de ligne vide — la variante que la première version de ce test laissait
        // passer.
        java.util.Set<String> instructions = java.util.Set.of("FROM", "RUN", "COPY", "ADD",
                "USER", "WORKDIR", "ENV", "ARG", "ENTRYPOINT", "CMD", "EXPOSE", "VOLUME",
                "LABEL", "SHELL", "HEALTHCHECK", "STOPSIGNAL", "ONBUILD");
        java.util.List<String> offending = new java.util.ArrayList<>();
        int readFiles = 0;
        java.nio.file.Path rootDir = java.nio.file.Path.of("..", "docker", "runners");
        try (var directories = java.nio.file.Files.list(rootDir)) {
            for (java.nio.file.Path d : directories.sorted().toList()) {
                java.nio.file.Path df = d.resolve("Dockerfile");
                if (!java.nio.file.Files.isRegularFile(df)) {
                    continue;
                }
                readFiles++;
                java.util.List<String> lines = java.nio.file.Files.readAllLines(df);
                for (int i = 0; i < lines.size(); i++) {
                    if (!lines.get(i).stripTrailing().endsWith("\\")) {
                        continue;
                    }
                    if (i == lines.size() - 1) {
                        offending.add(d.getFileName() + "/Dockerfile:" + (i + 1) + " (fin de fichier)");
                        continue;
                    }
                    String nextLine = lines.get(i + 1).strip();
                    String keyword = nextLine.split("\\s+", 2)[0].toUpperCase(java.util.Locale.ROOT);
                    if (nextLine.isEmpty()) {
                        offending.add(d.getFileName() + "/Dockerfile:" + (i + 1) + " (ligne vide)");
                    } else if (instructions.contains(keyword)) {
                        offending.add(d.getFileName() + "/Dockerfile:" + (i + 1)
                                + " (instruction " + keyword + " avalée)");
                    }
                }
            }
        }
        assertThat(offending)
                .withFailMessage("continuation pendante (l'instruction suivante serait avalée "
                        + "par le RUN, et l'image ne construirait plus) : %s", offending)
                .isEmpty();
        // Exhaustif par construction : si la racine changeait de forme, le test verdirait sans
        // rien avoir lu.
        assertThat(readFiles)
                .withFailMessage("10 Dockerfiles runner attendus, %d lus — le test ne vérifie "
                        + "plus ce qu'il annonce", readFiles)
                .isEqualTo(10);
    }


    @Test
    void public_tester_budget_stays_proportional_to_wall() {
        // Le pire cas THÉORIQUE d'un cas (compilations à 90 s) dépasse le plafond public de
        // 4 min : dérivé de lui seul, le budget tombait à 1 s et le « Tester » du prof ne
        // notait qu'un cas — voire aucun, un canari pouvant passer en premier. Aucun test
        // n'assertait cette valeur : la CI était verte sur un chemin inopérant.
        long wall = DockerEvaluator.PUBLIC_WALL_MS;
        // Java, 2 cas, timeout par défaut (plancher VM 10 s) : pireCas = 295 s > mur entier.
        DockerEvaluator.Walls java = DockerEvaluator.walls("java", 2, 10_000, wall);
        assertThat(java.wallMs()).isEqualTo(wall);
        assertThat(java.budgetMs()).isEqualTo(wall * 3 / 5);
        // Go à 60 s — la valeur maximale de l'éditeur : pireCas = 255 s > mur.
        DockerEvaluator.Walls go = DockerEvaluator.walls("go", 2, 60_000, wall);
        assertThat(go.budgetMs()).isEqualTo(wall * 3 / 5);
    }

    @Test
    void internal_budget_keeps_strict_formula_and_invariant() {
        // Chemin INTERNE (soumission d'un étudiant) : mur à 15 min, la formule stricte domine
        // et l'invariant « budget + pireCas + marge ≤ mur » doit tenir — c'est lui qui protège
        // la tentative d'une suppression au mur (#216).
        DockerEvaluator.Walls java = DockerEvaluator.walls("java", 3, 10_000, Long.MAX_VALUE);
        assertThat(java.wallMs()).isEqualTo(15 * 60_000);
        assertThat(java.budgetMs()).isEqualTo(585_000);
        long worstCaseJava = 10_000 + 10_000 + 3 * 90_000 + 5_000;
        assertThat(java.budgetMs() + worstCaseJava + 20_000).isLessThanOrEqualTo(java.wallMs());
        // Au temps limite MAXIMAL (60 s, Java, 3 compilations) : le plancher proportionnel
        // l'emportait dès 56 s sous le plafond interne et rompait l'invariant de quelques
        // secondes. Il est réservé au chemin public : ici la formule stricte, l'invariant exact.
        DockerEvaluator.Walls javaLong = DockerEvaluator.walls("java", 3, 60_000, Long.MAX_VALUE);
        long worstCaseJavaLong = 60_000 + 10_000 + 3 * 90_000 + 5_000;
        assertThat(javaLong.budgetMs() + worstCaseJavaLong + 20_000)
                .isLessThanOrEqualTo(javaLong.wallMs());
        // Le plus petit job possible (un cas, mur NON plafonné) : budget = mur − pireCas − marge
        // de clôture, exactement — sans plancher proportionnel.
        DockerEvaluator.Walls go = DockerEvaluator.walls("go", 1, 10_000, Long.MAX_VALUE);
        long worstCaseGo = 10_000 + 10_000 + 2 * 90_000 + 5_000;
        assertThat(go.budgetMs() + worstCaseGo).isLessThanOrEqualTo(go.wallMs());
        assertThat(go.budgetMs()).isEqualTo(go.wallMs() - worstCaseGo - 20_000);
    }

}
