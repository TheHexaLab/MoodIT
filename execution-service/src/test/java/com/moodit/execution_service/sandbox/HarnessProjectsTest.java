package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.TestCaseInput;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Dispositions de projet par langage envoyées au runner (#116) : structure, canaris, job.json. */
class HarnessProjectsTest {

    /**
     * Harnais au format FRAMEWORK : c'est lui qui exerce l'ancienne disposition (un seul
     * processus). Un harnais BOOLÉEN, lui, part sur le chemin non falsifiable — deux processus,
     * deux UID — et produit une disposition différente, couverte par ses propres tests.
     */
    private static final Map<String, String> HARNAIS_FRAMEWORK = Map.of(
            "Java", "@Test void t() { }",
            "C#", "[Test] public void T() { }",
            "Go", "func TestT(t *testing.T) {}",
            "Rust", "#[test] fn t() {}",
            "C", "MOODIT_TEST(t) { }",
            "C++", "MOODIT_TEST(t) { }");

    /** Harnais au format framework du langage visé. */
    private static String harnais(String language) {
        return HARNAIS_FRAMEWORK.getOrDefault(language, "MOODIT_TEST(t) { }");
    }

    /** Un cas dont le harnais est au format FRAMEWORK du langage visé (ancienne disposition). */
    private static List<TestCaseInput> oneCase(String language) {
        return List.of(new TestCaseInput("aire du rectangle",
                HARNAIS_FRAMEWORK.getOrDefault(language, "MOODIT_TEST(t) { }"), 2));
    }

    @Test
    void runner_language_resout_les_alias_et_rejette_les_interpretes() {
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
    void job_json_echappe_les_noms_de_cas() {
        HarnessProjects.Project project = HarnessProjects.build("Java", "class A {}",
                List.of(new TestCaseInput("nom \"piégé\"\navec\tsaut", "h", 1),
                        new TestCaseInput("anti\\slash\rretour\u0001contrôle", "h", 1)), null);
        assertThat(project.files().get("job.json"))
                .contains("\"name\":\"nom \\\"piégé\\\"\\navec\\tsaut\"")
                .contains("\"name\":\"anti\\\\slash\\rretour\\u0001contrôle\"");
    }

    @Test
    void chaque_langage_a_un_gabarit_de_canari() {
        for (String language : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            Map<String, String> files = HarnessProjects.build(language, "code", oneCase(language), null).files();
            boolean canaryPresent = files.entrySet().stream()
                    .anyMatch(e -> e.getKey().startsWith("cases/1/") && e.getValue().contains("__MOODIT_A__"));
            assertThat(canaryPresent).as("canari de " + language).isTrue();
        }
    }

    @Test
    void chaque_langage_depose_le_code_soumis_et_le_harnais_marque() {
        // Seule disposition : le code soumis dans son fichier, le harnais du prof dans un AUTRE,
        // précédé du marqueur. Le superviseur compile le second dans le noteur, le premier dans
        // le serveur — deux programmes, deux UID. Les douze tests de disposition du format
        // framework que ce test remplace décrivaient un chemin falsifiable, retiré de #116.
        record Attendu(String langage, String fichierSoumis, String extensionHarnais) { }
        for (Attendu a : List.of(
                new Attendu("Java", "Solution.java", "java"),
                new Attendu("C#", "solution.cs", "cs"),
                new Attendu("Go", "main.go", "go"),
                new Attendu("Rust", "solution.rs", "rs"),
                new Attendu("C", "solution.c", "c"),
                new Attendu("C++", "solution.cpp", "cpp"))) {
            Map<String, String> files = HarnessProjects
                    .build(a.langage(), codeSoumis(a.langage()), oneCase(a.langage()), null)
                    .files();
            assertThat(files).as("code soumis de " + a.langage())
                    .containsKey("cases/0/src/" + a.fichierSoumis());
            String harnais = files.get("cases/0/src/harnais_rpc." + a.extensionHarnais());
            assertThat(harnais).as("harnais marqué de " + a.langage())
                    .isNotNull()
                    .contains("__MOODIT_HARNAIS__");
            // Le harnais n'est JAMAIS dans le fichier du code soumis : c'est tout l'intérêt.
            assertThat(files.get("cases/0/src/" + a.fichierSoumis()))
                    .doesNotContain("__MOODIT_HARNAIS__");
        }
    }

    /** Code soumis minimal déclarant une entrée marshalable, par langage. */
    private static String codeSoumis(String langue) {
        return switch (langue) {
            case "Java" -> "public class Solution { static int doubler(int n) { return n * 2; } }";
            case "C#" -> "class Solution { static int doubler(int n) { return n * 2; } }";
            case "Go" -> "package main\n\nfunc doubler(n int) int { return n * 2 }\n";
            case "Rust" -> "fn doubler(n: i32) -> i32 { n * 2 }\n";
            default -> "int doubler(int n) { return n * 2; }";
        };
    }

    @Test
    void nom_de_cas_null_devient_une_chaine_json_vide() {
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
     * chaque colonne fait foi. Désigner {@code V9} en dur laisserait ce test vert sur un contenu
     * périmé dès qu'une migration ultérieure retoucherait un gabarit — le défaut repasserait.
     */
    @Test
    void chaque_gabarit_de_harnais_appelle_une_entree_que_le_code_de_depart_declare()
            throws java.io.IOException {
        java.util.List<String> migrations = migrationsParVersion();

        for (String langue : List.of("Java", "C#", "Go", "Rust", "C", "C++")) {
            String gabarit = valeurEffective(migrations, "('" + langue + "', $hc$", "$hc$");
            assertThat(gabarit).as("gabarit de harnais de " + langue).isNotEmpty();
            // Ancré sur « == ATTENDU » : le point d'entrée est le dernier identifiant suivi de
            // « ( » AVANT cette comparaison. Prendre le premier de la ligne désignerait `abs`
            // dans un `Math.abs(solution(3) - 7.0) < 1e-9`.
            String expression = gabarit.lines()
                    .map(String::strip)
                    .filter(l -> l.contains("== ATTENDU"))
                    .findFirst()
                    .orElseThrow(() -> new AssertionError(
                            "le gabarit de " + langue + " ne compare plus à ATTENDU : "
                                    + "ancrer ce test autrement"));
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\w+)\\s*\\(")
                    .matcher(expression.substring(0, expression.indexOf("== ATTENDU")));
            String entree = null;
            while (m.find()) {
                entree = m.group(1);
            }
            assertThat(entree).as("appel lisible dans le gabarit de " + langue).isNotNull();

            String depart = valeurEffective(migrations, "('" + langue + "',", "$sc$");
            assertThat(depart).as("code de départ de " + langue).isNotEmpty();
            // Hors commentaires : un commentaire qui contiendrait le mot ne vaut pas déclaration.
            String code = depart.lines()
                    .filter(l -> !l.strip().startsWith("//") && !l.strip().startsWith("#"))
                    .reduce("", (a, b) -> a + "\n" + b);
            assertThat(code)
                    .as("le gabarit de " + langue + " appelle " + entree
                            + "(), que le code de départ doit déclarer")
                    .contains(entree);
        }
    }

    /** Contenu des migrations {@code db/migration/V*.sql}, par numéro de version croissant. */
    private static java.util.List<String> migrationsParVersion() throws java.io.IOException {
        java.util.TreeMap<Integer, String> parVersion = new java.util.TreeMap<>();
        try (var fichiers = java.nio.file.Files.list(
                java.nio.file.Path.of("..", "db", "migration"))) {
            for (java.nio.file.Path p : fichiers.toList()) {
                String nom = p.getFileName().toString();
                java.util.regex.Matcher v = java.util.regex.Pattern.compile("^V(\\d+)__")
                        .matcher(nom);
                if (nom.endsWith(".sql") && v.find()) {
                    parVersion.put(Integer.parseInt(v.group(1)),
                            java.nio.file.Files.readString(p));
                }
            }
        }
        assertThat(parVersion).as("migrations trouvées").isNotEmpty();
        return List.copyOf(parVersion.values());
    }

    /**
     * Valeur EFFECTIVE d'un gabarit : les migrations sont rejouées dans l'ordre et le dernier bloc
     * non vide gagne.
     *
     * <p>Une migration met à jour un SOUS-ENSEMBLE de langages — {@code V8} ne retouche que
     * JavaScript. Prendre « la dernière migration qui écrit la colonne » désignerait donc un
     * fichier où le langage cherché est absent : c'est ce que faisait la première version de ce
     * test, et elle échouait sur Java.
     */
    private static String valeurEffective(java.util.List<String> migrations, String debut,
            String delimiteur) {
        String valeur = "";
        for (String migration : migrations) {
            String trouve = bloc(migration, debut, delimiteur);
            if (!trouve.isEmpty()) {
                valeur = trouve;
            }
        }
        return valeur;
    }

    /** Contenu entre le premier {@code $…$} qui suit {@code debut}. */
    private static String bloc(String texte, String debut, String delimiteur) {
        int i = texte.indexOf(debut);
        if (i < 0) {
            return "";
        }
        int j = texte.indexOf(delimiteur, i + debut.length() - delimiteur.length());
        if (j < 0) {
            return "";
        }
        int k = texte.indexOf(delimiteur, j + delimiteur.length());
        return k < 0 ? "" : texte.substring(j + delimiteur.length(), k);
    }

    @Test
    void un_class_en_commentaire_ne_leurre_pas_le_nom_du_fichier() {
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
