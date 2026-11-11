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
    void java_nomme_les_fichiers_selon_la_classe_publique() {
        HarnessProjects.Project project = HarnessProjects.build("Java",
                "public class Solution { }",
                List.of(new TestCaseInput("t", "class MonHarnais { @Test void t() { } }", 1)), null);
        assertThat(project.files()).containsKey("cases/0/src/Solution.java");
        assertThat(project.files()).containsKey("cases/0/src/MonHarnais.java");
    }

    @Test
    void java_fallback_quand_aucune_classe_detectee() {
        assertThat(HarnessProjects.javaFileName("du texte sans classe", "Solution"))
                .isEqualTo("Solution.java");
        assertThat(HarnessProjects.javaFileName("record Point(int x) { }", "S")).isEqualTo("Point.java");
    }

    @Test
    void go_pose_module_code_et_test_dans_le_meme_package() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main", oneCase("Go"), null);
        assertThat(project.files().get("cases/0/src/go.mod")).contains("module moodit");
        assertThat(project.files().get("cases/0/src/main.go")).isEqualTo("package main");
        assertThat(project.files().get("cases/0/src/solution_test.go")).isEqualTo(harnais("Go"));
    }

    @Test
    void rust_concatene_etudiant_et_module_de_tests() {
        HarnessProjects.Project project = HarnessProjects.build("Rust", "fn main() {}", oneCase("Rust"), null);
        assertThat(project.files().get("cases/0/src/Cargo.toml")).contains("name = \"moodit\"");
        assertThat(project.files().get("cases/0/src/src/lib.rs"))
                .startsWith("fn main() {}").contains(harnais("Rust"));
    }

    @Test
    void c_et_cpp_incluent_l_etudiant_avec_main_neutralise() {
        for (String language : List.of("C", "C++")) {
            String ext = language.equals("C") ? "c" : "cpp";
            HarnessProjects.Project project = HarnessProjects.build(language, "CODE", oneCase(language), null);
            assertThat(project.files().get("cases/0/src/solution." + ext)).isEqualTo("CODE");
            String harness = project.files().get("cases/0/src/harness." + ext);
            assertThat(harness)
                    .contains("#define main __moodit_student_main")
                    .contains("#include \"solution." + ext + "\"")
                    .contains("#undef main")
                    .contains("#include <moodit_check.h>")
                    .contains(harnais(language));
        }
    }

    @Test
    void csharp_genere_le_point_d_entree_nunitlite() {
        HarnessProjects.Project project = HarnessProjects.build("C#", "CODE", oneCase("C#"), null);
        assertThat(project.files().get("cases/0/src/solution.cs")).isEqualTo("CODE");
        assertThat(project.files().get("cases/0/src/harness.cs")).isEqualTo(harnais("C#"));
        assertThat(project.files().get("cases/0/src/moodit_runner.cs"))
                .contains("class MooditRunner").contains("NUnitLite.AutoRun");
    }

    @Test
    void chaque_disposition_porte_le_jeton_de_fin_d_execution() {
        // Le gabarit __MOODIT_T__ (substitué par le superviseur) doit être émis par le POINT DE
        // SORTIE du framework de chaque langage — c'est lui qui trahit un forgeage déclenché
        // depuis la fonction notée (invisible aux canaris).
        // Java et C# : le jeton n'est PLUS dans la source — substitué, il devenait une
        // constante en clair de classes/*.class et de tests.exe, artefacts que le superviseur
        // DOIT ouvrir à l'UID étudiant (chargement par la JVM / mono). Le code noté le lisait
        // et forgeait le verdict complet, sans lecture traçable. Il arrive donc par stdin
        // (tube), et le verdict part sur le descripteur BRUT.
        String enveloppeJava = HarnessProjects.build("Java", "class Solution {}", oneCase("Java"), null)
                .files().get("cases/0/src/MooditEnveloppe.java");
        assertThat(enveloppeJava).doesNotContain("__MOODIT_T__");
        // Jeton par stdin, verdict sur les DEUX descripteurs bruts (fermer un seul des flux
        // standards ne doit pas faire disparaître le verdict d'une réponse juste).
        assertThat(enveloppeJava).contains("System.in")
                .contains("FileDescriptor.out").contains("FileDescriptor.err");
        String enveloppeCs = HarnessProjects.build("C#", "CODE", oneCase("C#"), null)
                .files().get("cases/0/src/moodit_runner.cs");
        assertThat(enveloppeCs).doesNotContain("__MOODIT_T__");
        // Lecture BRUTE de stdin + effacement du tampon : Console.In garderait le jeton dans
        // ses tampons managés, atteignables par réflexion (mono n'a pas de modules).
        assertThat(enveloppeCs).doesNotContain("Console.In.ReadLine");
        assertThat(enveloppeCs).contains("OpenStandardInput").contains("Array.Clear")
                .contains("OpenStandardOutput").contains("OpenStandardError");
        // Go garde la substitution : son init() étudiant tourne AVANT toute instruction de
        // l'enveloppe, donc une livraison par stdin serait lisible par le code noté en premier.
        assertThat(HarnessProjects.build("Go", "package main", oneCase("Go"), null).files()
                .get("cases/0/src/moodit_main_test.go")).contains("jeton=__MOODIT_T__");
        assertThat(HarnessProjects.build("Rust", "fn main() {}", oneCase("Rust"), null).files()
                .get("cases/0/src/src/lib.rs")).contains("zzzz_moodit_jeton");
        assertThat(HarnessProjects.build("C", "CODE", oneCase("C"), null).files()
                .get("cases/0/src/harness.c")).contains("#define MOODIT_JETON \"__MOODIT_T__\"");
    }

    @Test
    void enveloppe_java_decalee_si_une_classe_etudiante_porte_son_nom() {
        HarnessProjects.Project project = HarnessProjects.build("Java",
                "public class MooditEnveloppe { }", oneCase("Java"), null);
        // Le code étudiant garde son fichier ; l'enveloppe est décalée, rien n'est écrasé.
        assertThat(project.files().get("cases/0/src/MooditEnveloppe.java"))
                .isEqualTo("public class MooditEnveloppe { }");
        assertThat(project.files().get("cases/0/src/MooditEnveloppe_moodit.java"))
                .contains("class MooditMain").contains("[MOODIT] jeton=");
    }

    @Test
    void deux_canaris_embarquant_le_code_etudiant_sont_ajoutes() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main", oneCase("Go"), 5000);
        // Cas réels 0..N-1, canaris N (pass) et N+1 (fail), chacun AVEC le code étudiant.
        assertThat(project.files().get("cases/1/src/main.go")).isEqualTo("package main");
        assertThat(project.files().get("cases/1/src/solution_test.go"))
                .contains("__MOODIT_A__").contains("__MOODIT_B__");
        assertThat(project.files().get("cases/2/src/solution_test.go")).contains("__MOODIT_A__");
        // Le NOM du test canari est lui aussi un gabarit substitué au runtime (anti-reconnaissance).
        assertThat(project.files().get("cases/1/src/solution_test.go")).contains("Test__MOODIT_N__");
        String job = project.files().get("job.json");
        assertThat(job).contains("\"timeout_ms\":5000")
                .contains("{\"index\":1,\"canary\":\"pass\"}")
                .contains("{\"index\":2,\"canary\":\"fail\"}");
        assertThat(project.caseCount()).isEqualTo(1);
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
    void entrees_nulles_et_collision_de_harnais_java() {
        // Code et harnais null : traités comme des chaînes vides, aucune NPE.
        HarnessProjects.Project vide = HarnessProjects.build("C", null,
                List.of(new TestCaseInput("t", null, 1)), null);
        assertThat(vide.files().get("cases/0/src/solution.c")).isEmpty();

        // Même classe publique des deux côtés : le harnais est décalé, rien n'est écrasé.
        HarnessProjects.Project collision = HarnessProjects.build("Java",
                "public class Meme {}", List.of(new TestCaseInput("t", "public class Meme { @Test void t() { } }", 1)),
                null);
        assertThat(collision.files()).containsKey("cases/0/src/Meme.java");
        assertThat(collision.files()).containsKey("cases/0/src/MooditHarnais_Meme.java");
    }

    @Test
    void nom_de_cas_null_devient_une_chaine_json_vide() {
        HarnessProjects.Project project = HarnessProjects.build("Go", "package main",
                List.of(new TestCaseInput(null, "func TestT(t *testing.T) {}", 1)), null);
        assertThat(project.files().get("job.json")).contains("\"name\":\"\"");
    }

    @Test
    void types_du_code_etudiant_declares_dans_le_job() {
        // Le superviseur EXCLUT ces conteneurs : sans cela, les tests unitaires de
        // l'étudiant (compilés dans la même unité) comptaient dans le verdict du cas réel.
        // Exclure plutôt que sélectionner : une extraction incomplète ne peut que
        // réintroduire ce défaut, jamais n'exécuter aucun test du prof et offrir la note.
        assertThat(HarnessProjects.studentTypes("java", "class Solution { }"))
                .containsExactly("Solution");
        assertThat(HarnessProjects.studentTypes("csharp",
                "public class A { }\ninternal class B { }")).containsExactly("A", "B");
        assertThat(HarnessProjects.studentTypes("rust", "#[cfg(test)]\nmod mes_tests { }"))
                .containsExactly("mes_tests");
        // Go et C/C++ : non concernés (un TestXxx de l'étudiant n'est pas un test `go test`).
        assertThat(HarnessProjects.studentTypes("go", "func TestA(t *testing.T) {}")).isEmpty();
        assertThat(HarnessProjects.studentTypes("c", "MOODIT_TEST(t) { }")).isEmpty();
        // Rien d'extractible → liste vide : aucune exclusion, comportement d'origine.
        assertThat(HarnessProjects.studentTypes("java", "// vide")).isEmpty();

        // Noms PLEINEMENT QUALIFIÉS et types de niveau racine seulement : un nom imbriqué
        // ou non qualifié ne désignerait pas la bonne classe à l'exclusion.
        assertThat(HarnessProjects.studentTypes("java",
                "class Solution {\n    record Point(int x, int y) {}\n}"))
                .containsExactly("Solution");
        assertThat(HarnessProjects.studentTypes("java",
                "package devoir.un;\n\npublic class Solution { }"))
                .containsExactly("devoir.un.Solution");
        assertThat(HarnessProjects.studentTypes("csharp",
                "namespace Devoir;\npublic class Solution { }"))
                .containsExactly("Devoir.Solution");

        assertThat(HarnessProjects.build("Rust", "fn main() {}", oneCase("Rust"), null).files()
                .get("job.json")).contains("\"student_types\":[");
    }


    @Test
    void un_type_etudiant_qui_filtrerait_le_harnais_n_est_pas_exclu() {
        // L'extraction est textuelle sur un texte que l'étudiant contrôle : un nom qui
        // coïncide avec un conteneur du harnais (ou qui le filtrerait par sous-chaîne en
        // Rust) est écarté — au pire ses tests comptent, jamais la note n'est offerte.
        assertThat(HarnessProjects.safeStudentTypes("csharp",
                "/*\npublic class Harnais\n*/\npublic class Solution { }",
                "public class Harnais { }")).containsExactly("Solution");
        assertThat(HarnessProjects.safeStudentTypes("java",
                "class Harnais { }\nclass Solution { }", "class Harnais { }"))
                .containsExactly("Solution");
        // Rust : un module court n'a plus besoin d'être écarté — la sélection se fait par
        // nom EXACT depuis `--list` (premier segment), « s » ne peut plus filtrer « harnais ».
        assertThat(HarnessProjects.safeStudentTypes("rust",
                "#[cfg(test)]\nmod s { }", "#[cfg(test)]\nmod harnais { }")).containsExactly("s");
        assertThat(HarnessProjects.safeStudentTypes("rust",
                "#[cfg(test)]\nmod mes_tests { }", "#[cfg(test)]\nmod harnais { }"))
                .containsExactly("mes_tests");
    }

    @Test
    void harnais_rust_avec_des_tests_racine_n_active_pas_l_exclusion() {
        // En Rust un test est identifié par son MODULE : un #[test] au niveau racine
        // serait rapporté sous le nom de sa fonction, que l'invariant ne reconnaîtrait
        // pas → 0 pour un code correct. Liste vide = aucune exclusion, tous les tests
        // tournent, l'invariant est satisfait par construction.
        assertThat(HarnessProjects.harnessTypes("rust",
                "mod aides { }\n#[test]\nfn d() { }")).isEmpty();
        assertThat(HarnessProjects.safeStudentTypes("rust", "#[cfg(test)]\nmod a { }",
                "mod aides { }\n#[test]\nfn d() { }")).isEmpty();
        // Un #[test] INDENTÉ est dans un module : la forme normale reste exploitée.
        assertThat(HarnessProjects.harnessTypes("rust",
                "#[cfg(test)]\nmod harnais {\n    #[test]\n    fn d() { }\n}")).containsExactly("harnais");
    }

    @Test
    void les_enveloppes_publient_le_code_du_framework_sur_la_ligne_du_jeton() {
        // Le rapport du framework vit sous work/ (possédé par l'étudiant) et le code de
        // sortie du processus s'écrase après coup : le verdict doit voyager sur la ligne
        // du jeton, qu'une ligne déjà émise rend infalsifiable sans connaître le jeton.
        // Java/C# : jeton reçu sur stdin, verdict publié sur le descripteur BRUT (fd 1) — un
        // System.setOut()/Console.SetOut() du code noté voyait sinon passer la ligne et n'avait
        // qu'à y réécrire « code=1 » en « code=0 », sans même connaître le jeton.
        assertThat(HarnessProjects.build("Java", "class Solution { }", oneCase("Java"), null)
                .files().get("cases/0/src/MooditEnveloppe.java"))
                .contains("String verdict = \"[MOODIT] jeton=\" + jeton + \" code=\" + code")
                .contains("brut.println(verdict)").contains("brutErr.println(verdict)")
                .contains("new FileOutputStream(FileDescriptor.out)");
        assertThat(HarnessProjects.build("C#", "class Solution { }", oneCase("C#"), null)
                .files().get("cases/0/src/moodit_runner.cs"))
                .contains("string verdict = \"[MOODIT] jeton=\" + jeton + \" code=\" + code")
                .contains("brut.WriteLine(verdict)").contains("brutErr.WriteLine(verdict)")
                .contains("Console.OpenStandardOutput()");
        assertThat(HarnessProjects.build("Go", "package main", oneCase("Go"), null)
                .files().get("cases/0/src/moodit_main_test.go"))
                .contains("jeton=__MOODIT_T__ code=%d");
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
}
