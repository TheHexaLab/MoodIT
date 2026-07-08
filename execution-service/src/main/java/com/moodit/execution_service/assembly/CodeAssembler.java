package com.moodit.execution_service.assembly;

import com.moodit.execution_service.piston.PistonClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Assemble {@code code étudiant + harnais} en un programme exécutable dont l'EXIT CODE traduit le
 * verdict (0 = réussi, non-zéro = échec) — Piston ne renvoie que stdout/stderr/exit, pas de valeur
 * de retour. Le contrat du harnais (le corps RENVOIE un booléen ; une exception/panic vaut échec)
 * est enveloppé ici, PAR LANGAGE, en miroir des {@code harness_template} semés en base.
 *
 * <p>Langages gérés (les 16) : Python, JavaScript, TypeScript, Bash, PHP, Go, Rust, C, C++, C#,
 * Java, JSON, SQL, HTML, JSX, TSX. Les langages « données/vues » sont validés par un harnais JS via
 * des libs EMBARQUÉES injectées dans la soumission : HTML → parseur DOM ({@code htmlparser.js},
 * {@code doc}) ; JSX/TSX → Babel + React + ReactDOMServer ({@code react-runtime.js}, rendu en
 * {@code html}). SQL → vues numérotées {@code solution1}, {@code solution2}… (une par requête) +
 * verdict sur la sortie (cf. ExecutionService).
 */
@Component
public class CodeAssembler {

    /** Bundles JS embarqués (cf. Dockerfile, étape jsvendor), chargés une fois puis mis en cache. */
    private final Path vendorDir;
    private final Map<String, String> vendorCache = new ConcurrentHashMap<>();

    public CodeAssembler(@Value("${app.vendor-dir:/app/vendor}") String vendorDir) {
        this.vendorDir = Path.of(vendorDir);
    }

    /** Contenu d'un bundle vendor (ex. htmlparser.js), lu depuis l'image et mémorisé. */
    private String vendor(String name) {
        return vendorCache.computeIfAbsent(name, n -> {
            try {
                return Files.readString(vendorDir.resolve(n));
            } catch (IOException e) {
                throw new UncheckedIOException("Bundle d'exécution introuvable : " + n, e);
            }
        });
    }

    /** Programme prêt pour Piston : langage Piston + fichiers. */
    public record Assembled(String pistonLanguage, List<PistonClient.File> files) {}

    public Assembled assemble(String language, String studentCode, String harnessCode, String nonce) {
        String code = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;
        return switch (canon(language)) {
            case "python" -> assemblePython(code, harness, nonce);
            case "javascript" -> assembleJs("javascript", "main.js", code, harness, false, nonce);
            case "typescript" -> assembleJs("typescript", "main.ts", code, harness, true, nonce);
            case "php" -> assemblePhp(code, harness, nonce);
            case "bash" -> assembleBash(code, harness, nonce);
            case "go" -> assembleGo(code, harness, nonce);
            case "rust" -> assembleRust(code, harness, nonce);
            case "c" -> assembleC(code, harness, nonce);
            case "c++" -> assembleCpp(code, harness, nonce);
            case "csharp" -> assembleCSharp(code, harness, nonce);
            case "java" -> assembleJava(code, harness, nonce);
            case "json" -> assembleJson(code, harness, nonce);
            case "sql" -> assembleSql(code, harness, nonce);
            case "html" -> assembleHtml(code, harness, nonce);
            case "jsx", "tsx" -> assembleJsx(code, harness, nonce);
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
            case "json" -> runJson(code);
            case "sql" -> run("sqlite3", "main.sql", code);
            default -> throw new UnsupportedLanguageException(language);
        };
    }

    // ── Utilitaires ────────────────────────────────────────────────────────────

    /** Vrai si le langage est SQL/SQLite (quelle que soit la casse ou l'alias). */
    public static boolean isSql(String language) {
        return "sql".equals(canon(language));
    }

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
            case "sqlite", "sqlite3" -> "sql";
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
    private Assembled assemblePython(String studentCode, String harnessCode, String nonce) {
        String program = studentCode
                + "\n\n\ndef __moodit_harness():\n"
                + indent(harnessCode, "    ")
                + "\n\nimport sys as __moodit_sys\n"
                + "try:\n"
                + "    __moodit_result = __moodit_harness()\n"
                + "    if __moodit_result:\n"
                + "        __moodit_sys.stderr.write(\"" + nonce + "\")\n"
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
                                 String harnessCode, boolean typescript, String nonce) {
        String header = typescript ? "// @ts-nocheck\n" : "";
        String program = header
                + studentCode
                + "\n\nfunction __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  const __moodit_result = __moodit_harness();\n"
                + "  if (__moodit_result) process.stderr.write(\"" + nonce + "\");\n"
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
    private Assembled assemblePhp(String studentCode, String harnessCode, String nonce) {
        String program = studentCode
                + "\n\nfunction __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  $__moodit_result = __moodit_harness();\n"
                + "  if ($__moodit_result) fwrite(STDERR, \"" + nonce + "\");\n"
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
     * SORTIE (0 = réussi), capturé dans {@code $?}. Le nonce n'est émis que si ce code vaut 0, et on
     * termine sur ce même code — le verdict ne dépend donc pas d'un {@code exit} anticipé de l'étudiant.
     */
    private Assembled assembleBash(String studentCode, String harnessCode, String nonce) {
        String program = studentCode
                + "\n\n# --- harnais ---\n"
                + harnessCode
                + "\n__moodit_rc=$?\n"
                + "[ \"$__moodit_rc\" -eq 0 ] && printf '%s' '" + nonce + "' >&2\n"
                + "exit \"$__moodit_rc\"\n";
        return new Assembled("bash", List.of(new PistonClient.File("main.sh", program)));
    }

    // ── Go ───────────────────────────────────────────────────────────────────────

    /**
     * Go : on neutralise le {@code func main} de l'étudiant (renommé) pour installer le nôtre, qui
     * appelle le harnais. Réussi → sortie normale (exit 0) ; échec → {@code panic} (exit non nul) —
     * ainsi aucun import supplémentaire (os/fmt) n'est requis, évitant les conflits d'imports.
     */
    private Assembled assembleGo(String studentCode, String harnessCode, String nonce) {
        String neutralized = studentCode.replaceAll("func\\s+main\\s*\\(", "func __moodit_student_main(");
        String program = neutralized
                + "\n\nfunc __moodit_harness() bool {\n"
                + harnessCode
                + "\n}\n"
                + "func main() {\n"
                + "\tif __moodit_harness() {\n"
                + "\t\tprint(\"" + nonce + "\")\n"
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
    private Assembled assembleRust(String studentCode, String harnessCode, String nonce) {
        String neutralized = studentCode.replaceAll("fn\\s+main\\s*\\(", "fn __moodit_student_main(");
        String program = neutralized
                + "\n\nfn __moodit_harness() -> bool {\n"
                + harnessCode
                + "\n}\n"
                + "fn main() {\n"
                + "    if __moodit_harness() {\n"
                + "        eprint!(\"" + nonce + "\");\n"
                + "    }\n"
                + "}\n";
        return new Assembled("rust", List.of(new PistonClient.File("main.rs", program)));
    }

    // ── C ────────────────────────────────────────────────────────────────────────

    /**
     * C : le {@code main} de l'étudiant est renommé par macro ({@code #define main …}) avant son
     * code, puis rétabli. Le harnais renvoie un {@code int} (non nul = réussi, cf. contrat) ; notre
     * main en déduit l'exit code. Pas d'exceptions en C.
     */
    private Assembled assembleC(String studentCode, String harnessCode, String nonce) {
        String program = "#define main __moodit_student_main\n"
                + studentCode
                + "\n#undef main\n"
                + "#include <stdio.h>\n"
                + "static int __moodit_harness(void) {\n"
                + harnessCode
                + "\n}\n"
                + "int main(void) {\n"
                + "    int __moodit_r = __moodit_harness();\n"
                + "    if (__moodit_r != 0) fputs(\"" + nonce + "\", stderr);\n"
                + "    return __moodit_r != 0 ? 0 : 1;\n"
                + "}\n";
        return new Assembled("c", List.of(new PistonClient.File("main.c", program)));
    }

    // ── C++ ──────────────────────────────────────────────────────────────────────

    /**
     * C++ : même bascule par macro que le C. Le harnais renvoie un {@code bool} ; une exception
     * (capturée) vaut échec (exit 1).
     */
    private Assembled assembleCpp(String studentCode, String harnessCode, String nonce) {
        String program = "#define main __moodit_student_main\n"
                + studentCode
                + "\n#undef main\n"
                + "#include <iostream>\n"
                + "static bool __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "int main() {\n"
                + "    try {\n"
                + "        if (__moodit_harness()) { std::cerr << \"" + nonce + "\"; return 0; }\n"
                + "        return 1;\n"
                + "    } catch (...) { return 1; }\n"
                + "}\n";
        return new Assembled("c++", List.of(new PistonClient.File("main.cpp", program)));
    }

    // ── C# ───────────────────────────────────────────────────────────────────────

    /**
     * C# : le {@code Main} de l'étudiant est renommé pour ne laisser qu'UN point d'entrée (le
     * nôtre). Le harnais renvoie un {@code bool} ; une exception vaut échec. On qualifie tout via
     * {@code System.*} pour ne dépendre d'aucun {@code using} supplémentaire.
     */
    private Assembled assembleCSharp(String studentCode, String harnessCode, String nonce) {
        String neutralized = studentCode.replaceAll(
                "(static\\s+(?:void|int)\\s+)Main(\\s*\\()", "$1__moodit_student_main$2");
        String program = neutralized
                + "\n\nclass __MooditHarness {\n"
                + "    static bool __moodit_run() {\n"
                + harnessCode
                + "\n    }\n"
                + "    static int Main() {\n"
                + "        try {\n"
                + "            if (__moodit_run()) { System.Console.Error.Write(\"" + nonce + "\"); return 0; }\n"
                + "            return 1;\n"
                + "        }\n"
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
    private Assembled assembleJava(String studentCode, String harnessCode, String nonce) {
        String neutralized = studentCode
                .replaceAll("(static\\s+void\\s+)main(\\s*\\(\\s*String)", "$1__moodit_student_main$2");
        String program = "public class __MooditMain {\n"
                + "    static boolean __moodit_harness() {\n"
                + harnessCode
                + "\n    }\n"
                + "    public static void main(String[] __args) {\n"
                + "        try {\n"
                + "            boolean __moodit_r = __moodit_harness();\n"
                + "            if (__moodit_r) System.err.print(\"" + nonce + "\");\n"
                + "            System.exit(__moodit_r ? 0 : 1);\n"
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

    // ── JSON ─────────────────────────────────────────────────────────────────────

    /**
     * JSON : donnée non exécutable, VALIDÉE par un harnais JavaScript (cf. harness_language_id). Le
     * JSON de l'étudiant est écrit dans un fichier voisin, parsé en {@code data} ; un JSON invalide
     * (parse échoué) vaut échec. Le harnais (corps JS) inspecte {@code data} et renvoie un booléen.
     */
    private Assembled assembleJson(String studentJson, String harnessCode, String nonce) {
        String main = "const __moodit_fs = require('fs');\n"
                + "let data;\n"
                + "try {\n"
                + "  data = JSON.parse(__moodit_fs.readFileSync(__dirname + '/submission.json', 'utf8'));\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error('JSON invalide: ' + (__moodit_e && __moodit_e.message ? __moodit_e.message : String(__moodit_e)));\n"
                + "  process.exit(1);\n"
                + "}\n"
                + "function __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  const __moodit_result = __moodit_harness();\n"
                + "  if (__moodit_result) process.stderr.write(\"" + nonce + "\");\n"
                + "  process.exit(__moodit_result ? 0 : 1);\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error(__moodit_e && __moodit_e.stack ? __moodit_e.stack : String(__moodit_e));\n"
                + "  process.exit(1);\n"
                + "}\n";
        return new Assembled("javascript", List.of(
                new PistonClient.File("main.js", main),
                new PistonClient.File("submission.json", studentJson)));
    }

    /**
     * « Run » d'un JSON (non exécutable) : on VALIDE et on RÉ-INDENTE le JSON — sortie = JSON
     * reformaté si valide, message d'erreur (+ exit 1) si invalide. Donne un retour utile au « play ».
     */
    private Assembled runJson(String studentJson) {
        String main = "const __moodit_fs = require('fs');\n"
                + "try {\n"
                + "  const data = JSON.parse(__moodit_fs.readFileSync(__dirname + '/submission.json', 'utf8'));\n"
                + "  console.log(JSON.stringify(data, null, 2));\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error('JSON invalide: ' + (__moodit_e && __moodit_e.message ? __moodit_e.message : String(__moodit_e)));\n"
                + "  process.exit(1);\n"
                + "}\n";
        return new Assembled("javascript", List.of(
                new PistonClient.File("main.js", main),
                new PistonClient.File("submission.json", studentJson)));
    }

    // ── SQL (SQLite) ─────────────────────────────────────────────────────────────

    /** Marqueur, dans un harnais SQL, indiquant où insérer le code étudiant (mode « modification »). */
    private static final Pattern SQL_STUDENT_MARKER = Pattern.compile("(?im)^[ \\t]*--[ \\t]*@student\\b.*$");
    /**
     * Instruction d'un dump à CONSERVER en phase 2 : {@code CREATE TABLE …} / {@code INSERT INTO …},
     * en capturant le NOM de la table ciblée (groupe 1) pour ne garder que les tables de travail.
     */
    private static final Pattern SQL_DUMP_TARGET = Pattern.compile(
            "(?is)^\\s*(?:CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO)"
                    + "\\s+[\"'`\\[]?(\\w+)");
    /** {@code CREATE TABLE <nom>} — pour lister les tables de travail déclarées par le prof (setup). */
    private static final Pattern SQL_CREATE_TABLE = Pattern.compile(
            "(?is)CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+[\"'`\\[]?(\\w+)");

    /** Vrai si le harnais porte {@code -- @student} → mode modification (exécution ISOLÉE en 2 phases). */
    public static boolean sqlHasStudentMarker(String harnessCode) {
        return harnessCode != null && SQL_STUDENT_MARKER.matcher(harnessCode).find();
    }

    /**
     * Noms (minuscules) des tables de TRAVAIL déclarées dans le SETUP du harnais (partie avant le
     * marqueur). Sert de LISTE BLANCHE au filtrage du dump : la phase 2 ne recharge QUE ces tables.
     * Découple le filtrage de la plomberie du paquet Piston (ex. table {@code argv}) : tout ce qui
     * n'est pas déclaré par le prof — plomberie, {@code sqlite_*}, tables fabriquées par l'étudiant —
     * est ignoré, quel que soit le paquet.
     */
    public static Set<String> sqlWorkingTables(String harnessCode) {
        Set<String> tables = new HashSet<>();
        if (harnessCode == null) {
            return tables;
        }
        Matcher marker = SQL_STUDENT_MARKER.matcher(harnessCode);
        String setup = marker.find() ? harnessCode.substring(0, marker.start()) : harnessCode;
        Matcher m = SQL_CREATE_TABLE.matcher(setup);
        while (m.find()) {
            tables.add(m.group(1).toLowerCase(Locale.ROOT));
        }
        return tables;
    }

    /** Sentinelles encadrant, dans la sortie, la zone du VERDICT (phase unique lecture seule, ou phase 2). */
    public static String sqlVerdictStart(String nonce) { return nonce + "_VERDICT_START"; }
    public static String sqlVerdictEnd(String nonce) { return nonce + "_VERDICT_END"; }
    /** Sentinelles encadrant, dans la sortie de la phase 1, le DUMP de l'état de l'étudiant. */
    public static String sqlDumpStart(String nonce) { return nonce + "_DUMP_START"; }
    public static String sqlDumpEnd(String nonce) { return nonce + "_DUMP_END"; }

    /**
     * SQL — mode LECTURE SEULE (harnais SANS {@code -- @student}) : chaque requête de l'étudiant est
     * exposée comme une VUE NUMÉROTÉE {@code solution1}, {@code solution2}, … ({@code solution} =
     * {@code solution1} pour les questions mono-requête). Le SQL étudiant est ainsi confiné à un corps
     * de {@code SELECT} — il ne peut ni écrire ni faire de DDL — donc l'exécution en un seul processus
     * est sûre. Le verdict est encadré par les sentinelles au nonce (anti-forgerie de sortie).
     *
     * <p>Le mode MODIFICATION (avec marqueur) est traité HORS de cette méthode, en DEUX phases isolées
     * (cf. {@link #assembleSqlPhase1}/{@link #assembleSqlPhase2}, pilotées par ExecutionService).
     */
    private Assembled assembleSql(String studentQuery, String harnessCode, String nonce) {
        List<String> statements = splitSqlStatements(studentQuery);
        StringBuilder program = new StringBuilder();
        for (int i = 0; i < statements.size(); i++) {
            // `\n;` sur sa propre ligne : un commentaire de fin de ligne (--) ne peut pas avaler le
            // point-virgule terminateur (il s'arrête au saut de ligne qui précède le `;`).
            program.append("CREATE VIEW solution").append(i + 1).append(" AS\n")
                    .append(statements.get(i)).append("\n;\n");
        }
        if (!statements.isEmpty()) {
            program.append("CREATE VIEW solution AS SELECT * FROM solution1;\n");
        }
        program.append('\n');
        appendFenced(program, harnessCode, nonce);
        return new Assembled("sqlite3", List.of(new PistonClient.File("main.sql", program.toString())));
    }

    /**
     * Phase 1 (mode modification) — BAC À SABLE JETABLE. Le harnais crée les tables de travail (partie
     * AVANT le marqueur), puis le code étudiant s'exécute TEL QUEL (non filtré : il est isolé, sans
     * données de référence ni verdict à atteindre — il ne peut donc rien casser d'utile). On DUMP
     * enfin l'état final, encadré par les sentinelles au nonce : ExecutionService relit ce dump
     * (entre sentinelles → la sortie de l'étudiant est ignorée, et il ne peut pas forger le nonce).
     */
    public Assembled assembleSqlPhase1(String studentCode, String harnessCode, String nonce) {
        Matcher marker = SQL_STUDENT_MARKER.matcher(harnessCode == null ? "" : harnessCode);
        String setup = marker.find() ? harnessCode.substring(0, marker.start()) : (harnessCode == null ? "" : harnessCode);
        StringBuilder program = new StringBuilder(setup);
        if (!setup.isEmpty() && setup.charAt(setup.length() - 1) != '\n') {
            program.append('\n');
        }
        // `\n;` : termine la dernière instruction étudiant même sans `;` (un code malformé échoue
        // proprement en phase 1 — sans risque, l'environnement est jetable).
        program.append(studentCode == null ? "" : studentCode).append("\n;\n");
        program.append("SELECT '").append(sqlDumpStart(nonce)).append("';\n");
        program.append(".dump\n");
        program.append("SELECT '").append(sqlDumpEnd(nonce)).append("';\n");
        return new Assembled("sqlite3", List.of(new PistonClient.File("main.sql", program.toString())));
    }

    /**
     * Phase 2 (mode modification) — NOTEUR ISOLÉ. On recharge l'état final de l'étudiant réduit aux
     * seules {@code CREATE TABLE}/{@code INSERT} (cf. {@link #filterDumpToData}) : AUCUN SQL étudiant
     * n'est exécuté ici (ni vue, ni déclencheur), seulement des définitions de tables et des INSERT à
     * littéraux échappés. Le prof crée ensuite sa référence (à mettre en {@code TEMP}) + son verdict,
     * encadré par les sentinelles au nonce.
     */
    public Assembled assembleSqlPhase2(String studentData, String harnessCode, String nonce) {
        Matcher marker = SQL_STUDENT_MARKER.matcher(harnessCode == null ? "" : harnessCode);
        String verdict = marker.find() ? harnessCode.substring(marker.end()) : (harnessCode == null ? "" : harnessCode);
        StringBuilder program = new StringBuilder(studentData == null ? "" : studentData);
        if (program.length() > 0 && program.charAt(program.length() - 1) != '\n') {
            program.append('\n');
        }
        appendFenced(program, verdict, nonce);
        return new Assembled("sqlite3", List.of(new PistonClient.File("main.sql", program.toString())));
    }

    /**
     * Réduit un dump SQLite ({@code .dump}) aux seules instructions de DONNÉES ({@code CREATE TABLE},
     * {@code INSERT}) portant sur une table de la LISTE BLANCHE {@code allowedTables} (les tables de
     * travail déclarées par le prof, cf. {@link #sqlWorkingTables}). On jette donc TOUT le reste :
     * {@code CREATE VIEW}/{@code TRIGGER}/{@code INDEX}, {@code PRAGMA}, {@code BEGIN}/{@code COMMIT},
     * la plomberie du paquet Piston ({@code argv}), les tables {@code sqlite_*}, et toute table
     * fabriquée par l'étudiant. La phase 2 ne rejoue ainsi que des tables ATTENDUES + des INSERT à
     * littéraux échappés — aucun objet exécutable, aucun couplage aux internes du paquet.
     */
    public static String filterDumpToData(String dump, Set<String> allowedTables) {
        StringBuilder out = new StringBuilder();
        for (String statement : splitSqlStatements(dump)) {
            Matcher m = SQL_DUMP_TARGET.matcher(statement);
            if (!m.find()) {
                continue; // ni CREATE TABLE ni INSERT (vue, déclencheur, PRAGMA, BEGIN/COMMIT…)
            }
            String table = m.group(1).toLowerCase(Locale.ROOT);
            if (!allowedTables.contains(table)) {
                continue; // hors des tables de travail du prof (plomberie, sqlite_*, table étudiant)
            }
            out.append(statement).append("\n;\n");
        }
        return out.toString();
    }

    /** Ajoute {@code <sentinelle début> <verdict prof> <sentinelle fin>} à la fin du programme. */
    private static void appendFenced(StringBuilder program, String verdict, String nonce) {
        program.append("SELECT '").append(sqlVerdictStart(nonce)).append("';\n");
        program.append(verdict == null ? "" : verdict).append("\n;\n"); // termine le verdict même sans `;`
        program.append("SELECT '").append(sqlVerdictEnd(nonce)).append("';\n");
    }

    /**
     * Découpe un script SQL en instructions de PREMIER NIVEAU (séparées par {@code ;}), en
     * ignorant les {@code ;} situés dans une chaîne ({@code '…'}), un identifiant délimité
     * ({@code "…"}, {@code `…`}, {@code […]}) ou un commentaire ({@code -- …}, {@code /* … *}{@code /}).
     * Le découpage suit la même lexique que SQLite pour le {@code ;} : c'est ce qui garantit qu'aucun
     * fragment étudiant ne « déborde » de son {@code CREATE VIEW}. Les segments vides (blancs ou
     * commentaires seuls) sont ignorés.
     */
    static List<String> splitSqlStatements(String sql) {
        List<String> statements = new ArrayList<>();
        if (sql == null) {
            return statements;
        }
        StringBuilder current = new StringBuilder();
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            char next = i + 1 < n ? sql.charAt(i + 1) : '\0';
            if (c == '-' && next == '-') { // commentaire de ligne
                int end = sql.indexOf('\n', i + 2);
                end = end < 0 ? n : end + 1; // inclut le saut de ligne
                current.append(sql, i, end);
                i = end;
            } else if (c == '/' && next == '*') { // commentaire de bloc
                int end = sql.indexOf("*/", i + 2);
                end = end < 0 ? n : end + 2;
                current.append(sql, i, end);
                i = end;
            } else if (c == '\'' || c == '"' || c == '`') { // chaîne / identifiant (échappement par doublement)
                int close = closeQuote(sql, i, c);
                int end = close < 0 ? n : close; // non fermé : on prend jusqu'au bout
                current.append(sql, i, end);
                i = end;
            } else if (c == '[') { // identifiant crocheté SQLite (pas d'échappement)
                int end = sql.indexOf(']', i + 1);
                end = end < 0 ? n : end + 1;
                current.append(sql, i, end);
                i = end;
            } else if (c == ';') { // fin d'instruction
                addStatement(statements, current);
                current.setLength(0);
                i++;
            } else {
                current.append(c);
                i++;
            }
        }
        addStatement(statements, current);
        return statements;
    }

    /** Position APRÈS le délimiteur fermant d'un littéral ouvert en {@code start} par {@code quote}
     *  (échappement par doublement), ou {@code -1} si le littéral n'est jamais fermé. */
    private static int closeQuote(String sql, int start, char quote) {
        int n = sql.length();
        int i = start + 1;
        while (i < n) {
            char c = sql.charAt(i);
            if (c == quote) {
                if (i + 1 < n && sql.charAt(i + 1) == quote) { // délimiteur doublé = échappé
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        return -1; // littéral non fermé
    }

    /** Ajoute le segment s'il porte du SQL réel (ni blanc ni commentaires seuls). */
    private static void addStatement(List<String> statements, StringBuilder segment) {
        String stmt = segment.toString().strip();
        if (stmt.isEmpty()) {
            return;
        }
        String code = stmt.replaceAll("(?s)/\\*.*?\\*/", " ").replaceAll("--[^\\n]*", " ").strip();
        if (!code.isEmpty()) {
            statements.add(stmt);
        }
    }

    // ── HTML ─────────────────────────────────────────────────────────────────────

    /**
     * HTML : markup non exécutable, validé par un harnais JavaScript (cf. harness_language_id). Le
     * HTML de l'étudiant est parsé en DOM via le bundle embarqué {@code htmlparser.js} et fourni au
     * harnais comme {@code doc} (API façon DOM : {@code querySelector}, {@code textContent},
     * {@code getAttribute}…). Le harnais (corps JS) interroge {@code doc} et renvoie un booléen.
     */
    private Assembled assembleHtml(String studentHtml, String harnessCode, String nonce) {
        String main = "const __moodit_fs = require('fs');\n"
                + "const { parse: __moodit_parse } = require('./htmlparser.js');\n"
                + "let doc;\n"
                + "try {\n"
                + "  doc = __moodit_parse(__moodit_fs.readFileSync(__dirname + '/submission.html', 'utf8'));\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error('HTML illisible : ' + (__moodit_e && __moodit_e.message ? __moodit_e.message : String(__moodit_e)));\n"
                + "  process.exit(1);\n"
                + "}\n"
                + "function __moodit_harness() {\n"
                + harnessCode
                + "\n}\n"
                + "try {\n"
                + "  const __moodit_result = __moodit_harness();\n"
                + "  if (__moodit_result) process.stderr.write(\"" + nonce + "\");\n"
                + "  process.exit(__moodit_result ? 0 : 1);\n"
                + "} catch (__moodit_e) {\n"
                + "  console.error(__moodit_e && __moodit_e.stack ? __moodit_e.stack : String(__moodit_e));\n"
                + "  process.exit(1);\n"
                + "}\n";
        return new Assembled("javascript", List.of(
                new PistonClient.File("main.js", main),
                new PistonClient.File("htmlparser.js", vendor("htmlparser.js")),
                new PistonClient.File("submission.html", studentHtml)));
    }

    // ── JSX / TSX (React) ────────────────────────────────────────────────────────

    /**
     * JSX/TSX : composant React validé par un harnais JavaScript. Le code étudiant est TRANSPILÉ
     * (Babel embarqué, presets react + typescript), le composant {@code Composant} est instancié et
     * RENDU en HTML statique (ReactDOMServer embarqué) → fourni au harnais comme la chaîne
     * {@code html}. Le harnais (corps JS) inspecte {@code html} et renvoie un booléen. Un rendu qui
     * échoue (transpilation, composant manquant, exception au rendu) vaut échec.
     */
    private Assembled assembleJsx(String studentCode, String harnessCode, String nonce) {
        // Le runner (jsx-main.js, fichier fixe embarqué) transpile le composant, monte un DOM
        // (happy-dom) et exécute le harnais dans la même portée. Le harnais reçoit ainsi html,
        // render/mount/click/fireEvent, document/window, React + hooks, et les fonctions étudiant.
        // Le nonce anti-triche est fourni via un fichier voisin, émis sur stderr en cas de succès.
        return new Assembled("javascript", List.of(
                new PistonClient.File("main.js", vendor("jsx-main.js")),
                new PistonClient.File("react-runtime.js", vendor("react-runtime.js")),
                new PistonClient.File("component.tsx", studentCode),
                new PistonClient.File("harness.js", harnessCode),
                new PistonClient.File("moodit-nonce.txt", nonce)));
    }
}
