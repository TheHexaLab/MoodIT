package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

/**
 * Assemble {@code code étudiant + harnais} en un programme exécutable dont l'EXIT CODE traduit le
 * verdict (0 = réussi, non-zéro = échec) — Piston ne renvoie que stdout/stderr/exit, pas de valeur
 * de retour. Le contrat du harnais (le corps RENVOIE un booléen ; une exception/panic vaut échec)
 * est enveloppé ici, PAR LANGAGE, en miroir des {@code harness_template} semés en base.
 *
 * <p>Langages exécutables pris en charge : Python, JavaScript, TypeScript, Bash, PHP, Go, Rust, C,
 * C++, C#, Java. Les langages « données/vues » (HTML, JSON, JSX, TSX) et SQL relèvent d'un autre
 * contrat (hôte JS / comparaison de sortie) et ne sont pas encore gérés ici.
 */
@Component
public class CodeAssembler {

    /** Programme prêt pour Piston : langage Piston + fichiers. */
    public record Assembled(String pistonLanguage, List<PistonClient.File> files) {}

    public Assembled assemble(String language, String studentCode, String harnessCode) {
        String code = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;
        return switch (canon(language)) {
            case "python" -> assemblePython(code, harness);
            case "javascript" -> assembleJs("javascript", "main.js", code, harness, false);
            case "typescript" -> assembleJs("typescript", "main.ts", code, harness, true);
            case "php" -> assemblePhp(code, harness);
            case "bash" -> assembleBash(code, harness);
            case "go" -> assembleGo(code, harness);
            case "rust" -> assembleRust(code, harness);
            case "c" -> assembleC(code, harness);
            case "c++" -> assembleCpp(code, harness);
            case "csharp" -> assembleCSharp(code, harness);
            case "java" -> assembleJava(code, harness);
            default -> throw new UnsupportedLanguageException(language);
        };
    }

    /**
     * Assemble le code pour une EXÉCUTION SIMPLE (sans harnais) : on lance le programme TEL QUEL et
     * on renvoie sa sortie. Pour les langages compilés, il faut un point d'entrée (main) — s'il
     * manque, l'erreur de compilation est renvoyée telle quelle (résultat honnête du « run »).
     */
    public Assembled assembleRun(String language, String studentCode) {
        String code = studentCode == null ? "" : studentCode;
        return switch (canon(language)) {
            case "python" -> run("python", "main.py", code);
            case "javascript" -> run("javascript", "main.js", code);
            case "typescript" -> run("typescript", "main.ts", code);
            case "php" -> run("php", "main.php", code);
            case "bash" -> run("bash", "main.sh", code);
            case "go" -> run("go", "main.go", code);
            case "rust" -> run("rust", "main.rs", code);
            case "c" -> run("c", "main.c", code);
            case "c++" -> run("c++", "main.cpp", code);
            case "csharp" -> run("csharp", "main.cs", code);
            case "java" -> run("java", javaFileName(code), code);
            default -> throw new UnsupportedLanguageException(language);
        };
    }

    // ── Utilitaires ────────────────────────────────────────────────────────────

    /** Nom de langage normalisé (minuscules, alias unifiés) pour le switch d'assemblage. */
    private static String canon(String language) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return switch (lang) {
            case "js", "node" -> "javascript";
            case "ts" -> "typescript";
            case "cpp", "cplusplus" -> "c++";
            case "cs", "c-sharp", "csharp", "c#" -> "csharp";
            case "shell", "sh" -> "bash";
            case "golang" -> "go";
            default -> lang;
        };
    }

    private static Assembled run(String pistonLanguage, String fileName, String code) {
        return new Assembled(pistonLanguage, List.of(new PistonClient.File(fileName, code)));
    }

    /** Indente chaque ligne non vide par {@code prefix} (préserve l'indentation relative). */
    private static String indent(String code, String prefix) {
        return code.lines()
                .map(line -> line.isBlank() ? "" : prefix + line)
                .collect(Collectors.joining("\n"));
    }

    // ── Python ─────────────────────────────────────────────────────────────────

    /**
     * Python : code étudiant, puis harnais enveloppé dans une fonction appelée ; son booléen de
     * retour → exit 0/1, toute exception → exit 1. Le harnais est un CORPS de fonction (indenté).
     */
    private Assembled assemblePython(String studentCode, String harnessCode) {
        String program = studentCode
                + "\n\n\ndef __moodit_harness():\n"
                + indent(harnessCode, "    ")
                + "\n\nimport sys as __moodit_sys\n"
                + "try:\n"
                + "    __moodit_result = __moodit_harness()\n"
                + "    __moodit_sys.exit(0 if __moodit_result else 1)\n"
                + "except SystemExit:\n"
                + "    raise\n"
                + "except BaseException:\n"
                + "    __moodit_sys.exit(1)\n";
        return new Assembled("python", List.of(new PistonClient.File("main.py", program)));
    }

    // ── JavaScript / TypeScript ─────────────────────────────────────────────────

    /**
     * JS/TS : code étudiant (fonctions au niveau module), puis harnais dans une fonction appelée.
     * Retour booléen → exit 0/1 ; un throw → stderr + exit 1. En TypeScript, {@code // @ts-nocheck}
     * garantit la compilation du wrapper (l'objectif est d'exécuter et de conclure, pas de
     * typer) — une erreur de type se traduirait sinon en échec de compilation parasite.
     */
    private Assembled assembleJs(String pistonLanguage, String fileName, String studentCode,
                                 String harnessCode, boolean typescript) {
        String header = typescript ? "// @ts-nocheck\n" : "";
        String program = header
                + studentCode
                + "\n\nfunction __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  const __moodit_result = __moodit_harness();\n"
                + "  process.exit(__moodit_result ? 0 : 1);\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error(__moodit_e && __moodit_e.stack ? __moodit_e.stack : String(__moodit_e));\n"
                + "  process.exit(1);\n"
                + "}\n";
        return new Assembled(pistonLanguage, List.of(new PistonClient.File(fileName, program)));
    }

    // ── PHP ──────────────────────────────────────────────────────────────────────

    /**
     * PHP : le code étudiant ouvre déjà {@code <?php} ; on ajoute à la suite (même mode PHP) le
     * harnais dans une fonction, exécutée : retour booléen → exit 0/1, {@code Throwable} → exit 1.
     */
    private Assembled assemblePhp(String studentCode, String harnessCode) {
        String program = studentCode
                + "\n\nfunction __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  $__moodit_result = __moodit_harness();\n"
                + "  exit($__moodit_result ? 0 : 1);\n"
                + "} catch (\\Throwable $__moodit_e) {\n"
                + "  fwrite(STDERR, (string) $__moodit_e);\n"
                + "  exit(1);\n"
                + "}\n";
        return new Assembled("php", List.of(new PistonClient.File("main.php", program)));
    }

    // ── Bash ─────────────────────────────────────────────────────────────────────

    /**
     * Bash : le script étudiant définit ses fonctions ; le harnais qui suit produit un CODE DE
     * SORTIE (0 = réussi). On termine sur le statut du harnais. {@code set -e} laisse une erreur
     * intermédiaire échouer.
     */
    private Assembled assembleBash(String studentCode, String harnessCode) {
        String program = studentCode
                + "\n\n# --- harnais ---\n"
                + harnessCode
                + "\nexit $?\n";
        return new Assembled("bash", List.of(new PistonClient.File("main.sh", program)));
    }

    // ── Go ───────────────────────────────────────────────────────────────────────

    /**
     * Go : on neutralise le {@code func main} de l'étudiant (renommé) pour installer le nôtre, qui
     * appelle le harnais. Réussi → sortie normale (exit 0) ; échec → {@code panic} (exit non nul) —
     * ainsi aucun import supplémentaire (os/fmt) n'est requis, évitant les conflits d'imports.
     */
    private Assembled assembleGo(String studentCode, String harnessCode) {
        String neutralized = studentCode.replaceAll("func\\s+main\\s*\\(", "func __moodit_student_main(");
        String program = neutralized
                + "\n\nfunc __moodit_harness() bool {\n"
                + harnessCode
                + "\n}\n"
                + "func main() {\n"
                + "\tif !__moodit_harness() {\n"
                + "\t\tpanic(\"harnais: echec\")\n"
                + "\t}\n"
                + "}\n";
        return new Assembled("go", List.of(new PistonClient.File("main.go", program)));
    }

    // ── Rust ─────────────────────────────────────────────────────────────────────

    /**
     * Rust : on neutralise le {@code fn main} éventuel de l'étudiant, puis notre main asserte le
     * harnais (dernière expression = valeur de retour). {@code assert!} panique (exit non nul) si
     * faux ; un {@code panic!} de l'étudiant vaut aussi échec. Aucun import requis.
     */
    private Assembled assembleRust(String studentCode, String harnessCode) {
        String neutralized = studentCode.replaceAll("fn\\s+main\\s*\\(", "fn __moodit_student_main(");
        String program = neutralized
                + "\n\nfn __moodit_harness() -> bool {\n"
                + harnessCode
                + "\n}\n"
                + "fn main() {\n"
                + "    assert!(__moodit_harness(), \"harnais: echec\");\n"
                + "}\n";
        return new Assembled("rust", List.of(new PistonClient.File("main.rs", program)));
    }

    // ── C ────────────────────────────────────────────────────────────────────────

    /**
     * C : le {@code main} de l'étudiant est renommé par macro ({@code #define main …}) avant son
     * code, puis rétabli. Le harnais renvoie un {@code int} (non nul = réussi, cf. contrat) ; notre
     * main en déduit l'exit code. Pas d'exceptions en C.
     */
    private Assembled assembleC(String studentCode, String harnessCode) {
        String program = "#define main __moodit_student_main\n"
                + studentCode
                + "\n#undef main\n"
                + "static int __moodit_harness(void) {\n"
                + harnessCode
                + "\n}\n"
                + "int main(void) { return __moodit_harness() != 0 ? 0 : 1; }\n";
        return new Assembled("c", List.of(new PistonClient.File("main.c", program)));
    }

    // ── C++ ──────────────────────────────────────────────────────────────────────

    /**
     * C++ : même bascule par macro que le C. Le harnais renvoie un {@code bool} ; une exception
     * (capturée) vaut échec (exit 1).
     */
    private Assembled assembleCpp(String studentCode, String harnessCode) {
        String program = "#define main __moodit_student_main\n"
                + studentCode
                + "\n#undef main\n"
                + "static bool __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "int main() {\n"
                + "    try { return __moodit_harness() ? 0 : 1; }\n"
                + "    catch (...) { return 1; }\n"
                + "}\n";
        return new Assembled("c++", List.of(new PistonClient.File("main.cpp", program)));
    }

    // ── C# ───────────────────────────────────────────────────────────────────────

    /**
     * C# : le {@code Main} de l'étudiant est renommé pour ne laisser qu'UN point d'entrée (le
     * nôtre). Le harnais renvoie un {@code bool} ; une exception vaut échec. On qualifie tout via
     * {@code System.*} pour ne dépendre d'aucun {@code using} supplémentaire.
     */
    private Assembled assembleCSharp(String studentCode, String harnessCode) {
        String neutralized = studentCode.replaceAll(
                "(static\\s+(?:void|int)\\s+)Main(\\s*\\()", "$1__moodit_student_main$2");
        String program = neutralized
                + "\n\nclass __MooditHarness {\n"
                + "    static bool __moodit_run() {\n"
                + harnessCode
                + "\n    }\n"
                + "    static int Main() {\n"
                + "        try { return __moodit_run() ? 0 : 1; }\n"
                + "        catch (System.Exception __e) { System.Console.Error.WriteLine(__e); return 1; }\n"
                + "    }\n"
                + "}\n";
        return new Assembled("csharp", List.of(new PistonClient.File("main.cs", program)));
    }

    // ── Java ─────────────────────────────────────────────────────────────────────

    /**
     * Java : Piston exécute en mode « fichier-source unique » ({@code java Fichier.java}), donc la
     * PREMIÈRE classe top-level doit porter le {@code main} (JEP 330) — ce mode tolère plusieurs
     * classes publiques, donc on n'a PAS à toucher aux classes de l'étudiant (POO, abstract,
     * interface… restent valides). Notre classe d'entrée {@code __MooditMain} (nom improbable pour
     * ne pas heurter une classe étudiant, ex. « Main ») vient EN PREMIER ; on neutralise seulement
     * le {@code main} étudiant pour éviter deux entrées. Le harnais référence les classes étudiant
     * (ex. {@code new Rectangle(...)}, {@code Solution.solution(...)}).
     */
    private Assembled assembleJava(String studentCode, String harnessCode) {
        String neutralized = studentCode
                .replaceAll("(static\\s+void\\s+)main(\\s*\\(\\s*String)", "$1__moodit_student_main$2");
        String program = "public class __MooditMain {\n"
                + "    static boolean __moodit_harness() {\n"
                + harnessCode
                + "\n    }\n"
                + "    public static void main(String[] __args) {\n"
                + "        try {\n"
                + "            System.exit(__moodit_harness() ? 0 : 1);\n"
                + "        } catch (Throwable __t) {\n"
                + "            __t.printStackTrace();\n"
                + "            System.exit(1);\n"
                + "        }\n"
                + "    }\n"
                + "}\n\n"
                + neutralized
                + "\n";
        return new Assembled("java", List.of(new PistonClient.File("Main.java", program)));
    }

    /**
     * Nom de fichier pour un « run » Java : la classe publique doit correspondre au fichier
     * ({@code Solution} → {@code Solution.java}). À défaut, {@code Main.java}.
     */
    private static String javaFileName(String studentCode) {
        var matcher = java.util.regex.Pattern
                .compile("public\\s+class\\s+(\\w+)").matcher(studentCode);
        return matcher.find() ? matcher.group(1) + ".java" : "Main.java";
    }
}
