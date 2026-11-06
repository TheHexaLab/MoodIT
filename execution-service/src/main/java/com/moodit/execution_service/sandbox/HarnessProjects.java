package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.TestCaseInput;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Construit l'ARBORESCENCE DE PROJET envoyée au conteneur runner d'un langage compilé (#116) :
 * un dossier {@code cases/<i>/src/} par harnais, dans la disposition NATIVE du framework de test
 * du langage — le harnais du prof est un VRAI test (JUnit, NUnit, go test, cargo test,
 * moodit_check.h), le code étudiant un vrai fichier source à côté. Aucune génération de code :
 * la POO, les champs privés, les génériques… sont du simple code de test.
 *
 * Deux CANARIS sont ajoutés en fin de liste (indices N et N+1) : des cas dont le harnais est un
 * gabarit {@code __MOODIT_A__ == __MOODIT_B__} que le SUPERVISEUR instancie à l'exécution avec
 * des valeurs tirées au sort — l'un doit réussir, l'autre échouer. Ils embarquent aussi le code
 * étudiant : un code qui détourne le framework (init/constructeur qui forge un rapport) casse
 * leurs résultats et se fait détecter.
 *
 * Le protocole miroir vit dans {@code docker/runners/common/supervisor.py} ; garder en phase.
 */
public final class HarnessProjects {

    private HarnessProjects() {
    }

    /** Projet prêt à copier dans /box : chemins relatifs → contenu, plus la liste des cas. */
    public record Project(String runnerLanguage, Map<String, String> files, int caseCount) {}

    /** Langage canonique du runner, ou exception si le langage n'est pas un compilé pris en charge. */
    public static String runnerLanguage(String language) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return switch (lang) {
            case "java" -> "java";
            case "cs", "c-sharp", "csharp", "c#" -> "csharp";
            case "go", "golang" -> "go";
            case "rust" -> "rust";
            case "c" -> "c";
            case "cpp", "cplusplus", "c++" -> "cpp";
            default -> throw new UnsupportedLanguageException(
                    "Langage compilé non pris en charge par le runner : " + language);
        };
    }

    public static Project build(String language, String studentCode, List<TestCaseInput> cases,
            Integer timeoutMs) {
        String lang = runnerLanguage(language);
        String code = studentCode == null ? "" : studentCode;
        Map<String, String> files = new LinkedHashMap<>();

        StringBuilder caseList = new StringBuilder();
        int index = 0;
        for (TestCaseInput testCase : cases) {
            addCase(files, lang, index, code, testCase.harnessCode() == null ? "" : testCase.harnessCode());
            caseList.append(index > 0 ? "," : "")
                    .append("{\"index\":").append(index)
                    .append(",\"name\":").append(jsonString(testCase.name())).append("}");
            index++;
        }
        // Canaris (voir javadoc) : harnais gabarit instancié par le superviseur.
        for (String kind : new String[] {"pass", "fail"}) {
            addCase(files, lang, index, code, canaryHarness(lang));
            caseList.append(",{\"index\":").append(index)
                    .append(",\"canary\":\"").append(kind).append("\"}");
            index++;
        }

        files.put("job.json", "{\"language\":\"" + lang + "\","
                + "\"timeout_ms\":" + (timeoutMs == null ? "null" : timeoutMs.toString()) + ","
                + "\"cases\":[" + caseList + "]}");
        return new Project(lang, files, cases.size());
    }

    // ── disposition par langage ───────────────────────────────────────────────

    private static void addCase(Map<String, String> files, String lang, int index,
            String studentCode, String harnessCode) {
        String base = "cases/" + index + "/src/";
        switch (lang) {
            case "java" -> {
                files.put(base + javaFileName(studentCode, "Solution"), studentCode);
                files.put(base + javaFileName(harnessCode, "MooditHarness"), harnessCode);
            }
            case "csharp" -> {
                files.put(base + "solution.cs", studentCode);
                files.put(base + "harness.cs", harnessCode);
                // Point d'entrée NUnitLite : exécute tous les [Test] de l'assemblage. Généré ici
                // (pas à la charge du prof) ; `mcs -main:MooditRunner` l'impose comme entrée même
                // si le code étudiant a son propre Main.
                files.put(base + "moodit_runner.cs", """
                        class MooditRunner
                        {
                            static int Main(string[] args)
                            {
                                return new NUnitLite.AutoRun(typeof(MooditRunner).Assembly).Execute(args);
                            }
                        }
                        """);
            }
            case "go" -> {
                files.put(base + "go.mod", "module moodit\n\ngo 1.23\n");
                files.put(base + "main.go", studentCode);
                // Même package que l'étudiant : les identifiants non exportés restent accessibles,
                // comme dans un vrai test Go.
                files.put(base + "solution_test.go", harnessCode);
            }
            case "rust" -> {
                files.put(base + "Cargo.toml", """
                        [package]
                        name = "moodit"
                        version = "0.1.0"
                        edition = "2021"
                        """);
                // Idiome Rust : module de tests DANS le fichier (use super::*) → accès aux items
                // privés du code étudiant, comme un vrai test unitaire.
                files.put(base + "src/lib.rs", studentCode + "\n\n" + harnessCode + "\n");
            }
            case "c", "cpp" -> {
                String ext = lang.equals("c") ? "c" : "cpp";
                files.put(base + "solution." + ext, studentCode);
                // Prélude généré : inclut le code étudiant (main neutralisé) + moodit_check.h ;
                // le harnais du prof ne contient que des MOODIT_TEST.
                files.put(base + "harness." + ext,
                        "/* Prélude MoodIT : code étudiant inclus (son main est renommé), puis le harnais. */\n"
                        + "#define main __moodit_student_main\n"
                        + "#include \"solution." + ext + "\"\n"
                        + "#undef main\n"
                        + "#include <moodit_check.h>\n\n"
                        + harnessCode);
            }
            default -> throw new UnsupportedLanguageException("Langage runner inconnu : " + lang);
        }
    }

    // ── canaris par langage (gabarits __MOODIT_A__/__MOODIT_B__, instanciés au runtime) ──

    private static String canaryHarness(String lang) {
        return switch (lang) {
            case "java" -> """
                    import org.junit.jupiter.api.Test;
                    import static org.junit.jupiter.api.Assertions.assertEquals;

                    class MooditCanary {
                        @Test
                        void canari() {
                            assertEquals(__MOODIT_A__, __MOODIT_B__);
                        }
                    }
                    """;
            case "csharp" -> """
                    using NUnit.Framework;

                    public class MooditCanary
                    {
                        [Test]
                        public void Canari()
                        {
                            Assert.That(__MOODIT_A__, Is.EqualTo(__MOODIT_B__));
                        }
                    }
                    """;
            case "go" -> """
                    package main

                    import "testing"

                    func TestMooditCanari(t *testing.T) {
                        if __MOODIT_A__ != __MOODIT_B__ {
                            t.Fatal("canari")
                        }
                    }
                    """;
            case "rust" -> """
                    #[cfg(test)]
                    mod moodit_canari {
                        #[test]
                        fn canari() {
                            assert_eq!(__MOODIT_A__, __MOODIT_B__);
                        }
                    }
                    """;
            case "c", "cpp" -> """
                    MOODIT_TEST(moodit_canari) {
                        MOODIT_CHECK(__MOODIT_A__ == __MOODIT_B__);
                    }
                    """;
            default -> throw new UnsupportedLanguageException("Langage runner inconnu : " + lang);
        };
    }

    // ── utilitaires ───────────────────────────────────────────────────────────

    private static final Pattern JAVA_PUBLIC_CLASS =
            Pattern.compile("(?m)^\\s*public\\s+(?:final\\s+|abstract\\s+)?(?:class|interface|record|enum)\\s+(\\w+)");
    private static final Pattern JAVA_ANY_CLASS =
            Pattern.compile("(?m)^\\s*(?:class|interface|record|enum)\\s+(\\w+)");

    /** Nom de fichier imposé par javac : celui de la classe publique, sinon la première classe. */
    static String javaFileName(String source, String fallback) {
        Matcher pub = JAVA_PUBLIC_CLASS.matcher(source);
        if (pub.find()) {
            return pub.group(1) + ".java";
        }
        Matcher any = JAVA_ANY_CLASS.matcher(source);
        if (any.find()) {
            return any.group(1) + ".java";
        }
        return fallback + ".java";
    }

    private static String jsonString(String value) {
        if (value == null) {
            return "\"\"";
        }
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}
