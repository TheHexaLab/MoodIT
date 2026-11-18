package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.TestCaseInput;
import org.junit.jupiter.api.Test;
import java.time.Duration;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Dispositions de projet par langage envoyées au runner (#116) : structure, canaris, job.json. */
class HarnessProjectsTest {

    /**
     * Harnais au format FRAMEWORK : c'est lui qui exerce l'ancienne disposition (un seul
     * processus). Un harnais BOOLÉEN, lui, part sur le chemin non falsifiable — deux processus,
     * deux UID — et produit une disposition différente, couverte par ses propres tests.
     */
    private static final Map<String, String> FRAMEWORK_HARNESS = Map.of(
            "Java", "@Test void t() { }",
            "C#", "[Test] public void T() { }",
            "Go", "func TestT(t *testing.T) {}",
            "Rust", "#[test] fn t() {}",
            "C", "MOODIT_TEST(t) { }",
            "C++", "MOODIT_TEST(t) { }");

    /** Harnais au format framework du langage visé. */
    private static String harnessCode(String language) {
        return FRAMEWORK_HARNESS.getOrDefault(language, "MOODIT_TEST(t) { }");
    }

    /** Un cas dont le harnais est au format FRAMEWORK du langage visé (ancienne disposition). */
    private static List<TestCaseInput> oneCase(String language) {
        return List.of(new TestCaseInput("aire du rectangle",
                FRAMEWORK_HARNESS.getOrDefault(language, "MOODIT_TEST(t) { }"), 2));
    }

    @Test
    void runner_language_resolves_aliases_and_rejects_interpreted() {
        assertThat(HarnessProjects.runnerLanguage("Java")).isEqualTo("java");
        assertThat(HarnessProjects.runnerLanguage("C#")).isEqualTo("csharp");
        assertThat(HarnessProjects.runnerLanguage("cs")).isEqualTo("csharp");
        assertThat(HarnessProjects.runnerLanguage("golang")).isEqualTo("go");
        assertThat(HarnessProjects.runnerLanguage("C++")).isEqualTo("cpp");
        assertThat(HarnessProjects.runnerLanguage("cplusplus")).isEqualTo("cpp");
        assertThatThrownBy(() -> HarnessProjects.runnerLanguage("Python"))
                .isInstanceOf(UnsupportedLanguageException.class);
    }

    @Test
    void job_json_escapes_case_names() {
        HarnessProjects.Project project = HarnessProjects.build("Java", "class A {}",
                List.of(new TestCaseInput("nom \"piégé\"\navec\tsaut", "h", 1),
                        new TestCaseInput("anti\\slash\rretour\u0001contrôle", "h", 1)), null);
        assertThat(project.files().get("job.json"))
                .contains("\"name\":\"nom \\\"piégé\\\"\\navec\\tsaut\"")
                .contains("\"name\":\"anti\\\\slash\\rretour\\u0001contrôle\"");
    }

    @Test
    void every_language_has_a_canary_template() {
        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            Map<String, String> files = HarnessProjects.build(language, "code", oneCase(language), null).files();
            boolean canaryPresent = files.entrySet().stream()
                    .anyMatch(e -> e.getKey().startsWith("cases/1/") && e.getValue().contains("__MOODIT_A__"));
            assertThat(canaryPresent).as("canari de " + language).isTrue();
        }
    }

    @Test
    void every_language_drops_submitted_code_and_marked_harness() {
        // Seule disposition : le code soumis dans son fichier, le harnais du prof dans un AUTRE,
        // précédé du marqueur. Le superviseur compile le second dans le noteur, le premier dans
        // le serveur — deux programmes, deux UID. Les douze tests de disposition du format
        // framework que ce test remplace décrivaient un chemin falsifiable, retiré de #116.
        record Expected(String lang, String submittedFile, String harnessExtension) { }
        for (Expected a : List.of(
                new Expected("Java", "Solution.java", "java"),
                new Expected("C#", "solution.cs", "cs"),
                new Expected("Go", "main.go", "go"),
                new Expected("Rust", "solution.rs", "rs"),
                new Expected("C", "solution.c", "c"),
                new Expected("C++", "solution.cpp", "cpp"))) {
            Map<String, String> files = HarnessProjects
                    .build(a.lang(), submittedCode(a.lang()), oneCase(a.lang()), null)
                    .files();
            assertThat(files).as("code soumis de " + a.lang())
                    .containsKey("cases/0/src/" + a.submittedFile());
            String harnessCode = files.get("cases/0/src/harnais_rpc." + a.harnessExtension());
            assertThat(harnessCode).as("harnais marqué de " + a.lang())
                    .isNotNull()
                    .contains("__MOODIT_HARNAIS__");
            // Le harnais n'est JAMAIS dans le fichier du code soumis : c'est tout l'intérêt.
            assertThat(files.get("cases/0/src/" + a.submittedFile()))
                    .doesNotContain("__MOODIT_HARNAIS__");
        }
    }

    /** Code soumis minimal déclarant une entrée marshalable, par langage. */
    private static String submittedCode(String languageName) {
        return switch (languageName) {
            case "Java" -> "public class Solution { static int doubler(int n) { return n * 2; } }";
            case "C#" -> "class Solution { static int doubler(int n) { return n * 2; } }";
            case "Go" -> "package main\n\nfunc doubler(n int) int { return n * 2 }\n";
            case "Rust" -> "fn doubler(n: i32) -> i32 { n * 2 }\n";
            default -> "int doubler(int n) { return n * 2; }";
        };
    }

    @Test
    void null_case_name_becomes_empty_json_string() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main",
                List.of(new TestCaseInput(null, "func TestT(t *testing.T) {}", 1)), null);
        assertThat(project.files().get("job.json")).contains("\"name\":\"\"");
    }

    /**
     * Le gabarit de harnais de la base doit appeler un point d'entrée que le code de départ de la
     * base DÉCLARE, pour les six langages compilés.
     *
     * <p>Ce lien était vérifié à la main, et c'est par là qu'un gabarit C# appelant
     * {@code Solution.resoudre()} — absent du code de départ, qui déclare {@code solution()} — est
     * passé inaperçu : un prof partant des valeurs par défaut de l'éditeur obtenait un noteur qui
     * ne compile pas.
     *
     * <p>Les migrations sont cherchées par leur CONTENU, pas par leur nom : la DERNIÈRE qui écrit
     * chaque colonne fait foi. Désigner {@code V5} en dur laisserait ce test vert sur un contenu
     * périmé dès qu'une migration ultérieure retoucherait un gabarit — le défaut repasserait.
     */
    @Test
    void every_harness_template_calls_an_entry_the_start_code_declares()
            throws java.io.IOException {
        java.util.List<String> migrations = migrationsByVersion();

        for (String languageName : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            String template = effectiveValue(migrations, "('" + languageName + "', $hc$", "$hc$");
            assertThat(template).as("gabarit de harnais de " + languageName).isNotEmpty();
            // Ancré sur « == ATTENDU » : le point d'entrée est le dernier identifiant suivi de
            // « ( » AVANT cette comparaison. Prendre le premier de la ligne désignerait `abs`
            // dans un `Math.abs(solution(3) - 7.0) < 1e-9`.
            String expression = template.lines()
                    .map(String::strip)
                    .filter(l -> l.contains("== ATTENDU"))
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(
                            "le gabarit de " + languageName + " ne compare plus à ATTENDU : "
                                    + "ancrer ce test autrement"));
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\w+)\\s*\\(")
                    .matcher(expression.substring(0, expression.indexOf("== ATTENDU")));
            String entry_ = null;
            while (m.find()) {
                entry_ = m.group(1);
            }
            assertThat(entry_).as("appel lisible dans le gabarit de " + languageName).isNotNull();

            String lineBegin = effectiveValue(migrations, "('" + languageName + "',", "$sc$");
            assertThat(lineBegin).as("code de départ de " + languageName).isNotEmpty();
            // Hors commentaires : un commentaire qui contiendrait le mot ne vaut pas déclaration.
            String code = lineBegin.lines()
                    .filter(l -> !l.strip().startsWith("//") && !l.strip().startsWith("#"))
                    .reduce("", (a, b) -> a + "\n" + b);
            assertThat(code)
                    .as("le gabarit de " + languageName + " appelle " + entry_
                            + "(), que le code de départ doit déclarer")
                    .contains(entry_);
        }
    }

    /** Contenu des migrations {@code db/migration/V*.sql}, par numéro de version croissant. */
    private static java.util.List<String> migrationsByVersion() throws java.io.IOException {
        java.util.TreeMap<Integer, String> byVersion = new java.util.TreeMap<>();
        try (var fileList = java.nio.file.Files.list(
                java.nio.file.Path.of("..", "db", "migration"))) {
            for (java.nio.file.Path p : fileList.toList()) {
                String caseName = p.getFileName().toString();
                java.util.regex.Matcher v = java.util.regex.Pattern.compile("^V(\\d+)__")
                        .matcher(caseName);
                if (caseName.endsWith(".sql") && v.find()) {
                    byVersion.put(Integer.parseInt(v.group(1)),
                            java.nio.file.Files.readString(p));
                }
            }
        }
        assertThat(byVersion).as("migrations trouvées").isNotEmpty();
        return List.copyOf(byVersion.values());
    }

    /**
     * Valeur EFFECTIVE d'un gabarit : les migrations sont rejouées dans l'ordre et le dernier bloc
     * non vide gagne.
     *
     * <p>Une migration met à jour un SOUS-ENSEMBLE de langages — {@code V5} ne retouche que les
     * six compilés. Prendre « la dernière migration qui écrit la colonne » désignerait donc un
     * fichier où le langage cherché est absent : c'est ce que faisait la première version de ce
     * test, et elle échouait sur Java.
     */
    private static String effectiveValue(java.util.List<String> migrations, String begin,
            String delimiter) {
        String value = "";
        for (String migration : migrations) {
            String found = block(migration, begin, delimiter);
            if (!found.isEmpty()) {
                value = found;
            }
        }
        return value;
    }

    /** Contenu entre le premier {@code $…$} qui suit {@code debut}. */
    private static String block(String sourceText, String begin, String delimiter) {
        int i = sourceText.indexOf(begin);
        if (i < 0) {
            return "";
        }
        int j = sourceText.indexOf(delimiter, i + begin.length() - delimiter.length());
        if (j < 0) {
            return "";
        }
        int k = sourceText.indexOf(delimiter, j + delimiter.length());
        return k < 0 ? "" : sourceText.substring(j + delimiter.length(), k);
    }

    @Test
    void file_name_follows_top_level_public_type_in_any_form() {
        // Chaque forme etait notee 0 : fichier mal nomme, javac refusait la classe publique.
        // Identifiant Unicode (\w ne reconnait que l'ASCII : « Réponse » donnait R.java).
        assertThat(HarnessProjects.javaFileName("public class Réponse { }", "Solution"))
                .isEqualTo("Réponse.java");
        // Modificateurs hors de final/abstract : sealed, non-sealed, strictfp, ordre libre.
        assertThat(HarnessProjects.javaFileName("""
                public sealed interface Forme permits Carre { }
                record Carre(int c) implements Forme { }
                """, "Solution")).isEqualTo("Forme.java");
        assertThat(HarnessProjects.javaFileName("public non-sealed class Libre { }", "Solution"))
                .isEqualTo("Libre.java");
        assertThat(HarnessProjects.javaFileName("strictfp public class Calcul { }", "Solution"))
                .isEqualTo("Calcul.java");
        assertThat(HarnessProjects.javaFileName("final public class Fin { }", "Solution"))
                .isEqualTo("Fin.java");
        // Annotation sur la meme ligne.
        assertThat(HarnessProjects.javaFileName("@SuppressWarnings public class Annotee { }", "S"))
                .isEqualTo("Annotee.java");
        // Annotation A ARGUMENTS sur la ligne de la classe (fonctionnait sur main).
        assertThat(HarnessProjects.javaFileName("""
                class Aide { }
                @SuppressWarnings("unchecked") public class Solution { }
                """, "Main")).isEqualTo("Solution.java");
        // Une classe IMBRIQUEE publique, rencontree avant, n'impose pas son nom.
        assertThat(HarnessProjects.javaFileName("""
                class Aide {
                    public static class Interne { }
                }
                public class Solution { }
                """, "X")).isEqualTo("Solution.java");
        // La forme qui marchait deja marche toujours ; sans type public, le premier de premier
        // niveau ; sans type du tout, le nom de repli.
        assertThat(HarnessProjects.javaFileName("public class Solution { }", "X"))
                .isEqualTo("Solution.java");
        assertThat(HarnessProjects.javaFileName("""
                enum Couleur { ROUGE }
                class Autre { }
                """, "X")).isEqualTo("Couleur.java");
        assertThat(HarnessProjects.javaFileName("int x;", "Solution")).isEqualTo("Solution.java");
    }

    @Test
    void file_name_is_read_in_linear_time() {
        // Une tete en \s* multiligne faisait repartir le moteur de chaque ligne jusqu'au bout
        // de la source : temps quadratique, sur une source choisie par l'etudiant.
        for (String source : List.of("\t\n".repeat(100_000), "\n".repeat(200_000),
                "static ".repeat(30_000), "public ".repeat(30_000), "@a ".repeat(60_000))) {
            assertTimeoutPreemptively(Duration.ofSeconds(2),
                    () -> HarnessProjects.javaFileName(source, "Solution"));
        }
    }

    @Test
    void commented_class_does_not_mislead_file_name() {
        // Un étudiant qui garde une ancienne version en commentaire voyait le fichier déposé
        // nommé d'après la classe COMMENTÉE : javac refusait alors sa vraie classe publique
        // (le nom du fichier fait foi), et une soumission correcte échouait avec un diagnostic
        // qui ne désigne pas la cause.
        assertThat(HarnessProjects.javaFileName("""
                /* Ancienne version :
                public class Brouillon { }
                */
                public class Solution { static int f() { return 1; } }
                """, "Solution")).isEqualTo("Solution.java");
        assertThat(HarnessProjects.javaFileName("""
                // class Essai1 { }
                class Reponse { }
                """, "Solution")).isEqualTo("Reponse.java");
        // Un « class » dans un BLOC DE TEXTE n'est pas une déclaration non plus.
        assertThat(HarnessProjects.javaFileName("""
                public class Solution {
                    static String aide() { return \"\"\"
                        class Piege { }
                        \"\"\"; }
                }
                """, "Solution")).isEqualTo("Solution.java");
    }

}
