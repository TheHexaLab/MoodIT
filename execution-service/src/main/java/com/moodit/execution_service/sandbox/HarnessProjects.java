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
 * étudiant : un code qui détourne le framework depuis un init/constructeur (exécuté partout)
 * casse leurs résultats et se fait détecter.
 *
 * Chaque cas porte de plus un JETON DE FIN D'EXÉCUTION (gabarit {@code __MOODIT_T__}, substitué
 * par le superviseur) imprimé par le POINT DE SORTIE du framework, après tous les tests : un
 * forgeage déclenché depuis la fonction notée elle-même (qui ne s'exécute pas dans les canaris)
 * produit un rapport sans jeton → verdict échoué ({@code jeton_absent}).
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
                    .append(",\"harness_types\":")
                    .append(jsonArray(harnessTypes(lang, testCase.harnessCode())))
                    .append(",\"student_types\":")
                    .append(jsonArray(safeStudentTypes(lang, code, testCase.harnessCode())))
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

    // ── canaris par langage — gabarits instanciés au runtime : valeurs __MOODIT_A__/__MOODIT_B__
    //    ET NOM __MOODIT_N__ (un nom fixe serait reconnaissable : un code C/C++ qui interpose
    //    printf laisserait passer les canaris à leur nom et ne forgerait que les cas réels) ──

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

    // ── conteneurs de tests déclarés par le HARNAIS ───────────────────────────

    // Types de NIVEAU RACINE uniquement (ancrés en colonne 0) : un type imbriqué ou annoté
    // @Nested n'est pas sélectionnable par son nom simple, et une sélection invalide fait
    // échouer TOUTE la découverte (JUnit) ou n'exécute rien (NUnit).
    private static final Pattern JAVA_TYPE = Pattern.compile(
            "(?m)^(?:public\\s+|final\\s+|abstract\\s+|sealed\\s+|non-sealed\\s+|strictfp\\s+)*"
            + "(?:class|record|enum|interface)\\s+(\\w+)");
    private static final Pattern CSHARP_TYPE = Pattern.compile(
            "(?m)^\\s{0,4}(?:public\\s+|internal\\s+|sealed\\s+|static\\s+|partial\\s+|abstract\\s+)*"
            + "class\\s+(\\w+)");
    private static final Pattern RUST_MOD = Pattern.compile("(?m)^\\s{0,4}(?:pub\\s+)?mod\\s+(\\w+)");
    /** {@code package a.b;} (Java) ou {@code namespace a.b} / {@code namespace a.b;} (C#). */
    private static final Pattern JAVA_PACKAGE = Pattern.compile("(?m)^\\s*package\\s+([\\w.]+)\\s*;");
    private static final Pattern CSHARP_NAMESPACE = Pattern.compile("(?m)^\\s*namespace\\s+([\\w.]+)");

    /**
     * Noms PLEINEMENT QUALIFIÉS des classes (Java, C#) ou modules (Rust) déclarés par le CODE
     * ÉTUDIANT. Le superviseur les EXCLUT de l'exécution : le code étudiant est compilé dans
     * la même unité que le harnais (c'est ce qui donne l'accès aux membres privés), donc ses
     * PROPRES tests unitaires — idiome courant, souvent copié d'un tutoriel — étaient
     * découverts et comptés dans le verdict. Un test d'étudiant simplement faux mettait alors
     * toute la question à 0.
     *
     * <p>EXCLURE plutôt que SÉLECTIONNER est un choix de sûreté : si l'extraction manque une
     * forme, les tests de l'étudiant comptent à nouveau (le défaut d'équité d'origine, visible
     * et corrigeable), là où une sélection incomplète pouvait n'exécuter AUCUN test du prof et
     * accorder la note pleine. Une liste vide revient donc au comportement d'avant ce filtre.
     *
     * <p>Go et C/C++ ne sont pas concernés : un {@code TestXxx} de l'étudiant dans
     * {@code main.go} n'est pas un test de {@code go test}, et {@code MOODIT_TEST} n'est pas
     * défini quand son fichier est compilé.
     */
    static List<String> studentTypes(String runnerLanguage, String studentCode) {
        String code = studentCode == null ? "" : studentCode;
        Pattern pattern;
        String prefix = "";
        switch (runnerLanguage) {
            case "java" -> {
                pattern = JAVA_TYPE;
                Matcher pkg = JAVA_PACKAGE.matcher(code);
                prefix = pkg.find() ? pkg.group(1) + "." : "";
            }
            case "csharp" -> {
                pattern = CSHARP_TYPE;
                Matcher ns = CSHARP_NAMESPACE.matcher(code);
                prefix = ns.find() ? ns.group(1) + "." : "";
            }
            case "rust" -> pattern = RUST_MOD;
            default -> pattern = null;
        }
        if (pattern == null) {
            return List.of();
        }
        List<String> names = new java.util.ArrayList<>();
        Matcher matcher = pattern.matcher(code);
        while (matcher.find()) {
            names.add(prefix + matcher.group(1));
        }
        return List.copyOf(names);
    }

    /** Un {@code #[test]} Rust déclaré au niveau RACINE du harnais (hors de tout module). */
    private static final Pattern RUST_ROOT_TEST = Pattern.compile("(?m)^#\\[test\\]");

    /**
     * Conteneurs de tests du HARNAIS, tels que le superviseur les verra dans les rapports.
     * Ils portent l'invariant « au moins un test du harnais a tourné ».
     *
     * <p>En Rust, un test est identifié par son MODULE. Si le harnais place des
     * {@code #[test]} au niveau racine, ils seront rapportés sous le nom de leur fonction, qui
     * n'est pas un module : l'invariant ne les reconnaîtrait pas et noterait 0 un code
     * pourtant correct. Dans ce cas on renvoie une liste VIDE — aucune exclusion n'est alors
     * appliquée, tous les tests tournent, et l'invariant est satisfait par construction. On
     * perd l'équité sur cette forme de harnais, jamais la justesse de la note.
     */
    static List<String> harnessTypes(String runnerLanguage, String harnessCode) {
        if ("rust".equals(runnerLanguage) && harnessCode != null
                && RUST_ROOT_TEST.matcher(harnessCode).find()) {
            return List.of();
        }
        return studentTypes(runnerLanguage, harnessCode);
    }

    /**
     * Types de l'étudiant qu'on peut exclure SANS RISQUE d'écarter aussi un conteneur du
     * harnais. L'extraction est purement textuelle sur un texte que l'étudiant contrôle : un
     * commentaire {@code /* class Harnais *}{@code /} suffirait sinon à faire exclure les
     * tests du prof. Et en Rust, {@code --skip} filtre par SOUS-CHAÎNE : un module nommé
     * {@code s} écarterait {@code harnais::…}.
     *
     * <p>Un nom écarté ici revient simplement au défaut d'équité (les tests de l'étudiant
     * comptent), jamais à une note offerte — qui reste par ailleurs impossible grâce à
     * l'invariant « au moins un test du harnais a tourné » côté superviseur.
     */
    static List<String> safeStudentTypes(String runnerLanguage, String studentCode,
            String harnessCode) {
        List<String> harness = harnessTypes(runnerLanguage, harnessCode);
        // Harnais NON identifié : aucune exclusion. Sans ses conteneurs, le superviseur ne
        // peut pas vérifier qu'un de ses tests a tourné ; on exécute donc tout, ce qui le
        // garantit par construction (au prix de l'équité, jamais de l'intégrité de la note).
        if (harness.isEmpty()) {
            return List.of();
        }
        List<String> safe = new java.util.ArrayList<>();
        for (String candidate : studentTypes(runnerLanguage, studentCode)) {
            // Le filtrage compare des noms EXACTS des deux côtés (regex ancrée en Java,
            // égalité en C#, premier segment en Rust) : seule une coïncidence stricte avec un
            // conteneur du harnais est dangereuse.
            if (harness.stream().noneMatch(candidate::equals)) {
                safe.add(candidate);
            }
        }
        return List.copyOf(safe);
    }

    private static String jsonArray(List<String> values) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            sb.append(i > 0 ? "," : "").append(jsonString(values.get(i)));
        }
        return sb.append(']').toString();
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
