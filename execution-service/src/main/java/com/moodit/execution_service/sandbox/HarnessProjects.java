package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.TestCaseInput;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Construit l'ARBORESCENCE DE PROJET envoyée au conteneur runner d'un langage compilé (#116) :
 * un dossier {@code cases/<i>/src/} par harnais, contenant le code soumis dans son fichier et le
 * harnais du prof dans un autre, précédé du marqueur {@code __MOODIT_HARNAIS__}.
 *
 * <p>Le harnais est un CORPS qui renvoie un booléen, et c'est la seule forme notée. Le
 * superviseur le compile dans un programme séparé — le NOTEUR, sous un UID séparé — et le code
 * soumis seul dans un autre, le SERVEUR. Le noteur appelle des bouchons typés générés d'après
 * les signatures réellement présentes dans le code soumis, et il est le seul à détenir le nonce
 * du verdict. Un harnais au format framework (JUnit, NUnit, {@code go test}, {@code cargo
 * test}) est refusé en amont par {@code ExecutionService} : il était compilé AVEC le code de
 * l'étudiant, donc forgeable, et il n'arrive jamais jusqu'ici.
 *
 * <p>Deux CANARIS sont ajoutés en fin de liste (indices N et N+1) : des cas dont le harnais est
 * un gabarit {@code __MOODIT_A__ == __MOODIT_B__} que le superviseur instancie à l'exécution
 * avec des valeurs tirées au sort — l'un doit réussir, l'autre échouer. Ils ne détectent plus
 * une falsification (il n'y a plus rien à falsifier) : ils vérifient que la chaîne de notation
 * tranche encore dans les DEUX sens, et qu'un cas ne peut pas réussir par accident.
 *
 * <p>Le protocole miroir vit dans {@code docker/runners/common/supervisor.py} ; garder en phase.
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
        return build(language, studentCode, cases, timeoutMs, null);
    }

    /**
     * {@code budgetMs} : budget GLOBAL du job (le mur du conteneur moins une marge). Le
     * superviseur s'y arrête et renvoie les verdicts obtenus plutôt que de se faire tuer au
     * mur — un conteneur tué perd TOUT le travail (502, tentative supprimée côté core).
     */
    public static Project build(String language, String studentCode, List<TestCaseInput> cases,
            Integer timeoutMs, Long budgetMs) {
        String lang = runnerLanguage(language);
        String code = studentCode == null ? "" : studentCode;
        Map<String, String> files = new LinkedHashMap<>();

        StringBuilder caseList = new StringBuilder();
        int index = 0;
        for (TestCaseInput testCase : cases) {
            addCase(files, lang, index, code, testCase.harnessCode() == null ? "" : testCase.harnessCode());
            caseList.append(index > 0 ? "," : "")
                    .append("{\"index\":").append(index)
                    .append(",\"name\":").append(jsonString(testCase.name()))
                    .append("}");
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
                + "\"budget_ms\":" + (budgetMs == null ? "null" : budgetMs.toString()) + ","
                + "\"cases\":[" + caseList + "]}");
        return new Project(lang, files, cases.size());
    }

    // ── disposition par langage ───────────────────────────────────────────────

    /** Extension du fichier portant le harnais booléen marqué, par langage runner. */
    private static String rpcExtension(String lang) {
        return switch (lang) {
            case "java" -> "java";
            case "csharp" -> "cs";
            case "go" -> "go";
            case "rust" -> "rs";
            case "cpp" -> "cpp";
            default -> "c";
        };
    }

    /**
     * Nom du fichier du code étudiant sur le chemin RPC. Le superviseur le reconnaît par son
     * nom : il le compile SEUL, sans jamais lui adjoindre le harnais.
     */
    private static String rpcStudentFile(String lang, String studentCode) {
        return switch (lang) {
            case "java" -> javaFileName(studentCode, "Solution");
            case "csharp" -> "solution.cs";
            case "go" -> "main.go";
            case "rust" -> "solution.rs";
            case "cpp" -> "solution.cpp";
            default -> "solution.c";
        };
    }

    /**
     * Dépose les fichiers d'un cas : le code soumis, et le harnais du prof MARQUÉ.
     *
     * <p>Le harnais est un corps qui renvoie un booléen, et le superviseur le compile dans un
     * PROCESSUS SÉPARÉ, sous un UID SÉPARÉ, avec le nonce. Il n'entre jamais dans le processus de
     * l'étudiant, qui ne peut donc ni le lire, ni le modifier, ni forger son résultat : les
     * attaques in-process (artefact compilé, flux de sortie, interposition de printf, dup2,
     * lecture de sa propre mémoire) n'ont plus de cible.
     *
     * <p>C'est le SEUL chemin. Le format « vraie classe de test du framework » (JUnit, NUnit,
     * go test, cargo test, moodit_check.h), introduit puis retiré dans #116, compilait le harnais
     * AVEC le code de l'étudiant : le processus qui détenait le secret était celui que l'étudiant
     * contrôle, et cinq canaux de forge y ont été démontrés. Il n'a jamais été déployé, donc
     * aucune question existante n'en dépend ; un harnais qui en porte le marqueur est refusé par
     * {@link DockerEvaluator#frameworkHarnessRejection} avec un diagnostic, plutôt que noté par
     * un chemin dont on sait qu'il est contournable.
     */
    private static void addCase(Map<String, String> files, String lang, int index,
            String studentCode, String harnessCode) {
        String base = "cases/" + index + "/src/";
        files.put(base + rpcStudentFile(lang, studentCode), studentCode);
        files.put(base + "harnais_rpc." + rpcExtension(lang),
                "// Harnais booléen du prof — compilé DANS LE NOTEUR, jamais avec le code de\n"
                + "// l'étudiant. Tout ce qui suit le marqueur est son corps.\n"
                + "__MOODIT_HARNAIS__\n" + harnessCode);
    }

    // ── canaris par langage — un corps booléen dont les deux valeurs (__MOODIT_A__ et
    //    __MOODIT_B__) sont tirées au sort par le superviseur à l'exécution : l'un doit réussir,
    //    l'autre échouer. Ils ne détectent plus une falsification, il n'y a plus rien à
    //    falsifier : ils vérifient que la chaîne tranche encore dans les DEUX sens ──

    private static String canaryHarness(String lang) {
        // Forme BOOLÉENNE, comme tous les harnais : une comparaison de deux valeurs tirées au
        // sort. L'un des deux canaris les reçoit égales (il doit réussir), l'autre différentes
        // (il doit échouer). Leur rôle n'est plus d'attraper un forgeage — il n'y a plus rien à
        // forger — mais de vérifier que la chaîne de notation tranche encore dans les deux sens :
        // si elle rendait tout vert, le canari qui doit échouer le dirait.
        return switch (lang) {
            case "go" -> "return __MOODIT_A__ == __MOODIT_B__\n";
            case "rust" -> "__MOODIT_A__ == __MOODIT_B__\n";
            // Java, C#, C et C++ : même syntaxe.
            default -> "return __MOODIT_A__ == __MOODIT_B__;\n";
        };
    }


    // ── utilitaires ───────────────────────────────────────────────────────────

    /**
     * Déclaration de TYPE : modificateurs (groupe 1) et nom (groupe 2). Identifiant Java complet,
     * Unicode compris — {@code \w} ne reconnaît que l'ASCII, et {@code public class Réponse}
     * devenait {@code R.java}. Toute suite de modificateurs et d'annotations, {@code sealed},
     * {@code non-sealed} et {@code strictfp} compris ; une annotation peut porter des arguments
     * ({@code @SuppressWarnings("unchecked") public class Solution}, littéral déjà blanchi). Tête en {@code [ \t]*} et non
     * {@code \s*} : un {@code \s*} en début de motif multiligne avale les sauts de ligne, et
     * le moteur repartait de chaque ligne jusqu'au bout de la source (temps quadratique).
     * Modificateurs bornes a dix : le moteur Java repete un groupe par RECURSION, et une
     * ligne de milliers de {@code static} faisait deborder la pile (StackOverflowError).
     */
    private static final Pattern JAVA_TYPE_DECL = Pattern.compile(
            "(?m)^[ \\t]*((?:(?:@[\\p{javaJavaIdentifierPart}.]+(?:\\([^()\\n]*\\))?|public|protected|private|static"
            + "|final|abstract|sealed|non-sealed|strictfp)\\s+){0,10})"
            + "(?:class|interface|record|enum|@interface)\\s+"
            + "(\\p{javaJavaIdentifierStart}\\p{javaJavaIdentifierPart}*)");
    private static final Pattern PUBLIC_MOD = Pattern.compile("(?<![\\w-])public\\s");

    /**
     * Source SANS commentaires ni littéraux (remplacés par des espaces, lignes préservées) :
     * un {@code class X} dans un commentaire ou une chaîne leurrait le choix de la classe
     * principale — un étudiant qui garde une ancienne version en commentaire voyait le fichier
     * déposé nommé d'après la classe COMMENTÉE, et sa soumission correcte échouait à la
     * compilation avec un diagnostic qui ne désigne pas la cause. Blocs de texte Java
     * ({@code \"\"\"}) compris.
     */
    static String withoutCommentsOrLiterals(String source) {
        StringBuilder res = new StringBuilder(source.length());
        int i = 0;
        int n = source.length();
        while (i < n) {
            char c = source.charAt(i);
            if (c == '/' && i + 1 < n && source.charAt(i + 1) == '/') {
                while (i < n && source.charAt(i) != '\n') {
                    res.append(' ');
                    i++;
                }
            } else if (c == '/' && i + 1 < n && source.charAt(i + 1) == '*') {
                res.append("  ");
                i += 2;
                while (i < n && !(source.charAt(i) == '*'
                        && i + 1 < n && source.charAt(i + 1) == '/')) {
                    res.append(source.charAt(i) == '\n' ? '\n' : ' ');
                    i++;
                }
                if (i < n) {
                    res.append("  ");
                    i += 2;
                }
            } else if (c == '"' && i + 2 < n
                    && source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"') {
                res.append("   ");
                i += 3;
                while (i + 2 < n && !(source.charAt(i) == '"'
                        && source.charAt(i + 1) == '"' && source.charAt(i + 2) == '"')) {
                    res.append(source.charAt(i) == '\n' ? '\n' : ' ');
                    i++;
                }
                i = i + 2 < n ? i + 3 : n;
                res.append("   ");
            } else if (c == '"' || c == '\'') {
                char quote = c;
                res.append(' ');
                i++;
                while (i < n && source.charAt(i) != quote) {
                    if (source.charAt(i) == '\\' && i + 1 < n) {
                        res.append("  ");
                        i += 2;
                    } else {
                        res.append(source.charAt(i) == '\n' ? '\n' : ' ');
                        i++;
                    }
                }
                if (i < n) {
                    res.append(' ');
                    i++;
                }
            } else {
                res.append(c);
                i++;
            }
        }
        return res.toString();
    }

    /**
     * Nom de fichier imposé par javac : celui du type PUBLIC DE PREMIER NIVEAU, sinon le premier
     * type de premier niveau, sinon {@code fallback}. Seul un type de premier niveau impose son
     * nom : une classe imbriquée publique, rencontrée avant, ne compte pas (profondeur
     * d'accolades lue sur la source sans commentaires ni littéraux). SEUL lecteur du nom de
     * fichier Java : la notation et le bouton « Exécuter » ({@code CodeAssembler}) l'appellent.
     */
    public static String javaFileName(String source, String fallback) {
        String name = javaTypeName(source);
        // Nom trop long pour un nom de fichier : le dépôt dans le conteneur échouait (502, tentative
        // supprimée). Fichier de repli : javac rend une erreur de compilation lisible, la
        // notation la refuse en amont avec un message clair (DockerEvaluator.reservedNameRejection).
        return (name != null && !javaTypeNameTooLong(name) && !javaTypeNameUnsafe(name)
                ? name : fallback) + ".java";
    }

    /**
     * Plafond, en octets UTF-8, d'un nom de type Java qui devient un nom de fichier. Linux borne un
     * nom de fichier à 255 octets ; javac y ajoute {@code .class} et, pour une classe imbriquée,
     * {@code $Interne} : 200 laisse cette marge.
     */
    public static final int MAX_JAVA_TYPE_NAME_BYTES = 200;

    /** Le nom de type dépasse-t-il {@link #MAX_JAVA_TYPE_NAME_BYTES} ? */
    public static boolean javaTypeNameTooLong(String name) {
        return name.getBytes(StandardCharsets.UTF_8).length > MAX_JAVA_TYPE_NAME_BYTES;
    }

    /**
     * Le nom de type contient-il un caractère « ignorable » d'identifiant (U+0000, autres
     * caractères de contrôle, caractères de format invisibles) ? Java les admet dans un
     * identifiant, mais le nom devient un nom de fichier : avec U+0000, l'archive du dépôt était
     * refusée par le démon (502, tentative supprimée) ou le nom tronqué au NUL (fichier sans
     * extension, « Aucun fichier de code soumis »).
     */
    public static boolean javaTypeNameUnsafe(String name) {
        return name.chars().anyMatch(Character::isIdentifierIgnorable);
    }

    /**
     * Nom du type qui impose le nom de fichier (cf. {@link #javaFileName}), ou {@code null} si le
     * source ne déclare aucun type de premier niveau. Non borné en longueur.
     */
    public static String javaTypeName(String source) {
        source = withoutCommentsOrLiterals(source == null ? "" : source);
        Matcher m = JAVA_TYPE_DECL.matcher(source);
        String firstTopLevel = null;
        int depth = 0;
        int scanned = 0;
        while (m.find()) {
            for (; scanned < m.start(); scanned++) {
                char c = source.charAt(scanned);
                if (c == '{') {
                    depth++;
                } else if (c == '}' && depth > 0) {
                    depth--;
                }
            }
            if (depth != 0) {
                continue;
            }
            if (PUBLIC_MOD.matcher(m.group(1)).find()) {
                return m.group(2);
            }
            if (firstTopLevel == null) {
                firstTopLevel = m.group(2);
            }
        }
        return firstTopLevel;
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
