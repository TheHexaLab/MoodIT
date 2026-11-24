package com.moodit.execution_service.assembly;

import com.moodit.execution_service.sandbox.RunnerExec;
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
 * verdict (0 = réussi, non-zéro = échec) — le mode exec du runner ne renvoie que stdout/stderr/exit, pas de valeur
 * de retour. Le contrat du harnais (le corps RENVOIE un booléen ; une exception/panic vaut échec)
 * est enveloppé ici, PAR LANGAGE, en miroir des {@code harness_template} semés en base.
 *
 * <p>Langages assemblés ici (mode exec du runner, ex-Piston) : Python, JavaScript, TypeScript, Bash, PHP, JSON, SQL, HTML,
 * JSX, TSX. Les langages « données/vues » sont validés par un harnais JS via des libs EMBARQUÉES
 * injectées dans la soumission : HTML → parseur DOM ({@code htmlparser.js}, {@code doc}) ;
 * JSX/TSX → Babel + React + ReactDOMServer ({@code react-runtime.js}, rendu en {@code html}).
 * SQL → vues numérotées {@code solution1}, {@code solution2}… (une par requête) + verdict sur la
 * sortie (cf. ExecutionService).
 *
 * <p>Les langages COMPILÉS (Go, Rust, C, C++, C#, Java) ne passent PLUS par ici pour l'évaluation
 * (#116) : ils sont notés par le RUNNER DOCKER ({@code sandbox/DockerEvaluator} + superviseur),
 * où le harnais booléen est compilé dans un programme séparé sous un UID séparé. Leur mode
 * « run » (bouton play) passe par le mode exec des mêmes images.
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

    /** Programme prêt pour le mode exec du runner : runtime + fichiers (le premier est l'entrée). */
    public record Assembled(String runtime, List<RunnerExec.File> files) {}

    public Assembled assemble(String language, String studentCode, String harnessCode, String nonce) {
        return assemble(language, studentCode, harnessCode, nonce, null);
    }

    /**
     * Comme {@link #assemble(String, String, String, String)}, avec le code de départ de
     * l'enseignant ({@code null} s'il n'y en a pas) : un nom qu'il déclare n'est pas refusé comme
     * « Nom réservé » (cf. {@link #notImposed}).
     */
    public Assembled assemble(String language, String studentCode, String harnessCode, String nonce,
            String startCode) {
        String code = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;
        String start = startCode == null ? "" : startCode;
        return switch (canon(language)) {
            case "python" -> assemblePython(code, harness, nonce, start);
            case "javascript" -> assembleJsRpc(code, harness, nonce, false, start);
            case "typescript" -> assembleJsRpc(code, harness, nonce, true, start);
            case "php" -> assemblePhpRpc(code, harness, nonce);
            case "bash" -> assembleBashRpc(code, harness, nonce, start);
            // Langages COMPILÉS (#116) : notés par le RUNNER DOCKER (sandbox/DockerEvaluator),
            // jamais assemblés ici — ExecutionService route avant d'arriver au switch.
            case "go", "rust", "c", "c++", "csharp", "java" -> throw new UnsupportedLanguageException(
                    "Langage compilé « " + language + " » : évaluation via le mode evaluate du runner");
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

    /**
     * Vrai si le langage est COMPILÉ (C, C++, Go, Rust, C#, Java). Ces langages ne passent PAS
     * par l'assemblage : leur notation vit dans le runner dédié ({@code sandbox/DockerEvaluator}
     * + {@code HarnessProjects}, harnais booléen noté par deux programmes sous deux UID) —
     * ce prédicat sert au ROUTAGE dans {@code ExecutionService}.
     */
    public static boolean isCompiled(String language) {
        return switch (canon(language)) {
            case "c", "c++", "go", "rust", "csharp", "java" -> true;
            default -> false;
        };
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

    private static Assembled run(String runtime, String fileName, String code) {
        return new Assembled(runtime, List.of(new RunnerExec.File(fileName, code)));
    }

    /** Indente chaque ligne non vide par {@code prefix} (préserve l'indentation relative). */
    private static String indent(String code, String prefix) {
        return code.lines()
                .map(line -> line.isBlank() ? "" : prefix + line)
                .collect(Collectors.joining("\n"));
    }

    // ── Python ─────────────────────────────────────────────────────────────────

    /** Noms de fonctions et classes de PREMIER NIVEAU définis par l'étudiant (pour créer les proxys). */
    // Identifiants Unicode (`def carré`) : en ASCII seul, le mandataire s'appelait `carr`, et
    // la réponse juste notait 0 (revue #246). `(?U)` rend `\\w` Unicode.
    // `carre = lambda x: …` est aussi une fonction de premier niveau (revue #246 : sans
    // mandataire, le harnais ne la trouvait pas). Quantificateurs possessifs : aucun retour
    // arrière sur un code soumis choisi pour en provoquer.
    private static final Pattern PY_DEF = Pattern.compile(
            "(?mU)^(?:(?:async\\s++)?def\\s++([\\p{L}_]\\w*+)|([\\p{L}_]\\w*+)\\s*+=\\s*+lambda\\b)");
    private static final Pattern PY_CLASS = Pattern.compile("(?mU)^class\\s+([\\p{L}_]\\w*)");

    /** Mandataire Python d'une fonction soumise : l'appel part par RPC. */
    private static String pyFunctionProxy(String f) {
        return "def " + f + "(*a):\n"
                + "    return __moodit_rpc({\"op\": \"call\", \"name\": \"" + f
                + "\", \"args\": list(a)})[\"value\"]\n";
    }

    /**
     * Mandataire Python d'une classe soumise : l'objet vit chez l'étudiant, le noteur n'en tient
     * qu'une poignée. Dans un corps de classe, un identifiant `__x` subit le name mangling
     * (→ `_Classe__x`) : le RPC est donc référencé par globals()["..."] (clé non manglée).
     */
    private static String pyClassProxy(String c) {
        return "class " + c + ":\n"
                + "    def __init__(self, *a):\n"
                + "        object.__setattr__(self, \"__moodit_h\", globals()[\"__moodit_rpc\"]({\"op\": \"new\", \"class\": \""
                + c + "\", \"args\": list(a)})[\"handle\"])\n"
                + "    def __getattr__(self, name):\n"
                + "        h = object.__getattribute__(self, \"__moodit_h\")\n"
                + "        def _call(*a):\n"
                + "            return globals()[\"__moodit_rpc\"]({\"op\": \"method\", \"handle\": h, \"name\": name, \"args\": list(a)})[\"value\"]\n"
                + "        return _call\n";
    }

    /**
     * Nom factice des mandataires d'exemple comptés dans l'infrastructure : préfixé __moodit,
     * il ne coïncide avec aucun nom soumis (ils sont écartés), seuls comptent les outils que le
     * texte FIXE du mandataire emploie (`list`, `object`, `globals`, `Proxy`…).
     */
    private static final String SAMPLE_PROXY_NAME = "__moodit_exemple";

    /**
     * Python : exécution ISOLÉE en deux processus (cf. proxy/RPC). Le harnais du prof tourne
     * INCHANGÉ dans un NOTEUR (grader.py) qui ne contient AUCUN code étudiant ; les symboles de
     * l'étudiant (fonctions/classes) y sont des PROXYS qui délèguent, par RPC (JSON sur stdin/stdout),
     * à un SERVEUR (student_server.py) où vit le vrai code étudiant. Conséquences :
     * <ul>
     *   <li>le nonce est émis par le NOTEUR, où aucun code étudiant ne tourne — le résiduel de
     *       lecture de source disparaît (le serveur étudiant n'a pas de nonce). RÉSERVE commune à
     *       tout le mode « exec » (Python, JS/TS, PHP, Bash, JSX/TSX) : noteur et code soumis y
     *       partagent l'UID, la garantie dépend donc de {@code kernel.yama.ptrace_scope ≥ 1} sur
     *       l'hôte (cf. ISOLATION.md, « Résiduel connu », et {@link #assembleBashRpc}) ; seuls les
     *       six langages compilés portent la propriété « verdict non falsifiable » ;</li>
     *   <li>les ATTENDUS du harnais restent dans le noteur, hors de portée de l'étudiant (mémoire
     *       distincte, {@code grader.py} auto-supprimé) → passer = produire les bonnes sorties ;</li>
     *   <li>ExecutionService est inchangé : il vérifie toujours le nonce.</li>
     * </ul>
     */
    private Assembled assemblePython(String studentCode, String harnessCode, String nonce,
            String startCode) {
        StringBuilder proxies = new StringBuilder();
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        java.util.Set<String> mentioned = harnessNames(harnessCode);
        for (String f : matchAll(PY_DEF, studentCode)) {
            if (f.startsWith("__moodit")) continue;   // pas de collision avec l'infra du noteur
            if (!mentioned.contains(f)) continue;   // mandataire inutile, cf. harnessMentions
            names.add(f);
            proxies.append(pyFunctionProxy(f));
        }
        for (String c : matchAll(PY_CLASS, studentCode)) {
            if (c.startsWith("__moodit")) continue;
            if (!mentioned.contains(c)) continue;
            names.add(c);
            proxies.append(pyClassProxy(c));
        }
        // Tous les identifiants internes sont préfixés __moodit_ → aucune collision avec un symbole étudiant.
        String grader = "import os as __moodit_os\n"
                + "try:\n    __moodit_os.remove('grader.py')\nexcept Exception:\n    pass\n"
                + "import sys as __moodit_sys, subprocess as __moodit_subprocess, json as __moodit_json\n"
                + "import secrets as __moodit_secrets, builtins as __moodit_builtins\n"
                // `bool` du VERDICT pris à la source : un mandataire `bool` le masquait au niveau
                // du module, et le verdict appelait alors le code soumis.
                + "__moodit_bool = __moodit_builtins.bool\n"
                // REFUS d'un nom qui masque une fonction INTÉGRÉE : le mandataire généré pour
                // `def len` ou `class abs` remplaçait, dans le harnais, la fonction intégrée du
                // même nom par le code soumis (`abs(f(x) - 3) < 1e-9` passait avec un `abs`
                // qui renvoie 0). Même règle que les noms réservés des langages compilés.
                + "__moodit_shadow = [__n for __n in " + SHADOW_SLOT
                + " if hasattr(__moodit_builtins, __n)]\n"
                + "if __moodit_shadow:\n"
                + "    __moodit_sys.stderr.write(" + pythonStringLiteral(SHADOW_PREFIX)
                + " + __moodit_shadow[0] + " + pythonStringLiteral(
                        " » est réservé : il masque une fonction intégrée de Python, que le "
                                + "harnais peut appeler. Renommer cette fonction ou cette classe, "
                                + "puis resoumettre.\n") + ")\n"
                + "    __moodit_sys.exit(1)\n"
                + "__moodit_p = __moodit_subprocess.Popen([__moodit_sys.executable, 'student_server.py'],"
                + " stdin=__moodit_subprocess.PIPE, stdout=__moodit_subprocess.PIPE, text=True)\n"
                + "def __moodit_rpc(payload):\n"
                // IDENTIFIANT IMPRÉVISIBLE par appel, exigé dans la réponse. Sans lui, le code noté
                // — dont le stdout EST le canal de réponse — n'avait qu'à imprimer une réponse
                // conforme AVANT d'être appelé : elle était consommée comme réponse au premier
                // appel, et une réponse FAUSSE passait au vert sans jamais toucher au nonce.
                + "    payload['id'] = __moodit_secrets.token_hex(8)\n"
                + "    print(__moodit_json.dumps(payload), file=__moodit_p.stdin, flush=True)\n"
                + "    while True:\n"
                + "        line = __moodit_p.stdout.readline()\n"
                + "        if not line: raise RuntimeError('processus etudiant termine')\n"
                + "        try: r = __moodit_json.loads(line)\n"
                + "        except Exception: continue\n"
                // Le code étudiant partage stdout avec les réponses RPC : un print de premier niveau
                // dont la sortie est du JSON valide (« 5 », « [1, 2] ») n'est pas une réponse, et
                // une réponse qui ne porte pas l'identifiant DE CET APPEL n'en est pas une non plus.
                + "        if not isinstance(r, dict) or 'ok' not in r: continue\n"
                + "        if r.get('id') != payload['id']: continue\n"
                + "        if not r.get('ok'): raise RuntimeError(str(r.get('error')))\n"
                + "        return r\n"
                + proxies
                + "def __moodit_harness():\n"
                + indent(harnessCode, "    ")
                + "\ntry:\n    __moodit_r = __moodit_bool(__moodit_harness())\nexcept BaseException:\n    __moodit_r = False\n"
                + "if __moodit_r:\n    __moodit_sys.stderr.write(\"" + nonce + "\")\n"
                + "try:\n    __moodit_p.stdin.close()\nexcept Exception:\n    pass\n"
                + "__moodit_sys.exit(0 if __moodit_r else 1)\n";
        // Le texte FIXE des mandataires (list, object, globals) compte aussi : un `def list`
        // imposé ferait s'appeler lui-même le mandataire de toute fonction.
        String pyInfra = graderInfrastructure(grader, proxies.toString(), indent(harnessCode, "    "))
                + pyFunctionProxy(SAMPLE_PROXY_NAME) + pyClassProxy(SAMPLE_PROXY_NAME);
        grader = fillShadowSlot(grader, pythonStringList(notImposed(names, startCode, pyInfra,
                PY_DEF, PY_CLASS)));
        // Boucle RPC dans une FONCTION → ses variables ne polluent pas les globals (symboles étudiant).
        // Les fonctions INTÉGRÉES dont la boucle a besoin sont prises dans `builtins`, AVANT le
        // code soumis : celui-ci s'exécute dans le même module, et une fonction d'aide `print`,
        // `len`, `str`, `getattr` ou `globals` (ou une classe `Exception`) y remplaçait
        // l'intégrée. Le serveur répondait alors avec la fonction de l'étudiant — une réponse
        // juste notée fausse, ou une trace Python en guise de diagnostic.
        String server = "import sys as __moodit_sys, json as __moodit_json, builtins as __moodit_b\n"
                + studentCode
                + "\ndef __moodit_serve():\n"
                + "    objs = {}\n"
                + "    for line in __moodit_sys.stdin:\n"
                + "        try: m = __moodit_json.loads(line)\n"
                + "        except __moodit_b.Exception: continue\n"
                + "        try:\n"
                + "            op = m.get('op')\n"
                + "            if op == 'call':\n"
                + "                r = {'ok': True, 'value': __moodit_b.globals()[m['name']](*m['args'])}\n"
                + "            elif op == 'new':\n"
                + "                h = __moodit_b.len(objs); objs[h] = __moodit_b.globals()[m['class']](*m['args']); r = {'ok': True, 'handle': h}\n"
                + "            elif op == 'method':\n"
                + "                r = {'ok': True, 'value': __moodit_b.getattr(objs[m['handle']], m['name'])(*m['args'])}\n"
                + "            else:\n"
                + "                r = {'ok': False, 'error': 'op inconnu'}\n"
                + "        except __moodit_b.Exception as e:\n"
                + "            r = {'ok': False, 'error': __moodit_b.str(e)}\n"
                // L'identifiant reçu est RENVOYÉ : c'est ce qui rattache la réponse à SON appel.
                + "        r['id'] = m.get('id')\n"
                // Retour à la ligne AVANT la réponse (comme en PHP) : un `print(…, end="")` du
                // code soumis partage ce tampon et se collait au début de la ligne de réponse,
                // qui n'était alors plus reconnue — le couple s'attendait jusqu'au temps limite,
                // et une réponse JUSTE était notée « Interrompu ».
                + "        __moodit_b.print('\\n' + __moodit_json.dumps(r), flush=True)\n"
                + "__moodit_serve()\n";
        return new Assembled("python", List.of(
                new RunnerExec.File("grader.py", grader),
                new RunnerExec.File("student_server.py", server)));
    }

    /** Début du diagnostic d'un nom soumis qui masque une fonction intégrée (suivi du nom). */
    static final String SHADOW_PREFIX = "Nom réservé : « ";

    /**
     * Le harnais emploie-t-il ce nom ? Seuls les symboles soumis que le harnais NOMME reçoivent
     * un mandataire dans le noteur : un mandataire qu'il n'appelle pas ne sert à rien, et celui
     * d'une fonction d'aide {@code max}, {@code sum} ou {@code test} y masquait l'intégrée du
     * même nom — d'où un refus (« Nom réservé ») et un 0 sur une réponse juste, même quand le
     * harnais ne s'en servait pas. Le refus ne vise donc plus que le nom que le harnais emploie.
     *
     * <p>Recherche du MOT dans le texte brut du harnais, chaînes et commentaires compris : dans
     * le doute, le nom compte comme employé et garde son mandataire (comportement d'avant).
     */
    static boolean harnessMentions(String harnessCode, String name) {
        return harnessNames(harnessCode).contains(name);
    }

    /** Suite maximale de caractères d'identifiant (Unicode, `$` compris). */
    private static final Pattern NAME_RUN = Pattern.compile("(?U)[\\w$]+");

    /**
     * Noms que le harnais EMPLOIE, extraits en UN passage (cf. {@link #harnessMentions}) : une
     * regex par nom soumis relisait tout le harnais à chaque fois — des milliers de noms soumis
     * contre un harnais de 50 Ko, plusieurs secondes de CPU par cas, hors de toute place du
     * sandbox. Un nom précédé d'un point n'en est pas un : `p.max()` appelle une MÉTHODE (lui
     * donner un mandataire la faisait refuser comme « Nom réservé », 0 sur une réponse juste) —
     * sauf après `...` : `Math.max(...valeurs())` appelle bien la fonction `valeurs`, et sans
     * mandataire l'appel échouait sans bruit (0 sur une réponse juste, revue #246).
     */
    static java.util.Set<String> harnessNames(String harnessCode) {
        String code = harnessCode == null ? "" : harnessCode;
        java.util.Set<String> found = new java.util.HashSet<>();
        Matcher m = NAME_RUN.matcher(code);
        while (m.find()) {
            int at = m.start();
            boolean member = at > 0 && code.charAt(at - 1) == '.'
                    && !(at >= 3 && code.startsWith("...", at - 3));
            if (!member) {
                found.add(m.group());
            }
        }
        return found;
    }

    /**
     * Noms soumis au refus « Nom réservé » : ceux du code soumis que le code de départ de
     * l'ENSEIGNANT ne déclare pas. Une fonction que l'énoncé impose sous le nom d'une intégrée
     * ({@code def sum}, {@code function parseInt}, {@code test()}) est la fonction notée : le
     * harnais qui l'appelle veut le code soumis, et la refuser notait 0 une réponse juste (#22).
     * Le refus ne garde son sens que pour un nom AJOUTÉ par l'étudiant, qui détournerait une
     * intégrée dont le harnais se sert ({@code abs(f(x) - 3) < 1e-9} avec un {@code abs} qui
     * renvoie 0). Le code de départ vient de la question, jamais de l'étudiant.
     */
    static java.util.Set<String> notImposed(java.util.Collection<String> names, String startCode,
            String graderInfrastructure, Pattern... declarations) {
        java.util.Set<String> imposed = new java.util.HashSet<>();
        for (Pattern declaration : declarations) {
            Matcher m = declaration.matcher(startCode);
            while (m.find()) {
                for (int g = 1; g <= m.groupCount(); g++) {
                    // Groupes alternatifs (JS_CALLABLE : `function f` OU `const f =`) : un seul
                    // est rempli, l'autre vaut null.
                    if (m.group(g) != null) {
                        imposed.add(m.group(g));
                    }
                }
            }
        }
        // Un nom que le noteur EMPLOIE lui-même (print, isinstance en Python ; Proxy, JSON,
        // Buffer en JavaScript ; head, od, tr, printf en Bash) reste refusé, imposé ou non : son
        // mandataire remplacerait l'outil dans la boucle RPC, qui s'appellerait elle-même à
        // l'infini ou lèverait — 0 pour tous, délai dépassé au lieu d'un refus expliqué. Le
        // rejeu d'avant déploiement (deploy/check-compiled-harnesses.py) signale la question.
        imposed.removeAll(freeIdentifiers(graderInfrastructure));
        java.util.Set<String> checked = new java.util.LinkedHashSet<>(names);
        checked.removeAll(imposed);
        return checked;
    }

    /** Chaîne entre guillemets doubles ou simples, échappements compris (une seule ligne). */
    private static final Pattern QUOTED = Pattern.compile(
            "\"(?:[^\"\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\n]|\\\\.)*'");
    /** Identifiant LIBRE : ni nom de propriété (précédé d'un point), ni morceau d'identifiant. */
    private static final Pattern FREE_IDENTIFIER = Pattern.compile("(?<![\\w$.])[A-Za-z_$][\\w$]*");

    /**
     * Identifiants que le code du noteur NOMME comme des noms libres, donc qu'une déclaration de
     * même nom au niveau du module remplacerait. Chaînes (clés `payload['id']`, messages,
     * `require('crypto')`) et noms de propriété (`.toString(…)`, `sys.exit`) n'en sont pas :
     * les compter refusait un nom imposé que le noteur n'emploie pas (« Écris `id(x)` ») et
     * notait 0 toute réponse juste.
     */
    static java.util.Set<String> freeIdentifiers(String code) {
        String bare = QUOTED.matcher(code == null ? "" : code).replaceAll(" ");
        java.util.Set<String> found = new java.util.HashSet<>();
        Matcher m = FREE_IDENTIFIER.matcher(bare);
        while (m.find()) {
            found.add(m.group());
        }
        return found;
    }

    /** Emplacement de la liste (ou de la vérification) des noms refusés dans un gabarit de noteur. */
    private static final String SHADOW_SLOT = "__moodit_shadow_slot__";

    /**
     * Code PROPRE au noteur : le gabarit sans les mandataires (noms soumis) ni le harnais (texte
     * de l'enseignant), ni l'emplacement des noms refusés. C'est ce texte qui dit quels outils du
     * langage la boucle RPC emploie.
     */
    static String graderInfrastructure(String template, String proxies, String harness) {
        String infra = template.replace(SHADOW_SLOT, "");
        if (!proxies.isEmpty()) {
            infra = infra.replace(proxies, "\n");
        }
        if (!harness.isEmpty()) {
            infra = infra.replace(harness, "\n");
        }
        return infra;
    }

    /** Remplace l'emplacement (unique, en tête du gabarit) par son contenu. */
    private static String fillShadowSlot(String template, String content) {
        int at = template.indexOf(SHADOW_SLOT);
        return template.substring(0, at) + content + template.substring(at + SHADOW_SLOT.length());
    }

    /** Liste de chaînes littérale (Python ou JavaScript) ; les noms viennent de motifs {@code \w}. */
    private static String pythonStringList(java.util.Collection<String> names) {
        return names.stream().map(CodeAssembler::pythonStringLiteral)
                .collect(Collectors.joining(", ", "[", "]"));
    }

    /**
     * Littéral chaîne entre guillemets doubles, valable en Python comme en JavaScript : barre
     * oblique inverse, guillemet, sauts de ligne et tout caractère non ASCII sont échappés.
     */
    static String pythonStringLiteral(String text) {
        StringBuilder out = new StringBuilder("\"");
        for (char ch : text.toCharArray()) {
            switch (ch) {
                case '\\' -> out.append("\\\\");
                case '"' -> out.append("\\\"");
                case '\n' -> out.append("\\n");
                default -> {
                    if (ch < 0x20 || ch > 0x7E) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
                }
            }
        }
        return out.append('"').toString();
    }

    /** Toutes les captures du groupe 1 d'un motif dans un texte (ordre d'apparition, doublons possibles). */
    /** Pour chaque occurrence, le PREMIER groupe capturé (motifs à plusieurs formes). */
    private static List<String> matchAll(Pattern pattern, String text) {
        List<String> out = new ArrayList<>();
        Matcher m = pattern.matcher(text == null ? "" : text);
        while (m.find()) {
            for (int g = 1; g <= m.groupCount(); g++) {
                if (m.group(g) != null) {
                    out.add(m.group(g));
                    break;
                }
            }
        }
        return out;
    }

    // ── JavaScript / TypeScript ─────────────────────────────────────────────────

    /** Symboles JS de premier niveau : fonctions/const/let/var (appelables) et classes. */
    // `export` (et `export default`) facultatif : c'est l'écriture ordinaire d'un module
    // TypeScript, et sans lui une `export function f` ne recevait pas de mandataire — le harnais
    // ne trouvait pas `f`, et une réponse juste était notée fausse.
    private static final String JS_EXPORT = "(?:export\\s++(?:default\\s++)?)?";
    // Quantificateurs POSSESSIFS : `function\s*\*?\s*` se renvoyait une longue suite de blancs
    // entre ses deux `\s*`, en temps quadratique — 45 s de CPU par harnais pour 100 000 blancs
    // soumis, hors de toute place du sandbox (revue #246).
    private static final Pattern JS_CALLABLE = Pattern.compile(
            "(?mU)^" + JS_EXPORT + "(?:async\\s++)?function\\s*+(?:\\*\\s*+)?([\\p{L}_$][\\w$]*+)"
                    + "|(?mU)^" + JS_EXPORT + "(?:const|let|var)\\s++([\\p{L}_$][\\w$]*+)\\s*+=");
    private static final Pattern JS_CLASS = Pattern.compile(
            "(?mU)^" + JS_EXPORT + "(?:abstract\\s++)?class\\s++([\\p{L}_$][\\w$]*+)");

    /** Mandataire JavaScript d'une fonction soumise. */
    private static String jsFunctionProxy(String f) {
        return "function " + f + "(...a){ return __moodit_rpc({op:'call',name:'" + f + "',args:a}).value; }\n";
    }

    /** Mandataire JavaScript d'une classe soumise (objet tenu par poignée). */
    private static String jsClassProxy(String c) {
        return "const " + c + " = new Proxy(function(){}, { construct(_t,args){"
                + " const h=__moodit_rpc({op:'new',cls:'" + c + "',args}).handle;"
                + " return new Proxy({}, { get(_o,p){ return (...a)=>__moodit_rpc({op:'method',handle:h,name:p,args:a}).value; } }); } });\n";
    }

    /**
     * JavaScript : exécution ISOLÉE en deux processus (cf. {@link #assemblePython} pour le principe).
     * Le NOTEUR (grader.js) exécute le harnais INCHANGÉ avec des proxys ; le SERVEUR (student_server.js)
     * héberge le code étudiant. RPC SYNCHRONE (le harnais est synchrone) via {@code fs.readSync} sur le
     * fd du sous-processus. Le nonce est émis par le noteur, où aucun code étudiant ne tourne
     * (même réserve que Python : UID partagé, cf. {@link #assemblePython}).
     */
    private Assembled assembleJsRpc(String studentCode, String harnessCode, String nonce, boolean typescript,
            String startCode) {
        // TS : fichiers .ts, transpilés côte à côte par le runner (tsc --noCheck) en .js
        // (student_server.js, grader.js). `// @ts-nocheck` neutralise aussi les erreurs de type
        // à la transpilation (on veut exécuter, pas typer).
        String header = typescript ? "// @ts-nocheck\n" : "";
        String runtimeName = typescript ? "typescript" : "javascript";
        String graderName = typescript ? "grader.ts" : "grader.js";
        String serverName = typescript ? "student_server.ts" : "student_server.js";
        StringBuilder proxies = new StringBuilder();
        java.util.LinkedHashSet<String> callables = new java.util.LinkedHashSet<>();
        Matcher mc = JS_CALLABLE.matcher(studentCode);
        while (mc.find()) {
            callables.add(mc.group(1) != null ? mc.group(1) : mc.group(2));
        }
        java.util.LinkedHashSet<String> classes = new java.util.LinkedHashSet<>(matchAll(JS_CLASS, studentCode));
        callables.removeAll(classes);
        callables.removeIf(n -> n.startsWith("__moodit"));   // pas de collision avec l'infra du noteur
        classes.removeIf(n -> n.startsWith("__moodit"));
        // Mandataires des seuls noms que le harnais emploie (cf. harnessMentions).
        java.util.Set<String> mentioned = harnessNames(harnessCode);
        callables.removeIf(n -> !mentioned.contains(n));
        classes.removeIf(n -> !mentioned.contains(n));
        for (String f : callables) {
            proxies.append(jsFunctionProxy(f));
        }
        for (String c : classes) {
            proxies.append(jsClassProxy(c));
        }
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>(callables);
        names.addAll(classes);
        // Tous les identifiants internes sont préfixés __moodit_ → aucune collision avec un symbole étudiant.
        String grader = header
                // REFUS d'un nom qui masque un GLOBAL (Number, parseInt, isNaN, Boolean…) ou une
                // variable du module (require…) : le mandataire, déclaré au niveau du module et
                // hissé, remplaçait dans le harnais la fonction du même nom par le code soumis
                // (`Number(f()) === 3` passait avec un `Number` qui renvoie 3). EN TÊTE, avant
                // tout usage d'un nom que le mandataire hissé pourrait déjà masquer.
                + "const __moodit_shadow=" + SHADOW_SLOT + ".filter(function(n){"
                + " return (n in [].constructor.constructor('return this')()) || [\"require\",\"module\",\"exports\",\"__filename\","
                + "\"__dirname\",\"globalThis\"].indexOf(n)>=0; });\n"
                + "if(__moodit_shadow.length){ const __moodit_msg=" + pythonStringLiteral(SHADOW_PREFIX)
                + "+__moodit_shadow[0]+" + pythonStringLiteral(
                        " » est réservé : il masque une fonction ou un objet global de JavaScript, "
                                + "que le harnais peut appeler. Renommer cette fonction ou cette "
                                + "classe, puis resoumettre.\n")
                + "; try{ process.stderr.write(__moodit_msg); process.exit(1); }catch(e){}"
                + " throw __moodit_msg; }\n"
                // SIGUSR1 IGNORÉ, avant que le code soumis n'existe : sous le même UID, il pouvait
                // l'envoyer au noteur, dont Node ouvrait alors l'INSPECTEUR sur 127.0.0.1:9229 (la
                // boucle locale existe même sans réseau) — lecture du nonce, verdict forgé.
                + "process.on('SIGUSR1', function(){});\n"
                + "const __moodit_cp=require('child_process'), __moodit_fs=require('fs');\n"
                + "try { __moodit_fs.unlinkSync('grader.js'); } catch(e) {}\n"    // hors de portée du serveur
                + "try { __moodit_fs.unlinkSync('grader.ts'); } catch(e) {}\n"    // (source TS, si présente)
                + "const __moodit_NL=String.fromCharCode(10);\n"
                + "const __moodit_child=__moodit_cp.spawn(process.execPath,['student_server.js'],{stdio:['pipe','pipe','inherit']});\n"
                + "__moodit_child.stdout.pause(); const __moodit_fd=__moodit_child.stdout._handle.fd;\n"
                // IDENTIFIANT IMPRÉVISIBLE par appel, exigé dans la réponse. Le stdout du serveur
                // étudiant EST le canal de réponse : sans identifiant, il suffisait d'y écrire une
                // réponse conforme AVANT d'être appelé pour la faire consommer comme réponse au
                // premier appel (muter console.log ne couvre pas process.stdout.write).
                + "const __moodit_crypto=require('crypto'); let __moodit_buf='';\n"
                + "function __moodit_rpc(o){\n"
                + "  o.id=__moodit_crypto.randomBytes(8).toString('hex');\n"
                + "  __moodit_child.stdin.write(JSON.stringify(o)+__moodit_NL);\n"
                + "  const b=Buffer.alloc(65536);\n"
                + "  for(;;){\n"
                + "    let i;\n"
                + "    while((i=__moodit_buf.indexOf(__moodit_NL))>=0){\n"
                + "      const line=__moodit_buf.slice(0,i); __moodit_buf=__moodit_buf.slice(i+1);\n"
                + "      let r; try{ r=JSON.parse(line); }catch(e){ continue; }\n"
                + "      if(!r || typeof r!=='object' || r.id!==o.id) continue;\n"
                + "      if(!r.ok) throw new Error(r.error); return r;\n"
                + "    }\n"
                + "    let n; try{ n=__moodit_fs.readSync(__moodit_fd,b,0,b.length,null); }"
                + "catch(e){ if(e.code==='EAGAIN') continue; throw e; }\n"
                + "    if(n===0) throw new Error('processus etudiant termine');\n"
                + "    __moodit_buf+=b.toString('utf8',0,n);\n"
                + "  }\n"
                + "}\n"
                + proxies
                + "function __moodit_harness(){\n" + harnessCode + "\n}\n"
                + "let __moodit_r=false; try{ __moodit_r=!!__moodit_harness(); }catch(e){}\n"
                + "if(__moodit_r) process.stderr.write(\"" + nonce + "\");\n"
                + "try{ __moodit_child.stdin.end(); }catch(e){}\n"
                + "process.exit(__moodit_r?0:1);\n";
        // Le texte FIXE des mandataires (`Proxy` pour une classe) compte dans l'infrastructure.
        String jsInfra = graderInfrastructure(grader, proxies.toString(), harnessCode)
                + jsFunctionProxy(SAMPLE_PROXY_NAME) + jsClassProxy(SAMPLE_PROXY_NAME);
        grader = fillShadowSlot(grader, pythonStringList(notImposed(names, startCode, jsInfra,
                JS_CALLABLE, JS_CLASS)));
        // Le serveur partage le MODULE du code soumis, et en JavaScript tout nom se masque : une
        // fonction soumise est hissée en tête du module, une `const` y ouvre une zone morte.
        // Deux règles, donc :
        //  1. les objets globaux dont la boucle a besoin (JSON, process, String, console) sont pris
        //     sur l'objet global AVANT le code soumis, par un chemin qui ne nomme AUCUN
        //     identifiant (`[].constructor.constructor` est Function) : une fonction d'aide
        //     `JSON`, `String` ou `process` ne les remplace plus ;
        //  2. un symbole soumis est résolu par `__moodit_get`, déclarée au niveau du module, où la
        //     seule locale est son paramètre préfixé. La boucle le faisait par un `eval` écrit au
        //     milieu de ses propres locales (`buf`, `d`, `i`, `line`, `m`, `r`, `objs`, `hid`…) :
        //     une fonction soumise de l'un de ces noms rendait la variable du serveur, et une
        //     réponse juste était notée fausse.
        //     Repli sur `exports` : pour `export const f = memo(…)`, tsc (module commonjs) n'émet
        //     que `exports.f = …`, sans liaison locale, et l'`eval` levait « f is not defined ».
        //     Dans un module ES, `exports` n'existe pas : l'erreur d'origine est relancée.
        String server = header
                + "const __moodit_G=[].constructor.constructor('return this')();\n"
                + "const __moodit_JSON=__moodit_G.JSON, __moodit_process=__moodit_G.process,"
                + " __moodit_String=__moodit_G.String;\n"
                + "const __moodit_NL=__moodit_String.fromCharCode(10);\n"
                + "__moodit_G.console.log=function(){}; __moodit_G.console.info=function(){};\n"
                + studentCode
                + "\nconst __moodit_get=(__moodit_n)=>{ try{ return eval(__moodit_n); }"
                + "catch(__moodit_e){ let __moodit_x; try{ __moodit_x=exports[__moodit_n]; }"
                + "catch(__moodit_f){} if(__moodit_x===void 0) throw __moodit_e; return __moodit_x; } };\n"
                + "function __moodit_serve(){ const __moodit_objs={}; let __moodit_hid=0, __moodit_buf='';\n"
                + "__moodit_process.stdin.on('data', __moodit_d=>{ __moodit_buf+=__moodit_d; let __moodit_i;\n"
                + "  while((__moodit_i=__moodit_buf.indexOf(__moodit_NL))>=0){"
                + " const __moodit_line=__moodit_buf.slice(0,__moodit_i);"
                + " __moodit_buf=__moodit_buf.slice(__moodit_i+1);\n"
                + "    let __moodit_m; try{ __moodit_m=__moodit_JSON.parse(__moodit_line); }catch(__moodit_e){ continue; }\n"
                + "    let __moodit_r;\n"
                + "    try {\n"
                + "      if(__moodit_m.op==='call') __moodit_r={ok:true,value: __moodit_get(__moodit_m.name)(...__moodit_m.args)};\n"
                + "      else if(__moodit_m.op==='new'){ const __moodit_h=__moodit_hid++;"
                + " __moodit_objs[__moodit_h]=new (__moodit_get(__moodit_m.cls))(...__moodit_m.args);"
                + " __moodit_r={ok:true,handle:__moodit_h}; }\n"
                + "      else if(__moodit_m.op==='method') __moodit_r={ok:true,value:"
                + " __moodit_objs[__moodit_m.handle][__moodit_m.name](...__moodit_m.args)};\n"
                + "      else __moodit_r={ok:false,error:'op inconnu'};\n"
                + "    } catch(__moodit_e){ __moodit_r={ok:false,error:__moodit_String(__moodit_e && __moodit_e.message || __moodit_e)}; }\n"
                // L'identifiant reçu est RENVOYÉ : il rattache la réponse à SON appel.
                + "    __moodit_r.id=__moodit_m.id;\n"
                // Retour à la ligne AVANT la réponse : même motif qu'en Python et en PHP — un
                // `process.stdout.write("x")` sans saut de ligne la contaminait.
                + "    __moodit_process.stdout.write(__moodit_NL+__moodit_JSON.stringify(__moodit_r)+__moodit_NL);\n"
                + "  }}); }\n__moodit_serve();\n";
        return new Assembled(runtimeName, List.of(
                new RunnerExec.File(graderName, grader),
                new RunnerExec.File(serverName, server)));
    }

    // ── PHP ──────────────────────────────────────────────────────────────────────

    /** Symboles PHP de premier niveau (colonne 0) : fonctions et classes. */
    private static final Pattern PHP_FUNC = Pattern.compile("(?mU)^function\\s+([\\p{L}_]\\w*)");
    private static final Pattern PHP_CLASS = Pattern.compile("(?mU)^(?:abstract\\s+|final\\s+)?class\\s+([\\p{L}_]\\w*)");

    /**
     * PHP : exécution ISOLÉE en deux processus (cf. {@link #assemblePython}). Le NOTEUR (grader.php)
     * exécute le harnais INCHANGÉ avec des proxys ; le SERVEUR (student_server.php) héberge le code
     * étudiant. RPC SYNCHRONE naturel via {@code proc_open} + {@code fgets} bloquant. Le nonce est
     * émis par le noteur, où aucun code étudiant ne tourne (même réserve que Python : UID
     * partagé, cf. {@link #assemblePython}).
     */
    private Assembled assemblePhpRpc(String studentCode, String harnessCode, String nonce) {
        StringBuilder proxies = new StringBuilder();
        for (String f : matchAll(PHP_FUNC, studentCode)) {
            if (f.startsWith("__moodit")) continue;
            proxies.append("function ").append(f).append("(...$a){ return __moodit_rpc(['op'=>'call','name'=>'")
                    .append(f).append("','args'=>$a])['value']; }\n");
        }
        for (String c : matchAll(PHP_CLASS, studentCode)) {
            if (c.startsWith("__moodit")) continue;
            proxies.append("class ").append(c).append(" { public $__moodit_h;\n")
                    .append("  function __construct(...$a){ $this->__moodit_h = __moodit_rpc(['op'=>'new','cls'=>'")
                    .append(c).append("','args'=>$a])['handle']; }\n")
                    .append("  function __call($n, $a){ return __moodit_rpc(['op'=>'method','handle'=>$this->__moodit_h,'name'=>$n,'args'=>$a])['value']; }\n")
                    .append("}\n");
        }
        String grader = "<?php\n"
                // Vidé PUIS effacé (script déjà compilé) : un descripteur que l'interpréteur
                // garderait ouvert ne rouvre plus qu'un fichier vide (cf. le noteur Bash).
                + "@file_put_contents('grader.php', '');\n"
                + "@unlink('grader.php');\n"                       // hors de portée du serveur
                + "$__moodit_pipes = [];\n"
                + "$__moodit_proc = proc_open(escapeshellarg(PHP_BINARY).' student_server.php',"
                + " [0=>['pipe','r'], 1=>['pipe','w'], 2=>STDERR], $__moodit_pipes);\n"
                + "function __moodit_rpc($o){ global $__moodit_pipes;\n"
                // IDENTIFIANT IMPRÉVISIBLE par appel, exigé dans la réponse : sans lui, un echo
                // conforme imprimé AVANT l'appel était consommé comme réponse (cf. Python).
                + "  $o['id'] = bin2hex(random_bytes(8));\n"
                + "  fwrite($__moodit_pipes[0], json_encode($o).\"\\n\");\n"
                + "  while (true) {\n"
                + "    $line = fgets($__moodit_pipes[1]);\n"
                + "    if ($line === false) throw new Exception('serveur termine');\n"
                + "    $r = json_decode($line, true);\n"
                // Le code étudiant partage stdout avec les réponses : un echo de premier niveau
                // (« 5 », « [1,2] ») n'est pas une réponse (même correctif que pour Python).
                + "    if (!is_array($r) || !array_key_exists('ok', $r)) continue;\n"
                + "    if (($r['id'] ?? null) !== $o['id']) continue;\n"
                + "    if (empty($r['ok'])) throw new Exception($r['error']);\n"
                + "    return $r;\n"
                + "  }\n"
                + "}\n"
                + proxies
                + "function __moodit_harness(){\n" + harnessCode + "\n}\n"
                + "$__moodit_r = false;\n"
                + "try { $__moodit_r = (bool) __moodit_harness(); } catch (\\Throwable $e) {}\n"
                + "if ($__moodit_r) fwrite(STDERR, \"" + nonce + "\");\n"
                + "@fclose($__moodit_pipes[0]);\n"
                + "exit($__moodit_r ? 0 : 1);\n";
        String server = studentCode      // ouvre <?php et définit fonctions/classes
                + "\n$__moodit_objs = [];\n"
                + "while (($__moodit_line = fgets(STDIN)) !== false) {\n"
                + "  $__moodit_m = json_decode($__moodit_line, true);\n"
                + "  if ($__moodit_m === null) continue;\n"
                + "  try {\n"
                + "    $__moodit_op = $__moodit_m['op'];\n"
                + "    if ($__moodit_op === 'call') $__moodit_r = ['ok'=>true,'value'=>call_user_func_array($__moodit_m['name'], $__moodit_m['args'])];\n"
                + "    elseif ($__moodit_op === 'new') { $__moodit_h = count($__moodit_objs); $__moodit_objs[$__moodit_h] = new $__moodit_m['cls'](...$__moodit_m['args']); $__moodit_r = ['ok'=>true,'handle'=>$__moodit_h]; }\n"
                + "    elseif ($__moodit_op === 'method') $__moodit_r = ['ok'=>true,'value'=>call_user_func_array([$__moodit_objs[$__moodit_m['handle']], $__moodit_m['name']], $__moodit_m['args'])];\n"
                + "    else $__moodit_r = ['ok'=>false,'error'=>'op inconnu'];\n"
                + "  } catch (\\Throwable $__moodit_e) { $__moodit_r = ['ok'=>false,'error'=>$__moodit_e->getMessage()]; }\n"
                // L'identifiant reçu est RENVOYÉ : il rattache la réponse à SON appel.
                + "  $__moodit_r['id'] = $__moodit_m['id'] ?? null;\n"
                // Retour à la ligne AVANT la réponse : un echo sans « \n » ne s'y colle pas.
                + "  fwrite(STDOUT, \"\\n\".json_encode($__moodit_r).\"\\n\");\n"
                + "}\n";
        return new Assembled("php", List.of(
                new RunnerExec.File("grader.php", grader),
                new RunnerExec.File("student_server.php", server)));
    }

    // ── Bash ─────────────────────────────────────────────────────────────────────

    /** Fonctions bash de premier niveau : {@code nom()} ou {@code function nom}. */
    // `f() {`, `function f() {` et `function f {` (sans parenthèses, écriture courante), nom
    // Unicode compris (revue #246 : sans mandataire, « command not found », 0 sur une réponse
    // juste). Lettres, chiffres et `_` seulement : ces noms sont recopiés sans guillemets dans
    // grader.sh, aucun métacaractère du shell ne doit pouvoir y entrer.
    private static final Pattern BASH_FUNC = Pattern.compile(
            "(?mU)^(?:function\\s++([\\p{L}_][\\p{L}\\p{Nd}_]*+)|([\\p{L}_][\\p{L}\\p{Nd}_]*+)\\s*+\\(\\s*+\\))");

    /** Mandataire Bash d'une fonction soumise. */
    private static String bashProxy(String f) {
        return f + "() { __moodit_rpc " + f + " \"$@\"; }\n";
    }

    /**
     * Bash : exécution ISOLÉE. Le NOTEUR (grader.sh) exécute le harnais INCHANGÉ avec des proxys ;
     * chaque appel de fonction est délégué à un SOUS-PROCESSUS FRAIS : un répartiteur passé à
     * {@code bash -c} (pas un fichier, cf. le commentaire du gabarit), qui lit « identifiant nom
     * args » sur son entrée, PUIS seulement charge le code soumis ({@code solution.sh}) dans un
     * sous-shell à la sortie capturée, appelle la fonction et renvoie sa sortie cadrée par
     * l'identifiant. Les fonctions bash étant SANS ÉTAT, un processus par appel suffit (pas
     * d'objets). Le nonce est émis par le noteur, où aucun code étudiant ne tourne ;
     * {@code grader.sh} se vide puis s'efface avant tout appel.
     *
     * <p><b>Portée de la garantie.</b> Le cadrage par identifiant ferme la forge par la sortie, et
     * le code soumis ne reçoit pas l'identifiant. Il subsiste un <b>résiduel assumé</b>, de même
     * nature que celui du harnais au format framework : le mode « exec » du runner exécute noteur
     * et code soumis <b>sous le même UID</b> (contrairement au chemin des harnais booléens
     * compilés, qui sépare les UID), donc un étudiant déterminé peut encore inspecter les
     * processus voisins selon la politique {@code ptrace} de l'hôte. Pour un examen noté, la
     * propriété « verdict non falsifiable » ne vaut que pour les six langages compilés avec un
     * harnais booléen.
     */
    private Assembled assembleBashRpc(String studentCode, String harnessCode, String nonce,
            String startCode) {
        StringBuilder proxies = new StringBuilder();
        java.util.LinkedHashSet<String> names = new java.util.LinkedHashSet<>();
        java.util.Set<String> mentioned = harnessNames(harnessCode);
        for (String f : matchAll(BASH_FUNC, studentCode)) {
            if (f.startsWith("__moodit")) continue;
            if (!mentioned.contains(f)) continue;   // cf. harnessMentions
            names.add(f);
            proxies.append(bashProxy(f));
        }
        // REFUS d'un nom qui masque une commande : en bash, une fonction passe avant les
        // commandes internes et les programmes du PATH. Le mandataire `test() { … }` remplaçait
        // donc, dans le harnais, le `test` de `test "$(f)" = 9` par le code soumis — de même
        // `expr`, `grep`, `bc`… Vérifié AVANT de définir les mandataires, par `type -t` dans
        // l'image même : la liste est exactement celle des commandes que le harnais peut appeler.
        // Vérification construite APRÈS le gabarit : elle dépend de ce que l'infrastructure du
        // noteur emploie (cf. notImposed). Le gabarit porte SHADOW_SLOT à sa place.
        // CADRAGE PAR IDENTIFIANT : la valeur rendue est la ligne « <id>|valeur », et seule
        // celle-ci est retenue. Un `echo` de premier niveau du code étudiant ne vaut donc plus
        // réponse — c'était la forge naïve (imprimer l'attendu, ne rien imprimer dans sa
        // fonction). Le code étudiant ne peut pas davantage CONTREFAIRE cette ligne : le
        // répartiteur lit l'identifiant AVANT de charger ce code (la ligne de requête est déjà
        // consommée), et il charge puis appelle dans un SOUS-SHELL où l'identifiant est retiré de
        // la portée et dont la sortie est CAPTURÉE.
        //
        // Deux détails qui comptent, parce que noteur et code soumis partagent l'UID :
        //   — le répartiteur n'est PAS un fichier : il est passé à `bash -c`. Dans un fichier, le
        //     code soumis pouvait le réécrire, et c'est lui qui détient l'identifiant à l'appel
        //     suivant. Son texte ne contient aucun secret, le voir sur une ligne de commande ne
        //     donne donc rien ;
        //   — le filtrage de la réponse se fait DANS le shell du noteur (`case`), et non par un
        //     `sed "s/^$__id|//p"` : l'identifiant passait alors en argument d'un processus, donc
        //     lisible par tout voisin du même UID.
        String dispatcher = "read -r __moodit_id __moodit_name __moodit_rest\n"
                + "__moodit_val=$(unset __moodit_id;"
                + " . ./solution.sh >/dev/null 2>&1;"
                + " $__moodit_name $__moodit_rest)\n"
                // STATUT de l'appel réel (celui de la substitution) : il voyage avec la valeur.
                // Le mandataire renvoyait toujours 0 — `if est_pair 3` était vrai pour toute
                // réponse, et une réponse juste qui renvoie 1 était notée fausse.
                + "__moodit_st=$?\n"
                // La valeur part en HEXADÉCIMAL sur UNE ligne : le noteur ne retient que la ligne
                // « id|… », une valeur multi-ligne perdait donc tout sauf sa première — réponse
                // juste notée fausse. `-v` est OBLIGATOIRE : sans lui, od compresse les répétitions
                // en « * » et la valeur décodée serait fausse.
                + "printf '%s|%s|%s\\n' \"$__moodit_id\" \"$__moodit_st\" "
                + "\"$(printf '%s' \"$__moodit_val\" | od -An -vtx1 | tr -d ' \n')\"\n";
        // Le noteur entier est UN SEUL bloc `{ … }` : bash le lit et l'analyse en entier avant
        // d'en exécuter la première commande. Il peut donc VIDER son propre fichier avant tout
        // appel au code soumis. L'effacer ne suffisait pas : bash garde le script ouvert (fd 255)
        // et, sous le même UID, /proc/<pid>/fd/255 rouvrait le fichier supprimé — harnais et
        // nonce compris. Vidé, il ne contient plus rien ; le nonce ne vit plus qu'en mémoire.
        String grader = "{\n"
                + ": > grader.sh 2>/dev/null; rm -f grader.sh 2>/dev/null\n"
                + "__moodit_srv=" + shellSingleQuote(dispatcher) + "\n"
                + "__moodit_rpc() { local __n=\"$1\"; shift;"
                + " local __id; __id=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \\n');"
                + " printf '%s\\n' \"$__id $__n $*\" | bash -c \"$__moodit_srv\" 2>/dev/null"
                // Ligne « id|statut|hex » : la valeur est décodée, puis le dernier élément du
                // tube SORT avec le statut de l'appel réel — c'est celui du tube, donc du
                // mandataire. Statut illisible ou réponse absente → 1, jamais 0.
                + " | { while IFS= read -r __l; do case \"$__l\" in \"$__id|\"*)"
                + " __l=\"${__l#*|}\"; __moodit_dec \"${__l#*|}\";"
                + " case \"${__l%%|*}\" in ''|*[!0-9]*) exit 1;; esac; exit \"${__l%%|*}\";;"
                + " esac; done; exit 1; }; }\n"
                // Décodage en UNE passe (pas de xxd dans l'image) : sed fait de chaque paire
                // d'hexas un `\xHH`, que printf %b rend en octet ; puis le saut de ligne que
                // la ligne unique du protocole avait absorbé. Une boucle octet par octet
                // (`${__h:__i:2}` coûte O(n) en bash) prenait un temps QUADRATIQUE : une valeur
                // de 15 Ko dépassait le temps limite, réponse juste notée « Interrompu ».
                + "__moodit_dec() { local __e; __e=$(printf '%s' \"$1\" | sed 's/../\\\\x&/g'); printf '%b\\n' \"$__e\"; }\n"
                + SHADOW_SLOT
                + proxies
                + "__moodit_harness() {\n" + harnessCode + "\n}\n"
                + "if __moodit_harness; then printf '%s' '" + nonce + "' >&2; exit 0; else exit 1; fi\n"
                + "}\n";
        java.util.Set<String> checked = notImposed(names, startCode,
                graderInfrastructure(grader, proxies.toString(), harnessCode)
                        + bashProxy(SAMPLE_PROXY_NAME), BASH_FUNC);
        String shadowCheck = checked.isEmpty() ? "" : "for __moodit_n in " + String.join(" ", checked)
                + "; do if [ -n \"$(type -t \"$__moodit_n\")\" ]; then printf '%s%s%s\\n' "
                + shellSingleQuote(SHADOW_PREFIX) + " \"$__moodit_n\" "
                + shellSingleQuote(" » est réservé : il masque une commande de bash ou du "
                        + "système, que le harnais peut appeler. Renommer cette fonction, puis "
                        + "resoumettre.")
                + " >&2; exit 1; fi; done\n";
        grader = fillShadowSlot(grader, shadowCheck);
        return new Assembled("bash", List.of(
                new RunnerExec.File("grader.sh", grader),
                new RunnerExec.File("solution.sh", studentCode)));
    }

    /** Littéral shell à guillemets simples, sûr pour un texte quelconque. */
    private static String shellSingleQuote(String sourceText) {
        return "'" + sourceText.replace("'", "'\\''") + "'";
    }


    /**
     * Nom de fichier pour un « run » Java : la classe publique doit correspondre au fichier
     * ({@code Solution} → {@code Solution.java}), à défaut {@code Main.java}. Même règle que la
     * notation : un seul lecteur du nom de fichier Java.
     */
    private static String javaFileName(String studentCode) {
        return com.moodit.execution_service.sandbox.HarnessProjects.javaFileName(studentCode, "Main");
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
                new RunnerExec.File("main.js", main),
                new RunnerExec.File("submission.json", studentJson)));
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
                new RunnerExec.File("main.js", main),
                new RunnerExec.File("submission.json", studentJson)));
    }

    // ── SQL (SQLite) ─────────────────────────────────────────────────────────────

    /** Marqueur, dans un harnais SQL, indiquant où insérer le code étudiant (mode « modification »). */
    private static final Pattern SQL_STUDENT_MARKER = Pattern.compile("(?im)^[ \\t]*--[ \\t]*@student\\b.*$");
    /**
     * Instruction d'un dump à CONSERVER en phase 2 : {@code CREATE TABLE …} / {@code INSERT INTO …},
     * en capturant le NOM de la table ciblée (groupe 1) pour ne garder que les tables de travail.
     */
    private static final Pattern SQL_DUMP_TARGET = Pattern.compile(
            "(?isU)^\\s*(?:CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO)"
                    + "\\s+[\"'`\\[]?(\\w+)");
    /**
     * {@code CREATE TABLE <nom>} — pour lister les tables de travail déclarées par le prof (setup).
     * Nom Unicode compris (`(?U)`) : `CREATE TABLE élèves` donnait une liste vide, la phase 2
     * rechargeait une base vide et notait 0 une réponse juste (revue #246).
     */
    private static final Pattern SQL_CREATE_TABLE = Pattern.compile(
            "(?isU)CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+[\"'`\\[]?(\\w+)");

    /** Vrai si le harnais porte {@code -- @student} → mode modification (exécution ISOLÉE en 2 phases). */
    public static boolean sqlHasStudentMarker(String harnessCode) {
        return harnessCode != null && SQL_STUDENT_MARKER.matcher(harnessCode).find();
    }

    /**
     * Noms (minuscules) des tables de TRAVAIL déclarées dans le SETUP du harnais (partie avant le
     * marqueur). Sert de LISTE BLANCHE au filtrage du dump : la phase 2 ne recharge QUE ces tables.
     * Découple le filtrage de la plomberie de l'environnement sqlite (ex. table {@code argv}) : tout ce qui
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
        return new Assembled("sqlite3", List.of(new RunnerExec.File("main.sql", program.toString())));
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
        // `.print` et non `SELECT '…'` : un `.mode box` (ou table, json, line…) posé par le code
        // soumis encadrait la sentinelle, qui n'était plus reconnue — « État de la base
        // introuvable », 0 sur une réponse juste. `.print` ignore le mode d'affichage.
        program.append(".print ").append(sqlDumpStart(nonce)).append('\n');
        program.append(".dump\n");
        program.append(".print ").append(sqlDumpEnd(nonce)).append('\n');
        return new Assembled("sqlite3", List.of(new RunnerExec.File("main.sql", program.toString())));
    }

    /**
     * Phase 2 (mode modification) — NOTEUR ISOLÉ. On recharge l'état final de l'étudiant réduit aux
     * seules {@code CREATE TABLE}/{@code INSERT} des tables de travail (cf. {@link #filterDumpToData},
     * qui refuse tout dump portant un paramètre) : ni vue, ni déclencheur, ni {@code PRAGMA} — chaque
     * instruction gardée est UNE instruction pour SQLite, le découpage suivant son tokenizer. Le prof
     * crée ensuite sa référence (à mettre en {@code TEMP}) + son verdict, encadré par les sentinelles
     * au nonce.
     */
    public Assembled assembleSqlPhase2(String studentData, String harnessCode, String nonce) {
        Matcher marker = SQL_STUDENT_MARKER.matcher(harnessCode == null ? "" : harnessCode);
        String verdict = marker.find() ? harnessCode.substring(marker.end()) : (harnessCode == null ? "" : harnessCode);
        StringBuilder program = new StringBuilder(studentData == null ? "" : studentData);
        if (program.length() > 0 && program.charAt(program.length() - 1) != '\n') {
            program.append('\n');
        }
        appendFenced(program, verdict, nonce);
        return new Assembled("sqlite3", List.of(new RunnerExec.File("main.sql", program.toString())));
    }

    /**
     * Réduit un dump SQLite ({@code .dump}) aux seules instructions de DONNÉES ({@code CREATE TABLE},
     * {@code INSERT}) portant sur une table de la LISTE BLANCHE {@code allowedTables} (les tables de
     * travail déclarées par le prof, cf. {@link #sqlWorkingTables}). On jette donc TOUT le reste :
     * {@code CREATE VIEW}/{@code TRIGGER}/{@code INDEX}, {@code PRAGMA}, {@code BEGIN}/{@code COMMIT},
     * la plomberie de l'environnement sqlite ({@code argv}), les tables {@code sqlite_*}, et toute table
     * fabriquée par l'étudiant. La phase 2 ne rejoue ainsi que des tables ATTENDUES + des INSERT à
     * littéraux échappés — aucun objet exécutable, aucun couplage aux internes du paquet.
     *
     * <p>Le texte d'un {@code CREATE TABLE} vient de {@code sqlite_master}, que le code soumis peut
     * RÉÉCRIRE en phase 1 ({@code PRAGMA writable_schema}). Le filtre ne vaut donc que si chaque
     * instruction gardée en est UNE pour SQLite : le découpage suit son tokenizer (paramètres
     * compris, cf. {@link #splitSqlStatements}), et un dump dont une instruction gardée porte un
     * paramètre ({@code $x(…)}, {@code :x}, {@code @x}, {@code #x}, {@code ?}) est REFUSÉ —
     * {@code .dump} n'en écrit jamais, et un {@code $x(/*)} faisait voir à un autre analyseur
     * (celui du shell {@code sqlite3}) un commentaire là où SQLite exécute la suite : vue
     * {@code TEMP} masquant la table de travail, verdict forgé (revue #246).
     *
     * @return les instructions gardées, ou {@code null} si le dump est refusé
     */
    public static String filterDumpToData(String dump, Set<String> allowedTables) {
        StringBuilder out = new StringBuilder();
        List<Boolean> withParameter = new ArrayList<>();
        List<String> statements = splitSqlStatements(dump, withParameter);
        for (int k = 0; k < statements.size(); k++) {
            String statement = statements.get(k);
            Matcher m = SQL_DUMP_TARGET.matcher(statement);
            if (!m.find()) {
                continue; // ni CREATE TABLE ni INSERT (vue, déclencheur, PRAGMA, BEGIN/COMMIT…)
            }
            String table = m.group(1).toLowerCase(Locale.ROOT);
            if (!allowedTables.contains(table)) {
                continue; // hors des tables de travail du prof (plomberie, sqlite_*, table étudiant)
            }
            if (withParameter.get(k)) {
                return null; // schéma réécrit : jamais produit par .dump (cf. javadoc)
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
     *
     * <p>Une ligne qui ne contient que {@code go} ou {@code /} (hors chaîne et commentaire) est
     * AUSSI une fin d'instruction : l'interpréteur {@code sqlite3} la traite comme un {@code ;}
     * (héritage SQL Server / Oracle). Sans cette règle, une telle ligne faisait sortir la
     * réponse de son {@code CREATE VIEW} : la suite s'exécutait au premier niveau, commandes
     * point comprises, et pouvait imprimer un bloc de verdict avant le vrai.
     *
     * <p>Les PARAMÈTRES sont lus comme le tokenizer de SQLite ({@code tokenize.c}) : {@code ?}
     * suivi de chiffres, et {@code $}, {@code @}, {@code :}, {@code #} suivis de caractères
     * d'identifiant, de {@code ::} et d'un éventuel groupe {@code (…)} qui court jusqu'à la
     * parenthèse fermante ou au premier blanc (variable TCL). Ce groupe peut contenir
     * {@code /*}, {@code '} ou {@code ;} sans ouvrir de commentaire, de chaîne ni finir
     * l'instruction : sans cette règle, le découpage voyait un commentaire là où SQLite
     * exécutait la suite.
     */
    static List<String> splitSqlStatements(String sql) {
        return splitSqlStatements(sql, null);
    }

    /**
     * {@link #splitSqlStatements(String)}, et pour chaque instruction rendue, dans
     * {@code withParameter} (si non nul), si elle porte un paramètre hors chaîne et commentaire.
     */
    static List<String> splitSqlStatements(String sql, List<Boolean> withParameter) {
        List<String> statements = new ArrayList<>();
        if (sql == null) {
            return statements;
        }
        boolean hasParameter = false;
        StringBuilder current = new StringBuilder();
        // Le segment porte-t-il du SQL réel (hors blancs et commentaires) ? Tenu PENDANT le
        // découpage, qui connaît déjà les bornes des commentaires : une regex appliquée après
        // coup relançait un balayage jusqu'à la fin à chaque « /* » non fermé — quadratique, et
        // le dump de la phase 1 (jusqu'à 512 000 caractères) est du contenu étudiant (#116).
        boolean hasCode = false;
        int i = 0;
        int n = sql.length();
        while (i < n) {
            char c = sql.charAt(i);
            char next = i + 1 < n ? sql.charAt(i + 1) : '\0';
            if (i == 0 || sql.charAt(i - 1) == '\n') { // début de ligne : terminateur go ou / ?
                int eol = sql.indexOf('\n', i);
                int lineEnd = eol < 0 ? n : eol;
                if (isShellTerminatorLine(sql.substring(i, lineEnd))) {
                    addStatement(statements, current, hasCode, withParameter, hasParameter);
                    current.setLength(0);
                    hasCode = false;
                    hasParameter = false;
                    i = eol < 0 ? n : eol + 1;
                    continue;
                }
            }
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
                hasCode = true;
                i = end;
            } else if (c == '[') { // identifiant crocheté SQLite (pas d'échappement)
                int end = sql.indexOf(']', i + 1);
                end = end < 0 ? n : end + 1;
                current.append(sql, i, end);
                hasCode = true;
                i = end;
            } else if (c == ';') { // fin d'instruction
                addStatement(statements, current, hasCode, withParameter, hasParameter);
                current.setLength(0);
                hasCode = false;
                hasParameter = false;
                i++;
            } else if (c == '?' || c == '@' || c == ':' || c == '#'
                    || (c == '$' && (i == 0 || !isSqlIdChar(sql.charAt(i - 1))))) { // paramètre
                int end = parameterEnd(sql, i);
                current.append(sql, i, end);
                hasCode = true;
                hasParameter = true;
                i = end;
            } else {
                current.append(c);
                hasCode |= !Character.isWhitespace(c);
                i++;
            }
        }
        addStatement(statements, current, hasCode, withParameter, hasParameter);
        return statements;
    }

    /** Caractère d'identifiant pour SQLite ({@code IdChar}) : lettre ASCII, chiffre, _, $, ou non ASCII. */
    private static boolean isSqlIdChar(char c) {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                || c == '_' || c == '$' || c >= 0x80;
    }

    /** Fin (exclue) du paramètre qui commence en {@code start}, comme {@code tokenize.c}. */
    private static int parameterEnd(String sql, int start) {
        int n = sql.length();
        int i = start + 1;
        if (sql.charAt(start) == '?') {
            while (i < n && sql.charAt(i) >= '0' && sql.charAt(i) <= '9') {
                i++;
            }
            return i;
        }
        int idChars = 0;
        while (i < n) {
            char c = sql.charAt(i);
            if (isSqlIdChar(c)) {
                idChars++;
                i++;
            } else if (c == '(' && idChars > 0) {
                // Variable TCL : jusqu'à la parenthèse fermante (incluse) ou au premier blanc.
                i++;
                while (i < n && sql.charAt(i) != ')' && !isSqlSpace(sql.charAt(i))) {
                    i++;
                }
                return i < n && sql.charAt(i) == ')' ? i + 1 : i;
            } else if (c == ':' && i + 1 < n && sql.charAt(i + 1) == ':') {
                i += 2;
            } else {
                break;
            }
        }
        return i;
    }

    /** Blanc pour SQLite ({@code sqlite3Isspace}) : espace, et \t \n \v \f \r. */
    private static boolean isSqlSpace(char c) {
        return c == ' ' || (c >= '\t' && c <= '\r');
    }

    /**
     * Vrai si la ligne est un terminateur d'instruction pour l'interpréteur {@code sqlite3} :
     * {@code go} (casse indifférente) ou {@code /}, entourés seulement de blancs et de
     * commentaires fermés — même règle que {@code line_is_command_terminator} du shell SQLite.
     * Plus large que lui au besoin (découper davantage ne laisse rien déborder), jamais plus
     * étroite.
     */
    static boolean isShellTerminatorLine(String line) {
        int i = 0;
        int n = line.length();
        while (i < n && isSqlShellSpace(line.charAt(i))) {
            i++;
        }
        if (i < n && line.charAt(i) == '/') {
            return onlyBlanksOrComments(line, i + 1);
        }
        if (i + 1 < n && Character.toLowerCase(line.charAt(i)) == 'g'
                && Character.toLowerCase(line.charAt(i + 1)) == 'o') {
            return onlyBlanksOrComments(line, i + 2);
        }
        return false;
    }

    /** Reste de ligne fait uniquement de blancs, de {@code -- …} et de {@code /* … *}{@code /} fermés. */
    private static boolean onlyBlanksOrComments(String line, int from) {
        int i = from;
        int n = line.length();
        while (i < n) {
            char c = line.charAt(i);
            if (isSqlShellSpace(c)) {
                i++;
            } else if (c == '-' && i + 1 < n && line.charAt(i + 1) == '-') {
                return true; // commentaire jusqu'à la fin de la ligne
            } else if (c == '/' && i + 1 < n && line.charAt(i + 1) == '*') {
                int close = line.indexOf("*/", i + 2);
                if (close < 0) {
                    return false; // commentaire ouvert : l'instruction n'est pas complète
                }
                i = close + 2;
            } else {
                return false;
            }
        }
        return true;
    }

    /** Blancs au sens de {@code isspace} du C (ce qu'utilise le shell SQLite). */
    private static boolean isSqlShellSpace(char c) {
        return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\u000B' || c == '\f';
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
    private static void addStatement(List<String> statements, StringBuilder segment, boolean hasCode,
            List<Boolean> withParameter, boolean hasParameter) {
        if (hasCode) {
            statements.add(segment.toString().strip());
            if (withParameter != null) {
                withParameter.add(hasParameter);
            }
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
                new RunnerExec.File("main.js", main),
                new RunnerExec.File("htmlparser.js", vendor("htmlparser.js")),
                new RunnerExec.File("submission.html", studentHtml)));
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
        // Exécution ISOLÉE en deux processus (comme les autres langages interprétés) : le NOTEUR
        // (main.js) exécute le harnais INCHANGÉ avec des proxys DOM ; le SERVEUR (jsx-server.js)
        // transpile + rend/monte le composant étudiant et détient le DOM. `html`, `mount`, `click`,
        // `fireEvent` et les nœuds DOM (querySelector, textContent…) sont proxifiés par RPC synchrone.
        // Le nonce est émis par le noteur, où aucun code étudiant ne tourne — plus de fichier nonce
        // (même réserve que Python : UID partagé, cf. assemblePython).
        String server = "const fs = require('fs');\n"
                + "const rt = require('./react-runtime.js');\n"
                + "const { React, ReactDOMServer, ReactDOMClient, act, HappyDOM, Babel } = rt;\n"
                + "const win = new HappyDOM.Window({ url: 'http://localhost/' });\n"
                + "global.window = win; global.document = win.document; global.navigator = win.navigator;\n"
                + "globalThis.IS_REACT_ACT_ENVIRONMENT = true;\n"
                + "['HTMLElement','Element','Node','Text','Event','MouseEvent','KeyboardEvent','InputEvent','CustomEvent','getComputedStyle','customElements','requestAnimationFrame','cancelAnimationFrame'].forEach(function(k){ if(win[k]!==undefined) global[k]=win[k]; });\n"
                // console.log/info neutralisés AVANT le chargement du composant : le stdout
                // du serveur est le canal de réponse, et un log honnête au niveau module ou
                // pendant le rendu le polluait — comme dans le serveur JS ordinaire.
                + "console.log=function(){}; console.info=function(){};\n"
                + "let Composant;\n"
                + "try {\n"
                + "  let src = fs.readFileSync(__dirname + '/component.tsx','utf8');\n"
                + "  src = src.replace(/^\\s*import\\s.+$/gm,'').replace(/^\\s*export\\s+(default\\s+)?/gm,'');\n"
                + "  const js = Babel.transform(src, {presets:['react','typescript'], filename:'component.tsx'}).code;\n"
                + "  const useState=React.useState,useEffect=React.useEffect,useRef=React.useRef,useMemo=React.useMemo,useCallback=React.useCallback,useReducer=React.useReducer,useContext=React.useContext,Fragment=React.Fragment;\n"
                + "  const factory = new Function('React','useState','useEffect','useRef','useMemo','useCallback','useReducer','useContext','Fragment', js + '\\n; return (typeof Composant!==\"undefined\")?Composant:undefined;');\n"
                + "  Composant = factory(React,useState,useEffect,useRef,useMemo,useCallback,useReducer,useContext,React.Fragment);\n"
                + "} catch(e) {}\n"
                + "const reg = [];\n"
                + "function store(v){ reg.push(v); return reg.length-1; }\n"
                + "function isNode(v){ return v && typeof v==='object' && typeof v.nodeType==='number'; }\n"
                + "function wrap(v){ if(isNode(v)) return {node:store(v)}; if(typeof v==='function') return {fn:true}; return {value:(v===undefined?null:v)}; }\n"
                + "const NL=String.fromCharCode(10); let buf='';\n"
                + "process.stdin.on('data', function(d){ buf+=d; let i;\n"
                + "  while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);\n"
                + "    let m; try{ m=JSON.parse(line);}catch(e){continue;}\n"
                + "    let r;\n"
                + "    try {\n"
                + "      if(m.op==='render') r={ok:true, value: ReactDOMServer.renderToStaticMarkup(React.createElement(Composant, m.props||{}))};\n"
                + "      else if(m.op==='mount'){ const ct=document.createElement('div'); document.body.appendChild(ct); const root=ReactDOMClient.createRoot(ct); act(function(){ root.render(React.createElement(Composant, m.props||{})); }); r={ok:true, node:store(ct)}; }\n"
                + "      else if(m.op==='get') r=Object.assign({ok:true}, wrap(reg[m.handle][m.name]));\n"
                + "      else if(m.op==='call'){ const el=reg[m.handle]; r=Object.assign({ok:true}, wrap(el[m.name].apply(el, m.args||[]))); }\n"
                + "      else if(m.op==='click'){ act(function(){ reg[m.handle].dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})); }); r={ok:true,value:null}; }\n"
                + "      else if(m.op==='fireEvent'){ act(function(){ reg[m.handle].dispatchEvent(new window.Event(m.type, Object.assign({bubbles:true,cancelable:true}, m.init||{}))); }); r={ok:true,value:null}; }\n"
                + "      else r={ok:false,error:'op inconnu'};\n"
                + "    } catch(e){ r={ok:false,error:String(e&&e.message||e)}; }\n"
                // L'identifiant reçu est RENVOYÉ (il rattache la réponse à SON appel), et
                // la réponse est AUTO-CADRÉE par un saut de ligne initial : une écriture
                // étudiante sans saut de ligne final ne la contamine pas.
                + "    r.id=m.id;\n"
                + "    process.stdout.write(NL+JSON.stringify(r)+NL);\n"
                + "  }});\n";
        // SIGUSR1 ignoré avant le lancement du composant (cf. assembleJsRpc : inspecteur Node).
        String grader = "process.on('SIGUSR1', function(){});\n"
                + "const cp=require('child_process'), fs=require('fs');\n"
                + "try{fs.unlinkSync('main.js');}catch(e){}\n"
                + "const NL=String.fromCharCode(10);\n"
                + "const child=cp.spawn(process.execPath,['jsx-server.js'],{stdio:['pipe','pipe','inherit']});\n"
                + "child.stdout.pause(); const outFd=child.stdout._handle.fd;\n"
                // IDENTIFIANT IMPRÉVISIBLE par appel, exigé dans la réponse — même invariant
                // que les neuf autres répartiteurs : sans lui, une ligne conforme écrite
                // d'avance par le composant était consommée comme réponse (devancement), et
                // un console.log honnête cassait le JSON de la première ligne (réponse juste
                // notée 0). Tampon PERSISTANT : l'ancien lecteur jetait tout ce qui suivait
                // la première ligne à chaque appel.
                + "const crypto=require('crypto'); let buf='';\n"
                + "function rpc(o){ o.id=crypto.randomBytes(8).toString('hex');\n"
                + "  child.stdin.write(JSON.stringify(o)+NL); const b=Buffer.alloc(1<<20);\n"
                + "  for(;;){ let i;\n"
                + "    while((i=buf.indexOf(NL))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);\n"
                + "      let r; try{ r=JSON.parse(line); }catch(e){ continue; }\n"
                + "      if(!r || typeof r!=='object' || r.id!==o.id) continue;\n"
                + "      if(!r.ok) throw new Error(r.error); return r; }\n"
                + "    let n; try{ n=fs.readSync(outFd,b,0,b.length,null); }catch(e){ if(e.code==='EAGAIN') continue; throw e; }\n"
                + "    if(n===0) throw new Error('processus etudiant termine'); \n"
                + "    buf+=b.toString('utf8',0,n); } }\n"
                + "function uw(r){ if(r.node!==undefined) return elp(r.node); return r.value; }\n"
                + "function elp(handle){ return new Proxy({__h:handle}, { get(t,p){ if(p==='__h')return handle;\n"
                + "  const r=rpc({op:'get',handle,name:String(p)});\n"
                + "  if(r.fn) return (...args)=>uw(rpc({op:'call',handle,name:String(p),args:args.map(a=>(a&&a.__h!==undefined)?a.__h:a)}));\n"
                + "  return uw(r); } }); }\n"
                + "function render(C,p){ return rpc({op:'render', props:p||{}}).value; }\n"
                + "function mount(C,p){ return elp(rpc({op:'mount', props:p||{}}).node); }\n"
                + "function click(el){ rpc({op:'click', handle:(el&&el.__h)}); }\n"
                + "function fireEvent(el,type,init){ rpc({op:'fireEvent', handle:(el&&el.__h), type, init}); }\n"
                + "const Composant = {__moodit_placeholder:true};\n"   // le harnais y référence « Composant » ; ignoré (le serveur détient le vrai)
                + "let html; try{ html = rpc({op:'render', props:{}}).value; }catch(e){ html=undefined; }\n"
                + "function __moodit_harness(){\n" + harnessCode + "\n}\n"
                + "let __moodit_r=false; try{ __moodit_r=!!__moodit_harness(); }catch(e){}\n"
                + "if(__moodit_r) process.stderr.write(\"" + nonce + "\");\n"
                + "try{ child.stdin.end(); }catch(e){}\n"
                + "process.exit(__moodit_r?0:1);\n";
        return new Assembled("javascript", List.of(
                new RunnerExec.File("main.js", grader),
                new RunnerExec.File("jsx-server.js", server),
                new RunnerExec.File("react-runtime.js", vendor("react-runtime.js")),
                new RunnerExec.File("component.tsx", studentCode)));
    }
}
