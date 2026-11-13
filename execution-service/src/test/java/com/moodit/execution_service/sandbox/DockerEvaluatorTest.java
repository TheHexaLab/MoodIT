package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Traduction FAIL-CLOSED du JSON du superviseur en verdicts (#116) : un cas sans verdict, un JSON
 * cassé ou une erreur du superviseur ne deviennent jamais un « réussi » ; les événements de
 * détection sont annexés au détail du cas visé.
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
    void mappe_les_verdicts_par_index_avec_noms_et_poids() {
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
    void cas_sans_verdict_echoue_fail_closed() {
        supervisorReturns("""
                {"v":1,"results":[{"index":0,"passed":true,"ms":1}],"events":[],"canaries":"ok"}
                """);
        List<TestResult> results = evaluator.evaluate("Go", "code", TWO_CASES, null);
        assertThat(results.get(0).passed()).isTrue();
        assertThat(results.get(1).passed()).isFalse();
        assertThat(results.get(1).detail()).contains("Notation incomplète");
    }

    @Test
    void json_illisible_leve_sandbox_exception() {
        // stderr volumineux : tronqué dans le journal, jamais dans l'exception.
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("pas du json", "x".repeat(5000), 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class);
        // stderr absent : le journal reste robuste (aucune NPE).
        when(sandbox.run(any(), anyMap(), anyLong()))
                .thenReturn(new DockerSandbox.ContainerRun("toujours pas du json", null, 1));
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class);
    }

    @Test
    void erreur_du_superviseur_leve_sandbox_exception() {
        supervisorReturns("{\"v\":1,\"error\":\"fichiers du job non reçus\"}");
        assertThatThrownBy(() -> evaluator.evaluate("Go", "code", TWO_CASES, null))
                .isInstanceOf(SandboxException.class)
                .hasMessageContaining("fichiers du job non reçus");
    }

    @Test
    void image_cpp_partage_celle_du_c() {
        assertThat(evaluator.imageFor("cpp")).isEqualTo("moodit-runner-c:latest");
        assertThat(evaluator.imageFor("java")).isEqualTo("moodit-runner-java:latest");
    }

    @Test
    void budget_mural_borne_et_image_du_langage_utilisee() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        evaluator.evaluate("C++", "code",
                List.of(new TestCaseInput("t", "return doubler(5) == 10;", 1)), 5000);
        // 30 s de base + (1 cas + 2 canaris) × (5 s + 10 s de marge + DEUX compilations de 90 s
        // — le noteur et le code soumis sont deux programmes — + 5 s d'inventaire) = 630 s.
        verify(sandbox).run(eq("moodit-runner-c:latest"), anyMap(), eq(630_000L));
    }

    @Test
    void temps_limite_aberrant_borne_jamais_de_mur_negatif() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // Négatif (valeur stockée aberrante) : borné à 1 ms, puis PLANCHER VM (10 s — miroir
        // du superviseur, JVM froide) — le mur reste positif et couvre le temps réel accordé.
        evaluator.evaluate("Java", "code",
                List.of(new TestCaseInput("t", "return Solution.doubler(5) == 10;", 1)), -100_000);
        // TROIS compilations en Java : le code soumis seul (pour lire ses signatures), le noteur,
        // le serveur. 30 s + 3 × (10 s de plancher VM + 10 s + 3 × 90 s + 5 s) = 915 s, donc
        // PLAFONNÉ au mur maximal de 15 min — trois compilations par cas coûtent cher, et une
        // question à plusieurs cas lents est notée partiellement plutôt que tuée au mur.
        verify(sandbox).run(eq("moodit-runner-java:latest"), anyMap(), eq(15 * 60_000L));

        // Au-delà du plafond de l'éditeur (60 s) : ramené à 60 s par cas.
        evaluator.evaluate("Go", "code",
                List.of(new TestCaseInput("t", "return doubler(5) == 10", 1)), 999_999);
        // 60 s plafonnés + 10 s + 2 × 90 s + 5 s = 255 s par cas, × 3, + 30 s = 795 s.
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(), eq(795_000L));
    }

    @Test
    void mur_couvre_les_compilations_reelles_de_chaque_langage() {
        // Le chemin non falsifiable compile DEUX programmes par cas — le noteur et le code
        // soumis — et TROIS en Java, où les signatures sont lues sur les classes compilées. Le
        // mur n'en budgétait qu'une : un cas lancé juste avant l'échéance du budget se faisait
        // tuer au mur, ce qui perdait tous les verdicts du job (#216).
        assertThat(DockerEvaluator.compilesPerCase("cpp")).isEqualTo(2);
        assertThat(DockerEvaluator.compilesPerCase("go")).isEqualTo(2);
        assertThat(DockerEvaluator.compilesPerCase("java")).isEqualTo(3);
    }

    @Test
    void marqueur_reserve_dans_le_code_soumis_rejete_sans_conteneur() {
        // __MOODIT_ dans la copie recevrait les substitutions runtime (jeton, canaris) : rejet
        // explicite AVANT tout conteneur — chaque cas échoue avec le même détail.
        // Poids absent sur un cas (champ optionnel de l'API) : le rejet passe par
        // effectiveWeight() — pas de NPE à l'unboxing.
        List<TestCaseInput> casesSansPoids = List.of(
                new TestCaseInput("premier", "h1", 2), new TestCaseInput("second", "h2", null));
        List<TestResult> results = evaluator.evaluate("Go",
                "package main\nfunc f() { println(\"[MOODIT] jeton=__MOODIT_T__\") }",
                casesSansPoids, null);
        assertThat(results).hasSize(2);
        assertThat(results).allSatisfy(r -> {
            assertThat(r.passed()).isFalse();
            assertThat(r.detail()).contains("Marqueur réservé");
        });
        org.mockito.Mockito.verifyNoInteractions(sandbox);
    }

    // ── Aiguillage selon la FORME du harnais (#116) ──────────────────────────────

    @Test
    void la_forme_du_harnais_choisit_le_chemin_dans_les_six_langages() {
        // Les deux formes sont notables : un corps qui renvoie un booléen passe par le modèle à
        // deux processus et deux UID (non falsifiable), un vrai test du framework par l'ancien
        // chemin. `frameworkMarkerFound` est le SEUL aiguillage — rien n'est refusé en amont.
        record Cas(String langage, String booleen, String framework) { }
        List<Cas> cas = List.of(
                new Cas("java", "return Solution.doubler(5) == 10;", "@Test void t() {}"),
                new Cas("csharp", "return Solution.Doubler(5) == 10;", "[Test] public void T() {}"),
                new Cas("go", "return doubler(5) == 10", "func TestT(t *testing.T) {}"),
                new Cas("rust", "doubler(5) == 10", "#[test] fn t() {}"),
                new Cas("c", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"),
                new Cas("cpp", "return doubler(5) == 10;", "MOODIT_TEST(t) { }"));
        for (Cas c : cas) {
            assertThat(DockerEvaluator.frameworkMarkerFound(c.langage(), c.booleen()))
                    .as("harnais booléen en " + c.langage() + " → chemin non falsifiable")
                    .isFalse();
            assertThat(DockerEvaluator.frameworkMarkerFound(c.langage(), c.framework()))
                    .as("harnais framework en " + c.langage() + " → ancien chemin")
                    .isTrue();
        }
    }

    @Test
    void formes_parametrees_et_qualifiees_reconnues_comme_framework() {
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
    void mur_plafonne_pour_un_appel_public() {
        supervisorReturns("{\"v\":1,\"results\":[],\"events\":[],\"canaries\":\"ok\"}");
        // 10 cas × (60 s + 10 s + 90 s) dépasserait largement le plafond public (4 min).
        List<TestCaseInput> many = java.util.stream.IntStream.range(0, 10)
                .mapToObj(i -> new TestCaseInput("c" + i, "h", 1)).toList();
        evaluator.evaluate("Go", "code", many, 60_000, DockerEvaluator.PUBLIC_WALL_MS);
        verify(sandbox).run(eq("moodit-runner-go:latest"), anyMap(),
                eq(DockerEvaluator.PUBLIC_WALL_MS));
    }

    @Test
    void canaris_incoherents_neutralisent_les_verdicts_cote_java() {
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
    void aucun_dockerfile_ne_laisse_de_continuation_pendante() throws java.io.IOException {
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
        java.util.List<String> fautifs = new java.util.ArrayList<>();
        int lus = 0;
        java.nio.file.Path racine = java.nio.file.Path.of("..", "docker", "runners");
        try (var dossiers = java.nio.file.Files.list(racine)) {
            for (java.nio.file.Path d : dossiers.sorted().toList()) {
                java.nio.file.Path df = d.resolve("Dockerfile");
                if (!java.nio.file.Files.isRegularFile(df)) {
                    continue;
                }
                lus++;
                java.util.List<String> lignes = java.nio.file.Files.readAllLines(df);
                for (int i = 0; i < lignes.size(); i++) {
                    if (!lignes.get(i).stripTrailing().endsWith("\\")) {
                        continue;
                    }
                    if (i == lignes.size() - 1) {
                        fautifs.add(d.getFileName() + "/Dockerfile:" + (i + 1) + " (fin de fichier)");
                        continue;
                    }
                    String suivante = lignes.get(i + 1).strip();
                    String motCle = suivante.split("\\s+", 2)[0].toUpperCase(java.util.Locale.ROOT);
                    if (suivante.isEmpty()) {
                        fautifs.add(d.getFileName() + "/Dockerfile:" + (i + 1) + " (ligne vide)");
                    } else if (instructions.contains(motCle)) {
                        fautifs.add(d.getFileName() + "/Dockerfile:" + (i + 1)
                                + " (instruction " + motCle + " avalée)");
                    }
                }
            }
        }
        assertThat(fautifs)
                .withFailMessage("continuation pendante (l'instruction suivante serait avalée "
                        + "par le RUN, et l'image ne construirait plus) : %s", fautifs)
                .isEmpty();
        // Exhaustif par construction : si la racine changeait de forme, le test verdirait sans
        // rien avoir lu.
        assertThat(lus)
                .withFailMessage("10 Dockerfiles runner attendus, %d lus — le test ne vérifie "
                        + "plus ce qu'il annonce", lus)
                .isEqualTo(10);
    }

}
