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
            case "javascript" -> assembleJsRpc(code, harness, nonce, false);
            case "typescript" -> assembleJsRpc(code, harness, nonce, true);
            case "php" -> assemblePhpRpc(code, harness, nonce);
            case "bash" -> assembleBashRpc(code, harness, nonce);
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

    /**
     * Vrai si le langage est COMPILÉ (C, C++, Go, Rust, C#, Java). Comme les interprétés, ils sont
     * notés en DEUX processus (le code étudiant ne voit jamais le nonce) ; le binaire unique de Piston
     * se dédouble par {@code fork()} (C/C++) ou re-exec de soi-même (Go/Rust/C#/Java). Le nonce est lu
     * sur le stdin du PARENT (noteur) au runtime, pas gravé dans le source (cf. ExecutionService).
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

    /** Noms de fonctions et classes de PREMIER NIVEAU définis par l'étudiant (pour créer les proxys). */
    private static final Pattern PY_DEF = Pattern.compile("(?m)^(?:async\\s+)?def\\s+([A-Za-z_]\\w*)");
    private static final Pattern PY_CLASS = Pattern.compile("(?m)^class\\s+([A-Za-z_]\\w*)");

    /**
     * Python : exécution ISOLÉE en deux processus (cf. proxy/RPC). Le harnais du prof tourne
     * INCHANGÉ dans un NOTEUR (grader.py) qui ne contient AUCUN code étudiant ; les symboles de
     * l'étudiant (fonctions/classes) y sont des PROXYS qui délèguent, par RPC (JSON sur stdin/stdout),
     * à un SERVEUR (student_server.py) où vit le vrai code étudiant. Conséquences :
     * <ul>
     *   <li>le nonce est émis par le NOTEUR (aucun code étudiant → infalsifiable) — le résiduel de
     *       lecture de source disparaît (le serveur étudiant n'a pas de nonce) ;</li>
     *   <li>les ATTENDUS du harnais restent dans le noteur, hors de portée de l'étudiant (mémoire
     *       distincte, {@code grader.py} auto-supprimé) → passer = produire les bonnes sorties ;</li>
     *   <li>ExecutionService est inchangé : il vérifie toujours le nonce.</li>
     * </ul>
     */
    private Assembled assemblePython(String studentCode, String harnessCode, String nonce) {
        StringBuilder proxies = new StringBuilder();
        for (String f : matchAll(PY_DEF, studentCode)) {
            if (f.startsWith("__moodit")) continue;   // pas de collision avec l'infra du noteur
            proxies.append("def ").append(f).append("(*a):\n")
                    .append("    return __moodit_rpc({\"op\": \"call\", \"name\": \"").append(f)
                    .append("\", \"args\": list(a)})[\"value\"]\n");
        }
        for (String c : matchAll(PY_CLASS, studentCode)) {
            if (c.startsWith("__moodit")) continue;
            // NB : dans un corps de classe, un identifiant `__x` subit le name mangling Python
            // (→ `_Classe__x`). On référence donc le RPC via globals()["..."] (clé string, non manglée).
            proxies.append("class ").append(c).append(":\n")
                    .append("    def __init__(self, *a):\n")
                    .append("        object.__setattr__(self, \"_h\", globals()[\"__moodit_rpc\"]({\"op\": \"new\", \"class\": \"")
                    .append(c).append("\", \"args\": list(a)})[\"handle\"])\n")
                    .append("    def __getattr__(self, name):\n")
                    .append("        h = object.__getattribute__(self, \"_h\")\n")
                    .append("        def _call(*a):\n")
                    .append("            return globals()[\"__moodit_rpc\"]({\"op\": \"method\", \"handle\": h, \"name\": name, \"args\": list(a)})[\"value\"]\n")
                    .append("        return _call\n");
        }
        // Tous les identifiants internes sont préfixés __moodit_ → aucune collision avec un symbole étudiant.
        String grader = "import os as __moodit_os\n"
                + "try:\n    __moodit_os.remove('grader.py')\nexcept Exception:\n    pass\n"
                + "import sys as __moodit_sys, subprocess as __moodit_subprocess, json as __moodit_json\n"
                + "__moodit_p = __moodit_subprocess.Popen([__moodit_sys.executable, 'student_server.py'],"
                + " stdin=__moodit_subprocess.PIPE, stdout=__moodit_subprocess.PIPE, text=True)\n"
                + "def __moodit_rpc(payload):\n"
                + "    print(__moodit_json.dumps(payload), file=__moodit_p.stdin, flush=True)\n"
                + "    while True:\n"
                + "        line = __moodit_p.stdout.readline()\n"
                + "        if not line: raise RuntimeError('processus etudiant termine')\n"
                + "        try: r = __moodit_json.loads(line)\n"
                + "        except Exception: continue\n"
                // Le code étudiant partage stdout avec les réponses RPC : un print de premier niveau
                // dont la sortie est du JSON valide (« 5 », « [1, 2] ») n'est pas une réponse.
                + "        if not isinstance(r, dict) or 'ok' not in r: continue\n"
                + "        if not r.get('ok'): raise RuntimeError(str(r.get('error')))\n"
                + "        return r\n"
                + proxies
                + "def __moodit_harness():\n"
                + indent(harnessCode, "    ")
                + "\ntry:\n    __moodit_r = bool(__moodit_harness())\nexcept BaseException:\n    __moodit_r = False\n"
                + "if __moodit_r:\n    __moodit_sys.stderr.write(\"" + nonce + "\")\n"
                + "try:\n    __moodit_p.stdin.close()\nexcept Exception:\n    pass\n"
                + "__moodit_sys.exit(0 if __moodit_r else 1)\n";
        // Boucle RPC dans une FONCTION → ses variables ne polluent pas les globals (symboles étudiant).
        String server = "import sys as __moodit_sys, json as __moodit_json\n"
                + studentCode
                + "\ndef __moodit_serve():\n"
                + "    objs = {}\n"
                + "    for line in __moodit_sys.stdin:\n"
                + "        try: m = __moodit_json.loads(line)\n"
                + "        except Exception: continue\n"
                + "        try:\n"
                + "            op = m.get('op')\n"
                + "            if op == 'call':\n"
                + "                r = {'ok': True, 'value': globals()[m['name']](*m['args'])}\n"
                + "            elif op == 'new':\n"
                + "                h = len(objs); objs[h] = globals()[m['class']](*m['args']); r = {'ok': True, 'handle': h}\n"
                + "            elif op == 'method':\n"
                + "                r = {'ok': True, 'value': getattr(objs[m['handle']], m['name'])(*m['args'])}\n"
                + "            else:\n"
                + "                r = {'ok': False, 'error': 'op inconnu'}\n"
                + "        except Exception as e:\n"
                + "            r = {'ok': False, 'error': str(e)}\n"
                + "        print(__moodit_json.dumps(r), flush=True)\n"
                + "__moodit_serve()\n";
        return new Assembled("python", List.of(
                new PistonClient.File("grader.py", grader),
                new PistonClient.File("student_server.py", server)));
    }

    /** Toutes les captures du groupe 1 d'un motif dans un texte (ordre d'apparition, doublons possibles). */
    private static List<String> matchAll(Pattern pattern, String text) {
        List<String> out = new ArrayList<>();
        Matcher m = pattern.matcher(text == null ? "" : text);
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }

    // ── JavaScript / TypeScript ─────────────────────────────────────────────────

    /** Symboles JS de premier niveau : fonctions/const/let/var (appelables) et classes. */
    private static final Pattern JS_CALLABLE = Pattern.compile(
            "(?m)^(?:async\\s+)?function\\s*\\*?\\s*([A-Za-z_$][\\w$]*)"
                    + "|(?m)^(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=");
    private static final Pattern JS_CLASS = Pattern.compile("(?m)^class\\s+([A-Za-z_$][\\w$]*)");

    /**
     * JavaScript : exécution ISOLÉE en deux processus (cf. {@link #assemblePython} pour le principe).
     * Le NOTEUR (grader.js) exécute le harnais INCHANGÉ avec des proxys ; le SERVEUR (student_server.js)
     * héberge le code étudiant. RPC SYNCHRONE (le harnais est synchrone) via {@code fs.readSync} sur le
     * fd du sous-processus. Le nonce est émis par le noteur (aucun code étudiant → infalsifiable).
     */
    private Assembled assembleJsRpc(String studentCode, String harnessCode, String nonce, boolean typescript) {
        // TS : fichiers nommés SANS extension → Piston les écrit en .ts et compile en .js (student_server.js,
        // grader.js). `// @ts-nocheck` neutralise les erreurs de type (on veut exécuter, pas typer).
        String header = typescript ? "// @ts-nocheck\n" : "";
        String pistonLang = typescript ? "typescript" : "javascript";
        String graderName = typescript ? "grader" : "grader.js";
        String serverName = typescript ? "student_server" : "student_server.js";
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
        for (String f : callables) {
            proxies.append("function ").append(f).append("(...a){ return __moodit_rpc({op:'call',name:'")
                    .append(f).append("',args:a}).value; }\n");
        }
        for (String c : classes) {
            proxies.append("const ").append(c).append(" = new Proxy(function(){}, { construct(_t,args){")
                    .append(" const h=__moodit_rpc({op:'new',cls:'").append(c).append("',args}).handle;")
                    .append(" return new Proxy({}, { get(_o,p){ return (...a)=>__moodit_rpc({op:'method',handle:h,name:p,args:a}).value; } }); } });\n");
        }
        // Tous les identifiants internes sont préfixés __moodit_ → aucune collision avec un symbole étudiant.
        String grader = header
                + "const __moodit_cp=require('child_process'), __moodit_fs=require('fs');\n"
                + "try { __moodit_fs.unlinkSync('grader.js'); } catch(e) {}\n"    // hors de portée du serveur
                + "try { __moodit_fs.unlinkSync('grader.ts'); } catch(e) {}\n"    // (source TS, si présente)
                + "const __moodit_NL=String.fromCharCode(10);\n"
                + "const __moodit_child=__moodit_cp.spawn(process.execPath,['student_server.js'],{stdio:['pipe','pipe','inherit']});\n"
                + "__moodit_child.stdout.pause(); const __moodit_fd=__moodit_child.stdout._handle.fd;\n"
                + "function __moodit_rpc(o){\n"
                + "  __moodit_child.stdin.write(JSON.stringify(o)+__moodit_NL);\n"
                + "  const b=Buffer.alloc(65536); let s='';\n"
                + "  while(s.indexOf(__moodit_NL)<0){ let n; try{ n=__moodit_fs.readSync(__moodit_fd,b,0,b.length,null); }"
                + "catch(e){ if(e.code==='EAGAIN') continue; throw e; } if(n===0) break; s+=b.toString('utf8',0,n); }\n"
                + "  const r=JSON.parse(s.split(__moodit_NL)[0]); if(!r.ok) throw new Error(r.error); return r;\n"
                + "}\n"
                + proxies
                + "function __moodit_harness(){\n" + harnessCode + "\n}\n"
                + "let __moodit_r=false; try{ __moodit_r=!!__moodit_harness(); }catch(e){}\n"
                + "if(__moodit_r) process.stderr.write(\"" + nonce + "\");\n"
                + "try{ __moodit_child.stdin.end(); }catch(e){}\n"
                + "process.exit(__moodit_r?0:1);\n";
        // Boucle RPC dans une FONCTION → ses variables ne polluent pas la portée des symboles étudiant.
        String server = header
                + "const __moodit_NL=String.fromCharCode(10);\n"
                + "console.log=function(){}; console.info=function(){};\n"
                + studentCode
                + "\nfunction __moodit_serve(){ const objs={}; let hid=0, buf='';\n"
                + "process.stdin.on('data', d=>{ buf+=d; let i;\n"
                + "  while((i=buf.indexOf(__moodit_NL))>=0){ const line=buf.slice(0,i); buf=buf.slice(i+1);\n"
                + "    let m; try{ m=JSON.parse(line); }catch(e){ continue; }\n"
                + "    let r;\n"
                + "    try {\n"
                + "      if(m.op==='call') r={ok:true,value: eval(m.name)(...m.args)};\n"
                + "      else if(m.op==='new'){ const h=hid++; objs[h]=new (eval(m.cls))(...m.args); r={ok:true,handle:h}; }\n"
                + "      else if(m.op==='method') r={ok:true,value: objs[m.handle][m.name](...m.args)};\n"
                + "      else r={ok:false,error:'op inconnu'};\n"
                + "    } catch(e){ r={ok:false,error:String(e && e.message || e)}; }\n"
                + "    process.stdout.write(JSON.stringify(r)+__moodit_NL);\n"
                + "  }}); }\n__moodit_serve();\n";
        return new Assembled(pistonLang, List.of(
                new PistonClient.File(graderName, grader),
                new PistonClient.File(serverName, server)));
    }

    // ── PHP ──────────────────────────────────────────────────────────────────────

    /** Symboles PHP de premier niveau (colonne 0) : fonctions et classes. */
    private static final Pattern PHP_FUNC = Pattern.compile("(?m)^function\\s+([A-Za-z_]\\w*)");
    private static final Pattern PHP_CLASS = Pattern.compile("(?m)^(?:abstract\\s+|final\\s+)?class\\s+([A-Za-z_]\\w*)");

    /**
     * PHP : exécution ISOLÉE en deux processus (cf. {@link #assemblePython}). Le NOTEUR (grader.php)
     * exécute le harnais INCHANGÉ avec des proxys ; le SERVEUR (student_server.php) héberge le code
     * étudiant. RPC SYNCHRONE naturel via {@code proc_open} + {@code fgets} bloquant. Le nonce est
     * émis par le noteur (aucun code étudiant → infalsifiable).
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
                + "@unlink('grader.php');\n"                       // hors de portée du serveur
                + "$__moodit_pipes = [];\n"
                + "$__moodit_proc = proc_open(escapeshellarg(PHP_BINARY).' student_server.php',"
                + " [0=>['pipe','r'], 1=>['pipe','w'], 2=>STDERR], $__moodit_pipes);\n"
                + "function __moodit_rpc($o){ global $__moodit_pipes;\n"
                + "  fwrite($__moodit_pipes[0], json_encode($o).\"\\n\");\n"
                + "  while (true) {\n"
                + "    $line = fgets($__moodit_pipes[1]);\n"
                + "    if ($line === false) throw new Exception('serveur termine');\n"
                + "    $r = json_decode($line, true);\n"
                // Le code étudiant partage stdout avec les réponses : un echo de premier niveau
                // (« 5 », « [1,2] ») n'est pas une réponse (même correctif que pour Python).
                + "    if (!is_array($r) || !array_key_exists('ok', $r)) continue;\n"
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
                // Retour à la ligne AVANT la réponse : un echo sans « \n » ne s'y colle pas.
                + "  fwrite(STDOUT, \"\\n\".json_encode($__moodit_r).\"\\n\");\n"
                + "}\n";
        return new Assembled("php", List.of(
                new PistonClient.File("grader.php", grader),
                new PistonClient.File("student_server.php", server)));
    }

    // ── Bash ─────────────────────────────────────────────────────────────────────

    /** Fonctions bash de premier niveau : {@code nom()} ou {@code function nom}. */
    private static final Pattern BASH_FUNC = Pattern.compile("(?m)^(?:function\\s+)?([A-Za-z_]\\w*)\\s*\\(\\s*\\)");

    /**
     * Bash : exécution ISOLÉE. Le NOTEUR (grader.sh) exécute le harnais INCHANGÉ avec des proxys ;
     * chaque appel de fonction est délégué à un SOUS-PROCESSUS FRAIS ({@code bash student_server.sh})
     * qui charge le code étudiant, lit « nom args », appelle la fonction et renvoie sa sortie. Les
     * fonctions bash étant SANS ÉTAT, un processus par appel suffit (pas d'objets). Le nonce est émis
     * par le noteur (aucun code étudiant → infalsifiable) ; {@code grader.sh} est auto-supprimé.
     */
    private Assembled assembleBashRpc(String studentCode, String harnessCode, String nonce) {
        StringBuilder proxies = new StringBuilder();
        for (String f : matchAll(BASH_FUNC, studentCode)) {
            if (f.startsWith("__moodit")) continue;
            proxies.append(f).append("() { __moodit_rpc ").append(f).append(" \"$@\"; }\n");
        }
        String grader = "rm -f grader.sh 2>/dev/null\n"     // hors de portée du serveur (fd déjà ouvert)
                + "__moodit_rpc() { local __n=\"$1\"; shift; printf '%s\\n' \"$__n $*\""
                + " | bash student_server.sh 2>/dev/null; }\n"
                + proxies
                + "__moodit_harness() {\n" + harnessCode + "\n}\n"
                + "if __moodit_harness; then printf '%s' '" + nonce + "' >&2; exit 0; else exit 1; fi\n";
        String server = studentCode
                + "\nread -r __moodit_name __moodit_rest\n"
                + "$__moodit_name $__moodit_rest\n";
        return new Assembled("bash", List.of(
                new PistonClient.File("grader.sh", grader),
                new PistonClient.File("student_server.sh", server)));
    }

    // ══ Langages COMPILÉS ══════════════════════════════════════════════════════════
    //
    // Isolation anti-triche en DEUX PROCESSUS, comme les interprétés (cf. #116). Piston compile en UN
    // binaire ; ce binaire se DÉDOUBLE : fork() (C/C++) ou re-exec de soi-même avec un drapeau de rôle
    // (Go/Rust via /proc/self/exe & current_exe ; C#/Java en relançant mono/le JVM sur la source).
    //   - PARENT (noteur) : lit le nonce sur SON stdin (le child reçoit un canal distinct), exécute le
    //     harnais INCHANGÉ, réémet le nonce en cas de succès. Il détient SEUL le nonce (mémoire privée).
    //   - CHILD (serveur étudiant) : héberge le vrai code étudiant, répond aux appels par RPC. Il ne
    //     voit jamais le nonce — ni en mémoire (espace séparé, /proc/<ppid>/mem refusé par ptrace/yama),
    //     ni sur stdin (canal distinct). C/C++ : le child ferme fd 0 et le parent lit le nonce APRÈS le
    //     fork, donc il n'est ni dans la mémoire copiée ni lisible via le tube.
    // Les symboles étudiant appelés par le harnais deviennent des STUBS typés (générés depuis les
    // signatures) qui délèguent au child ; les définitions/appels étudiant sont renommés
    // (__moodit_s_* ; via #define en C/C++, régex ailleurs). Marshalling JSON (Go) ou netstring (autres).
    // Périmètre pilote par langage : types scalaires (+ slices en Go) ; un type hors périmètre rend la
    // fonction inappelable (stub qui échoue), sans casser les autres.

    // ── Go ───────────────────────────────────────────────────────────────────────

    /** Fonctions Go de premier niveau : {@code func nom(params) ret {} }. */
    private static final Pattern GO_FUNC =
            Pattern.compile("(?m)^func\\s+([A-Za-z_]\\w*)\\s*\\(([^)]*)\\)\\s*([^{]*)\\{");
    /** Déclaration de struct Go top-level : {@code type Nom struct { … } } (capture le nom). */
    private static final Pattern GO_STRUCT =
            Pattern.compile("(?m)^type\\s+(\\w+)\\s+struct\\s*\\{");
    /** Méthode Go (récepteur) : {@code func (r [*]Type) Nom(params) ret {} } — groupes recv/type/nom/params/ret. */
    private static final Pattern GO_METHOD =
            Pattern.compile("(?m)^func\\s*\\(\\s*(\\w+)\\s+(\\*?)(\\w+)\\s*\\)\\s*(\\w+)\\s*\\(([^)]*)\\)\\s*([^{]*)\\{");

    /**
     * Go : exécution ISOLÉE en DEUX processus (comme les interprétés, mais obtenue autrement — cf. #116).
     * Piston compile {@code main.go} en UN binaire natif ; ce binaire se RE-EXÉCUTE lui-même
     * ({@code /proc/self/exe __moodit_student}) pour obtenir un second processus :
     * <ul>
     *   <li>le PARENT est le NOTEUR : il lit le nonce sur SON stdin (le child reçoit un stdin distinct),
     *       exécute le harnais INCHANGÉ, et réémet le nonce en cas de succès ;</li>
     *   <li>le CHILD est le SERVEUR étudiant : il héberge le vrai code étudiant et répond aux appels par
     *       RPC (JSON sur stdin/stdout). Il ne voit jamais le nonce (mémoire du parent, hors ptrace) ;</li>
     *   <li>les symboles étudiant appelés par le harnais sont des STUBS typés (générés depuis les
     *       signatures) qui délèguent au child ; les définitions/appels étudiant sont renommés
     *       {@code __moodit_s_*} pour laisser les noms d'origine aux stubs.</li>
     * </ul>
     * POO : pour un struct à champs scalaires, un type STUB (mêmes champs) dont les méthodes envoient
     * les VALEURS des champs + les args ; le child reconstruit le vrai struct (même {@code package main}
     * → champs non exportés accessibles) et appelle la méthode. Sémantique VALEUR (une méthode qui mute
     * le récepteur ne persiste pas entre appels). Périmètre : paramètres/retour/champs parmi {@code int},
     * {@code int64}, {@code float64}, {@code bool}, {@code string} et slices {@code []T} ; un type hors
     * périmètre rend la fonction/méthode inappelable (stub qui panique), sans casser les autres.
     */
    private Assembled assembleGo(String studentCode, String harnessCode, String nonce) {
        String student = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;

        // 1) Collecter les fonctions top-level (nom, params, type de retour), hors main.
        List<String[]> funcs = new ArrayList<>();
        Matcher fm = GO_FUNC.matcher(student);
        while (fm.find()) {
            if (!"main".equals(fm.group(1))) {
                funcs.add(new String[] {fm.group(1), fm.group(2), fm.group(3).trim()});
            }
        }

        // 1b) Collecter les structs (nom → champs) et les méthodes (récepteur) pour la POO. Tout étant
        //     dans `package main`, le code généré pourra lire/écrire même les champs NON exportés.
        java.util.LinkedHashMap<String, List<String[]>> structs = new java.util.LinkedHashMap<>();
        Matcher sm = GO_STRUCT.matcher(student);
        while (sm.find()) {
            int open = student.indexOf('{', sm.start());
            int close = javaMatchBrace(student, open);
            if (close < 0) continue;
            String fbody = student.substring(open + 1, close).replaceAll("[;\\n]", ",");
            structs.put(sm.group(1), goExpandParams(fbody));
        }
        List<String[]> methods = new ArrayList<>();
        Matcher mem = GO_METHOD.matcher(student);
        while (mem.find()) {
            methods.add(new String[] {mem.group(3), mem.group(4), mem.group(5), mem.group(6).trim()});
        }

        // 2) Neutraliser le main étudiant, puis renommer définitions ET appels des fonctions étudiant
        //    en __moodit_s_* (nom entier, jamais précédé d'un point → on épargne les appels de méthode).
        String code = student.replaceAll("func\\s+main\\s*\\(", "func __moodit_student_main(");
        for (String[] f : funcs) {
            code = code.replaceAll("(?<![\\w.])" + Pattern.quote(f[0]) + "(?=\\s*\\()", "__moodit_s_" + f[0]);
        }
        // Renommer les TYPES struct étudiant → __MooditStudent_* (défs, littéraux, récepteurs, retours) ;
        // les stubs gardent les noms d'origine pour le harnais.
        for (String s : structs.keySet()) {
            code = code.replaceAll("\\b" + Pattern.quote(s) + "\\b", "__MooditStudent_" + s);
        }

        // 3) Insérer notre infrastructure APRÈS la déclaration `package` (PAS la 1ère ligne : elle peut
        //    être un commentaire — c'était le bug qui plaçait nos imports avant `package`).
        Matcher pm = Pattern.compile("(?m)^package\\s+\\w+.*$").matcher(code);
        int pkgEnd = pm.find() ? pm.end() : 0;
        String head = code.substring(0, pkgEnd);
        String tail = code.substring(pkgEnd);

        StringBuilder stubs = new StringBuilder();
        StringBuilder cases = new StringBuilder();
        Set<String> sliceTypes = new java.util.LinkedHashSet<>();
        for (String[] f : funcs) {
            String name = f[0];
            List<String[]> params = goExpandParams(f[1]);
            String ret = f[2];
            for (String[] p : params) {
                if (p[1].startsWith("[]")) sliceTypes.add(p[1].substring(2));
            }
            if (ret.startsWith("[]")) sliceTypes.add(ret.substring(2));

            String sig = params.stream().map(p -> p[0] + " " + p[1]).collect(Collectors.joining(", "));
            String callArgs = params.stream().map(p -> p[0]).collect(Collectors.joining(", "));

            // Supporté ssi params + retour sont tous marshalables.
            boolean supported = (ret.isEmpty() || goConv("x", ret) != null)
                    && params.stream().allMatch(p -> goConv("x", p[1]) != null);
            if (!supported) {
                // Stub + case qui paniquent : la fonction reste déclarée (les autres compilent).
                stubs.append("func ").append(name).append("(").append(sig).append(")")
                        .append(ret.isEmpty() ? "" : " " + ret)
                        .append(" { panic(\"type non supporte par l'isolation RPC\") }\n");
                cases.append("\t\tcase \"").append(name).append("\":\n\t\t\tpanic(\"type non supporte\")\n");
                continue;
            }

            String rpcCall = "__moodit_rpc(\"" + name + "\""
                    + (callArgs.isEmpty() ? "" : ", " + callArgs) + ")";
            if (ret.isEmpty()) {
                stubs.append("func ").append(name).append("(").append(sig).append(") { ")
                        .append(rpcCall).append(" }\n");
            } else {
                stubs.append("func ").append(name).append("(").append(sig).append(") ").append(ret)
                        .append(" { return ").append(goConv(rpcCall, ret)).append(" }\n");
            }

            StringBuilder realCall = new StringBuilder("__moodit_s_").append(name).append("(");
            for (int i = 0; i < params.size(); i++) {
                if (i > 0) realCall.append(", ");
                realCall.append(goConv("__a[" + i + "]", params.get(i)[1]));
            }
            realCall.append(")");
            cases.append("\t\tcase \"").append(name).append("\":\n");
            if (ret.isEmpty()) {
                cases.append("\t\t\t").append(realCall)
                        .append("\n\t\t\t__resp = map[string]interface{}{\"ok\": true, \"value\": nil}\n");
            } else {
                cases.append("\t\t\t__resp = map[string]interface{}{\"ok\": true, \"value\": ")
                        .append(realCall).append("}\n");
            }
        }

        // POO : pour chaque struct à champs scalaires, un type STUB (mêmes champs) ; ses méthodes
        // envoient les VALEURS DES CHAMPS + les args, et le child reconstruit le vrai struct (possible
        // car même `package main`, champs non exportés compris) puis appelle la méthode. Sémantique
        // VALEUR : une méthode qui mute le récepteur ne persiste pas entre appels (périmètre pilote).
        for (var se : structs.entrySet()) {
            String sname = se.getKey();
            List<String[]> fields = se.getValue();
            if (fields.isEmpty() || !fields.stream().allMatch(f -> goConv("x", f[1]) != null)) continue;
            for (String[] f : fields) if (f[1].startsWith("[]")) sliceTypes.add(f[1].substring(2));
            stubs.append("type ").append(sname).append(" struct { ")
                    .append(fields.stream().map(f -> f[0] + " " + f[1]).collect(Collectors.joining("; ")))
                    .append(" }\n");
            for (String[] m : methods) {
                if (!m[0].equals(sname)) continue;
                String mname = m[1];
                List<String[]> mp = goExpandParams(m[2]);
                String mret = m[3];
                String msig = mp.stream().map(p -> p[0] + " " + p[1]).collect(Collectors.joining(", "));
                boolean ok = (mret.isEmpty() || goConv("x", mret) != null)
                        && mp.stream().allMatch(p -> goConv("x", p[1]) != null);
                if (!ok) {
                    stubs.append("func (__self ").append(sname).append(") ").append(mname).append("(").append(msig)
                            .append(")").append(mret.isEmpty() ? "" : " " + mret)
                            .append(" { panic(\"type non supporte par l'isolation RPC\") }\n");
                    continue;
                }
                for (String[] p : mp) if (p[1].startsWith("[]")) sliceTypes.add(p[1].substring(2));
                if (mret.startsWith("[]")) sliceTypes.add(mret.substring(2));
                String key = sname + "." + mname;
                String fieldVals = fields.stream().map(f -> "__self." + f[0]).collect(Collectors.joining(", "));
                String argVals = mp.stream().map(p -> p[0]).collect(Collectors.joining(", "));
                String allVals = fieldVals + (argVals.isEmpty() ? "" : ", " + argVals);
                String rpc = "__moodit_rpc(\"" + key + "\", " + allVals + ")";
                if (mret.isEmpty()) {
                    stubs.append("func (__self ").append(sname).append(") ").append(mname).append("(").append(msig)
                            .append(") { ").append(rpc).append(" }\n");
                } else {
                    stubs.append("func (__self ").append(sname).append(") ").append(mname).append("(").append(msig)
                            .append(") ").append(mret).append(" { return ").append(goConv(rpc, mret)).append(" }\n");
                }
                StringBuilder recon = new StringBuilder("__MooditStudent_").append(sname).append("{");
                for (int i = 0; i < fields.size(); i++) {
                    if (i > 0) recon.append(", ");
                    recon.append(fields.get(i)[0]).append(": ").append(goConv("__a[" + i + "]", fields.get(i)[1]));
                }
                recon.append("}");
                StringBuilder mcall = new StringBuilder();
                for (int i = 0; i < mp.size(); i++) {
                    if (i > 0) mcall.append(", ");
                    mcall.append(goConv("__a[" + (fields.size() + i) + "]", mp.get(i)[1]));
                }
                cases.append("\t\tcase \"").append(key).append("\":\n");
                cases.append("\t\t\t__moodit_recv := ").append(recon).append("\n");
                if (mret.isEmpty()) {
                    cases.append("\t\t\t__moodit_recv.").append(mname).append("(").append(mcall).append(")\n")
                            .append("\t\t\t__resp = map[string]interface{}{\"ok\": true, \"value\": nil}\n");
                } else {
                    cases.append("\t\t\t__resp = map[string]interface{}{\"ok\": true, \"value\": __moodit_recv.")
                            .append(mname).append("(").append(mcall).append(")}\n");
                }
            }
        }

        StringBuilder helpers = new StringBuilder();
        for (String t : sliceTypes) {
            String h = goSliceHelper(t);
            if (h != null) helpers.append(h).append("\n");
        }

        String program = head + "\n"
                + "import __moodit_bufio \"bufio\"\n"
                + "import __moodit_json \"encoding/json\"\n"
                + "import __moodit_fmt \"fmt\"\n"
                + "import __moodit_exec \"os/exec\"\n"
                + "import __moodit_os \"os\"\n"
                + "import __moodit_strings \"strings\"\n"
                + tail + "\n"
                + helpers
                + "var __moodit_cin *__moodit_bufio.Writer\n"
                + "var __moodit_cout *__moodit_bufio.Reader\n"
                + "func __moodit_rpc(name string, args ...interface{}) interface{} {\n"
                + "\treq := map[string]interface{}{\"name\": name, \"args\": args}\n"
                + "\tb, _ := __moodit_json.Marshal(req)\n"
                + "\t__moodit_cin.Write(b); __moodit_cin.WriteByte('\\n'); __moodit_cin.Flush()\n"
                + "\tline, err := __moodit_cout.ReadString('\\n')\n"
                + "\tif err != nil { panic(\"serveur etudiant termine\") }\n"
                + "\tvar resp map[string]interface{}\n"
                + "\t__moodit_json.Unmarshal([]byte(line), &resp)\n"
                + "\tif ok, _ := resp[\"ok\"].(bool); !ok { panic(\"rpc echec\") }\n"
                + "\treturn resp[\"value\"]\n"
                + "}\n"
                + stubs
                + "func __moodit_serve() {\n"
                + "\t__in := __moodit_bufio.NewReader(__moodit_os.Stdin)\n"
                + "\t__out := __moodit_bufio.NewWriter(__moodit_os.Stdout)\n"
                + "\tfor {\n"
                + "\t\t__line, __e := __in.ReadString('\\n')\n"
                + "\t\tif __e != nil { break }\n"
                + "\t\t__line = __moodit_strings.TrimSpace(__line)\n"
                + "\t\tif __line == \"\" { continue }\n"
                + "\t\tvar __req map[string]interface{}\n"
                + "\t\tif __moodit_json.Unmarshal([]byte(__line), &__req) != nil { continue }\n"
                + "\t\t__name, _ := __req[\"name\"].(string)\n"
                + "\t\t__a, _ := __req[\"args\"].([]interface{})\n"
                + "\t\t_ = __a\n"
                + "\t\tvar __resp map[string]interface{}\n"
                + "\t\tfunc() {\n"
                + "\t\t\tdefer func() { if r := recover(); r != nil { __resp = map[string]interface{}{\"ok\": false, \"error\": __moodit_fmt.Sprint(r)} } }()\n"
                + "\t\t\tswitch __name {\n"
                + cases
                + "\t\t\tdefault:\n"
                + "\t\t\t\t__resp = map[string]interface{}{\"ok\": false, \"error\": \"symbole inconnu\"}\n"
                + "\t\t\t}\n"
                + "\t\t}()\n"
                + "\t\t__b, _ := __moodit_json.Marshal(__resp)\n"
                + "\t\t__out.Write(__b); __out.WriteByte('\\n'); __out.Flush()\n"
                + "\t}\n"
                + "}\n"
                + "func __moodit_harness() bool {\n"
                + harness
                + "\n}\n"
                + "func main() {\n"
                + "\tif len(__moodit_os.Args) > 1 && __moodit_os.Args[1] == \"__moodit_student\" { __moodit_serve(); return }\n"
                + "\t__secret, _ := __moodit_bufio.NewReader(__moodit_os.Stdin).ReadString('\\n')\n"
                + "\t__secret = __moodit_strings.TrimSpace(__secret)\n"
                + "\t__child := __moodit_exec.Command(\"/proc/self/exe\", \"__moodit_student\")\n"
                + "\t__wIn, _ := __child.StdinPipe()\n"
                + "\t__rOut, _ := __child.StdoutPipe()\n"
                + "\t__child.Stderr = __moodit_os.Stderr\n"
                + "\t__moodit_cin = __moodit_bufio.NewWriter(__wIn)\n"
                + "\t__moodit_cout = __moodit_bufio.NewReader(__rOut)\n"
                + "\tif __child.Start() != nil { __moodit_os.Exit(1) }\n"
                + "\t__ok := false\n"
                + "\tfunc() { defer func() { recover() }(); __ok = __moodit_harness() }()\n"
                + "\tif __ok { __moodit_fmt.Fprint(__moodit_os.Stderr, __secret) }\n"
                + "\t__wIn.Close()\n"
                + "\tif __ok { __moodit_os.Exit(0) }\n"
                + "\t__moodit_os.Exit(1)\n"
                + "}\n";
        return new Assembled("go", List.of(new PistonClient.File("main.go", program)));
    }

    /** Éclate une liste de paramètres Go en couples {@code {nom, type}} (gère {@code n, m int}). */
    private static List<String[]> goExpandParams(String params) {
        List<String[]> out = new ArrayList<>();
        String trimmed = params == null ? "" : params.trim();
        if (trimmed.isEmpty()) {
            return out;
        }
        List<String> pending = new ArrayList<>();
        for (String part : trimmed.split(",")) {
            String p = part.trim();
            if (p.isEmpty()) continue;
            String[] toks = p.split("\\s+", 2);
            if (toks.length == 1) {
                pending.add(toks[0]); // nom seul : hérite du type du prochain segment typé
            } else {
                for (String nm : pending) out.add(new String[] {nm, toks[1]});
                pending.clear();
                out.add(new String[] {toks[0], toks[1]});
            }
        }
        return out;
    }

    /** Expression Go convertissant une valeur JSON décodée ({@code interface{}}) vers {@code type},
     *  ou {@code null} si le type n'est pas marshalable (hors périmètre pilote). */
    private static String goConv(String expr, String type) {
        return switch (type) {
            case "int" -> "int(" + expr + ".(float64))";
            case "int64" -> "int64(" + expr + ".(float64))";
            case "float64" -> expr + ".(float64)";
            case "bool" -> expr + ".(bool)";
            case "string" -> expr + ".(string)";
            case "[]int", "[]string" -> "__moodit_slice_" + type.substring(2) + "(" + expr + ")";
            default -> null;
        };
    }

    /** Fonction d'aide Go convertissant {@code []interface{}} (JSON) en {@code []T}, ou {@code null}. */
    private static String goSliceHelper(String element) {
        return switch (element) {
            case "int" -> "func __moodit_slice_int(v interface{}) []int { a,_ := v.([]interface{}); "
                    + "r := make([]int, len(a)); for i := range a { r[i] = int(a[i].(float64)) }; return r }";
            case "string" -> "func __moodit_slice_string(v interface{}) []string { a,_ := v.([]interface{}); "
                    + "r := make([]string, len(a)); for i := range a { r[i] = a[i].(string) }; return r }";
            default -> null;
        };
    }

    // ── Rust ─────────────────────────────────────────────────────────────────────

    /** Fonction Rust de premier niveau : {@code fn nom(params) -> ret {} } (ret optionnel). */
    private static final Pattern RUST_FUNC =
            Pattern.compile("(?m)^fn\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:->\\s*([^{]+?))?\\s*\\{");
    /** Types scalaires marshalables Rust. */
    private static final Set<String> RUST_SCALARS = Set.of("i32", "i64", "f64", "bool", "String");
    /** Déclaration de struct Rust top-level : {@code struct Nom { … } } (capture le nom). */
    private static final Pattern RUST_STRUCT = Pattern.compile("(?m)^struct\\s+(\\w+)\\s*\\{");
    /** Bloc {@code impl Nom { … }} inhérent (pas {@code impl Trait for …}). */
    private static final Pattern RUST_IMPL = Pattern.compile("(?m)^impl\\s+(\\w+)\\s*\\{");
    /** Méthode dans un {@code impl} : {@code fn nom(params) -> ret {} } (params inclut le récepteur). */
    private static final Pattern RUST_METHOD =
            Pattern.compile("fn\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:->\\s*([^{]+?))?\\s*\\{");

    /**
     * Rust : exécution ISOLÉE en DEUX processus (cf. #116, même modèle que {@link #assembleGo}). Le
     * binaire natif se RE-EXÉCUTE ({@code current_exe() __moodit_student}) comme serveur étudiant. Le
     * PARENT (noteur) lit le nonce sur SON stdin, exécute le harnais INCHANGÉ et réémet le nonce en cas
     * de succès ; le CHILD héberge le vrai code étudiant et répond par RPC (netstring). Les fonctions
     * étudiant (défs + appels) sont renommées {@code __moodit_s_*} ; des STUBS de même nom délèguent au
     * child. POO : type STUB (mêmes champs) + {@code impl} dont les méthodes envoient les valeurs des
     * champs + les args ; le child reconstruit {@code __MooditStudent_Type { … }} (même module → champs
     * privés accessibles) et appelle la méthode. Sémantique VALEUR (mutation non persistée). Périmètre :
     * paramètres/retour/champs scalaires ({@code i32, i64, f64, bool, String}).
     */
    private Assembled assembleRust(String studentCode, String harnessCode, String nonce) {
        String student = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;

        List<String[]> funcs = new ArrayList<>();
        Matcher fm = RUST_FUNC.matcher(student);
        while (fm.find()) {
            if (!"main".equals(fm.group(1))) {
                funcs.add(new String[] {fm.group(1), fm.group(2), fm.group(3) == null ? "" : fm.group(3).trim()});
            }
        }
        // POO : structs (nom → champs) + méthodes (par impl). Tout est dans le même module (un seul
        // fichier) → le code généré peut lire/écrire les champs, même privés.
        java.util.LinkedHashMap<String, List<String[]>> rstructs = new java.util.LinkedHashMap<>();
        Matcher rsm = RUST_STRUCT.matcher(student);
        while (rsm.find()) {
            int open = student.indexOf('{', rsm.start());
            int close = javaMatchBrace(student, open);
            if (close < 0) continue;
            String fbody = student.substring(open + 1, close).replaceAll("[;\\n]", ",");
            rstructs.put(rsm.group(1), rustParseParams(fbody));
        }
        List<String[]> rmethods = new ArrayList<>(); // [type, nom, paramsAvecSelf, ret]
        Matcher rim = RUST_IMPL.matcher(student);
        while (rim.find()) {
            String implType = rim.group(1);
            int open = student.indexOf('{', rim.start());
            int close = javaMatchBrace(student, open);
            if (close < 0) continue;
            Matcher rmm = RUST_METHOD.matcher(student.substring(open + 1, close));
            while (rmm.find()) {
                rmethods.add(new String[] {implType, rmm.group(1), rmm.group(2),
                        rmm.group(3) == null ? "" : rmm.group(3).trim()});
            }
        }

        String code = student.replaceAll("\\bfn\\s+main\\s*\\(", "fn __moodit_student_main(");
        for (String[] f : funcs) {
            code = code.replaceAll("(?<![\\w.])" + Pattern.quote(f[0]) + "(?=\\s*\\()", "__moodit_s_" + f[0]);
        }
        // Renommer les types struct étudiant → __MooditStudent_* (défs, impls, littéraux, retours) ;
        // les stubs gardent les noms d'origine pour le harnais.
        for (String s : rstructs.keySet()) {
            code = code.replaceAll("\\b" + Pattern.quote(s) + "\\b", "__MooditStudent_" + s);
        }

        StringBuilder stubs = new StringBuilder();
        StringBuilder cases = new StringBuilder();
        for (String[] f : funcs) {
            String name = f[0];
            List<String[]> params = rustParseParams(f[1]);
            String ret = f[2];
            String sig = params.stream().map(p -> p[0] + ": " + p[1]).collect(Collectors.joining(", "));
            boolean supported = (ret.isEmpty() || RUST_SCALARS.contains(ret))
                    && params.stream().allMatch(p -> RUST_SCALARS.contains(p[1]));
            if (!supported) {
                stubs.append("fn ").append(name).append("(").append(sig).append(")")
                        .append(ret.isEmpty() ? "" : " -> " + ret)
                        .append(" { panic!(\"type non supporte\"); }\n");
                continue;
            }
            String encArgs = params.stream().map(p -> "format!(\"{}\", " + p[0] + ")").collect(Collectors.joining(", "));
            String rpc = "__moodit_rpc(\"" + name + "\", &[" + encArgs + "])";
            if (ret.isEmpty()) {
                stubs.append("fn ").append(name).append("(").append(sig).append(") { ").append(rpc).append("; }\n");
            } else {
                stubs.append("fn ").append(name).append("(").append(sig).append(") -> ").append(ret)
                        .append(" { ").append(rustDec(rpc, ret)).append(" }\n");
            }
            StringBuilder reads = new StringBuilder();
            StringBuilder decls = new StringBuilder();
            StringBuilder callArgs = new StringBuilder();
            for (int i = 0; i < params.size(); i++) {
                reads.append("          let __s").append(i).append(" = __moodit_ns_read(&mut __r).unwrap_or_default();\n");
                decls.append("let __a").append(i).append(": ").append(params.get(i)[1]).append(" = ")
                        .append(rustDec("__s" + i, params.get(i)[1])).append("; ");
                if (i > 0) callArgs.append(", ");
                callArgs.append("__a").append(i);
            }
            String realCall = "__moodit_s_" + name + "(" + callArgs + ")";
            cases.append("        \"").append(name).append("\" => {\n").append(reads)
                    .append("          let __res = std::panic::catch_unwind(move || { ").append(decls);
            if (ret.isEmpty()) {
                cases.append(realCall).append("; });\n")
                        .append("          match __res { Ok(_) => { __moodit_ns_write(&mut __w, \"1\"); __moodit_ns_write(&mut __w, \"\"); }, Err(_) => { __moodit_ns_write(&mut __w, \"0\"); __moodit_ns_write(&mut __w, \"\"); } }\n        }\n");
            } else {
                cases.append(realCall).append(" });\n")
                        .append("          match __res { Ok(__v) => { __moodit_ns_write(&mut __w, \"1\"); __moodit_ns_write(&mut __w, &format!(\"{}\", __v)); }, Err(_) => { __moodit_ns_write(&mut __w, \"0\"); __moodit_ns_write(&mut __w, \"\"); } }\n        }\n");
            }
        }

        // POO : type STUB (mêmes champs) + impl dont les méthodes envoient les valeurs des champs +
        // les args ; le child reconstruit __MooditStudent_Type { … } (même module → champs privés OK)
        // et appelle la méthode. Sémantique VALEUR (une méthode qui mute le récepteur ne persiste pas).
        for (var se : rstructs.entrySet()) {
            String sname = se.getKey();
            List<String[]> fields = se.getValue();
            if (fields.isEmpty() || !fields.stream().allMatch(f -> RUST_SCALARS.contains(f[1]))) continue;
            stubs.append("struct ").append(sname).append(" { ")
                    .append(fields.stream().map(f -> f[0] + ": " + f[1]).collect(Collectors.joining(", ")))
                    .append(" }\n");
            StringBuilder impl = new StringBuilder("impl ").append(sname).append(" {\n");
            boolean any = false;
            for (String[] m : rmethods) {
                if (!m[0].equals(sname)) continue;
                any = true;
                String mname = m[1];
                String rawParams = m[2];                 // inclut le récepteur (&self / &mut self / self)
                String ret = m[3];
                List<String[]> margs = rustParseParams(rawParams); // laisse tomber le récepteur
                boolean ok = (ret.isEmpty() || RUST_SCALARS.contains(ret))
                        && margs.stream().allMatch(p -> RUST_SCALARS.contains(p[1]));
                if (!ok) {
                    impl.append("    fn ").append(mname).append("(").append(rawParams).append(")")
                            .append(ret.isEmpty() ? "" : " -> " + ret).append(" { panic!(\"type non supporte\"); }\n");
                    continue;
                }
                String fieldFmts = fields.stream().map(f -> "format!(\"{}\", self." + f[0] + ")")
                        .collect(Collectors.joining(", "));
                String argFmts = margs.stream().map(p -> "format!(\"{}\", " + p[0] + ")")
                        .collect(Collectors.joining(", "));
                String allFmts = fieldFmts + (argFmts.isEmpty() ? "" : ", " + argFmts);
                String rpc = "__moodit_rpc(\"" + sname + "." + mname + "\", &[" + allFmts + "])";
                impl.append("    fn ").append(mname).append("(").append(rawParams).append(")")
                        .append(ret.isEmpty() ? "" : " -> " + ret).append(" { ")
                        .append(ret.isEmpty() ? rpc + ";" : rustDec(rpc, ret)).append(" }\n");
                int nf = fields.size();
                StringBuilder reads = new StringBuilder();
                for (int i = 0; i < nf + margs.size(); i++) {
                    reads.append("          let __s").append(i).append(" = __moodit_ns_read(&mut __r).unwrap_or_default();\n");
                }
                StringBuilder lit = new StringBuilder("__MooditStudent_").append(sname).append(" { ");
                for (int i = 0; i < nf; i++) {
                    if (i > 0) lit.append(", ");
                    lit.append(fields.get(i)[0]).append(": ").append(rustDec("__s" + i, fields.get(i)[1]));
                }
                lit.append(" }");
                StringBuilder mcall = new StringBuilder();
                for (int i = 0; i < margs.size(); i++) {
                    if (i > 0) mcall.append(", ");
                    mcall.append(rustDec("__s" + (nf + i), margs.get(i)[1]));
                }
                String recvDecl = rawParams.contains("&mut self") ? "let mut __moodit_recv = " : "let __moodit_recv = ";
                cases.append("        \"").append(sname).append(".").append(mname).append("\" => {\n").append(reads)
                        .append("          let __res = std::panic::catch_unwind(move || { ").append(recvDecl).append(lit).append("; ");
                if (ret.isEmpty()) {
                    cases.append("__moodit_recv.").append(mname).append("(").append(mcall).append("); });\n")
                            .append("          match __res { Ok(_) => { __moodit_ns_write(&mut __w, \"1\"); __moodit_ns_write(&mut __w, \"\"); }, Err(_) => { __moodit_ns_write(&mut __w, \"0\"); __moodit_ns_write(&mut __w, \"\"); } }\n        }\n");
                } else {
                    cases.append("__moodit_recv.").append(mname).append("(").append(mcall).append(") });\n")
                            .append("          match __res { Ok(__v) => { __moodit_ns_write(&mut __w, \"1\"); __moodit_ns_write(&mut __w, &format!(\"{}\", __v)); }, Err(_) => { __moodit_ns_write(&mut __w, \"0\"); __moodit_ns_write(&mut __w, \"\"); } }\n        }\n");
                }
            }
            impl.append("}\n");
            if (any) stubs.append(impl);
        }

        String program = "use std::io::{Read, Write, BufRead};\n\n"
                + code + "\n\n"
                + "thread_local! {\n"
                + "    static __MOODIT_CHILD: std::cell::RefCell<Option<(std::process::ChildStdin, std::process::ChildStdout)>> = std::cell::RefCell::new(None);\n"
                + "}\n"
                + "fn __moodit_ns_write<W: Write>(w: &mut W, s: &str) {\n"
                + "    let b = s.as_bytes();\n"
                + "    write!(w, \"{}:\", b.len()).unwrap();\n"
                + "    w.write_all(b).unwrap(); w.write_all(b\",\").unwrap(); w.flush().unwrap();\n"
                + "}\n"
                + "fn __moodit_ns_read<R: Read>(r: &mut R) -> Option<String> {\n"
                + "    let mut n: usize = 0; let mut any = false;\n"
                + "    loop {\n"
                + "        let mut one = [0u8; 1];\n"
                + "        if r.read(&mut one).ok()? == 0 { return None; }\n"
                + "        if one[0] == b':' { break; }\n"
                + "        n = n * 10 + (one[0] - b'0') as usize; any = true;\n"
                + "    }\n"
                + "    if !any { return None; }\n"
                + "    let mut buf = vec![0u8; n]; let mut off = 0;\n"
                + "    while off < n { let k = r.read(&mut buf[off..]).ok()?; if k == 0 { return None; } off += k; }\n"
                + "    let mut comma = [0u8; 1]; let _ = r.read(&mut comma);\n"
                + "    Some(String::from_utf8_lossy(&buf).into_owned())\n"
                + "}\n"
                + "fn __moodit_rpc(name: &str, args: &[String]) -> String {\n"
                + "    __MOODIT_CHILD.with(|c| {\n"
                + "        let mut b = c.borrow_mut();\n"
                + "        let (cin, cout) = b.as_mut().expect(\"child\");\n"
                + "        __moodit_ns_write(cin, name);\n"
                + "        for a in args { __moodit_ns_write(cin, a); }\n"
                + "        let st = __moodit_ns_read(cout).expect(\"st\");\n"
                + "        let rv = __moodit_ns_read(cout).expect(\"rv\");\n"
                + "        if st != \"1\" { panic!(\"appel etudiant en echec\"); }\n"
                + "        rv\n"
                + "    })\n"
                + "}\n"
                + stubs
                + "fn __moodit_harness() -> bool {\n"
                + harness
                + "\n}\n"
                + "fn __moodit_serve() {\n"
                + "    std::panic::set_hook(Box::new(|_| {}));\n"
                + "    let __stdin = std::io::stdin(); let mut __r = __stdin.lock();\n"
                + "    let __stdout = std::io::stdout(); let mut __w = __stdout.lock();\n"
                + "    loop {\n"
                + "        let __key = match __moodit_ns_read(&mut __r) { Some(k) => k, None => break };\n"
                + "        match __key.as_str() {\n"
                + cases
                + "        _ => { __moodit_ns_write(&mut __w, \"0\"); __moodit_ns_write(&mut __w, \"\"); }\n"
                + "        }\n"
                + "    }\n"
                + "}\n"
                + "fn main() {\n"
                + "    std::panic::set_hook(Box::new(|_| {}));\n"
                + "    let mut __args = std::env::args(); let _ = __args.next();\n"
                + "    if let Some(a) = __args.next() { if a == \"__moodit_student\" { __moodit_serve(); return; } }\n"
                + "    let mut __secret = String::new();\n"
                + "    std::io::stdin().lock().read_line(&mut __secret).ok();\n"
                + "    let __secret = __secret.trim().to_string();\n"
                + "    let __exe = std::env::current_exe().unwrap();\n"
                + "    let mut __child = std::process::Command::new(__exe).arg(\"__moodit_student\")\n"
                + "        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped())\n"
                + "        .spawn().unwrap();\n"
                + "    let __cin = __child.stdin.take().unwrap();\n"
                + "    let __cout = __child.stdout.take().unwrap();\n"
                + "    __MOODIT_CHILD.with(|c| *c.borrow_mut() = Some((__cin, __cout)));\n"
                + "    let __ok = std::panic::catch_unwind(|| __moodit_harness()).unwrap_or(false);\n"
                + "    if __ok { eprint!(\"{}\", __secret); }\n"
                + "    __MOODIT_CHILD.with(|c| { c.borrow_mut().take(); });\n"
                + "    std::process::exit(if __ok { 0 } else { 1 });\n"
                + "}\n";
        return new Assembled("rust", List.of(new PistonClient.File("main.rs", program)));
    }

    /** Paramètres Rust {@code "n: i32, s: String"} → couples {@code {nom, type}}. */
    private static List<String[]> rustParseParams(String params) {
        List<String[]> out = new ArrayList<>();
        String trimmed = params == null ? "" : params.trim();
        if (trimmed.isEmpty()) {
            return out;
        }
        for (String seg : trimmed.split(",")) {
            String s = seg.trim();
            if (s.isEmpty()) continue;
            int colon = s.indexOf(':');
            if (colon < 0) continue;
            String[] left = s.substring(0, colon).trim().split("\\s+");
            out.add(new String[] {left[left.length - 1], s.substring(colon + 1).trim()});
        }
        return out;
    }

    /** Expression Rust décodant une chaîne {@code s} du fil vers le type {@code type}. */
    private static String rustDec(String s, String type) {
        return "String".equals(type) ? s : s + ".parse::<" + type + ">().unwrap()";
    }

    // ── C ────────────────────────────────────────────────────────────────────────

    /** Fonction C/C++ de premier niveau (colonne 0) : {@code TYPE nom(params) {} }. */
    private static final Pattern C_FUNC =
            Pattern.compile("(?m)^([A-Za-z_][\\w \\*]*?[ \\*]+)(\\w+)\\s*\\(([^)]*)\\)\\s*\\{");
    /** Types scalaires marshalables C/C++ (numériques — pas de {@code char*} au pilote). */
    private static final Set<String> C_SCALARS = Set.of("int", "long", "double");
    /** Déclaration de classe C++ top-level : {@code class Nom { … } } (capture le nom). */
    private static final Pattern CPP_CLASS = Pattern.compile("(?m)^class\\s+(\\w+)\\s*\\{");
    /** Méthode C++ membre : {@code ret nom(params) } (dans la section publique). */
    private static final Pattern CPP_METHOD =
            Pattern.compile("([A-Za-z_][\\w]*)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:const\\s*)?\\{");

    /**
     * C : exécution ISOLÉE en DEUX processus (cf. #116). Le programme se {@code fork()} : le PARENT
     * (noteur) lit le nonce sur SON stdin APRÈS le fork (donc absent de la mémoire du child), exécute
     * le harnais INCHANGÉ et réémet le nonce en cas de succès ; le CHILD (qui ferme fd 0 avant tout
     * code étudiant) héberge le vrai code étudiant et répond par RPC (netstring sur des tubes dédiés).
     * Les symboles étudiant (défs + appels) sont renommés par macro ({@code #define nom __moodit_s_nom})
     * ; des STUBS de même nom délèguent au child. Les includes sont MINIMAUX et placés AVANT le code
     * étudiant (plus de {@code <string.h>} : un étudiant qui redéfinit {@code strlen} compile — cf.
     * revue). Périmètre : fonctions à paramètres/retour {@code int, long, double}.
     */
    private Assembled assembleC(String studentCode, String harnessCode, String nonce) {
        return assembleCLike(studentCode, harnessCode, false);
    }

    /**
     * Génère le programme C/C++ deux-processus (cf. {@link #assembleC}). {@code cpp=true} ajoute les
     * en-têtes C++ et enveloppe l'appel réel dans un {@code try/catch} (une exception = échec).
     */
    private Assembled assembleCLike(String studentCode, String harnessCode, boolean cpp) {
        String student = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;

        List<String[]> funcs = new ArrayList<>();
        Matcher fm = C_FUNC.matcher(student);
        while (fm.find()) {
            if (!"main".equals(fm.group(2))) {
                funcs.add(new String[] {fm.group(1).trim(), fm.group(2), fm.group(3)});
            }
        }
        StringBuilder defines = new StringBuilder();
        StringBuilder undefs = new StringBuilder();
        for (String[] f : funcs) {
            defines.append("#define ").append(f[1]).append(" __moodit_s_").append(f[1]).append("\n");
            undefs.append("#undef ").append(f[1]).append("\n");
        }
        defines.append("#define main __moodit_student_main\n");
        undefs.append("#undef main\n");

        StringBuilder stubs = new StringBuilder();
        StringBuilder cases = new StringBuilder();
        for (String[] f : funcs) {
            String ret = f[0];
            String name = f[1];
            List<String[]> params = cParseParams(f[2]);
            String sig = params.isEmpty() ? "void"
                    : params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
            boolean supported = ("void".equals(ret) || C_SCALARS.contains(ret))
                    && params.stream().allMatch(p -> C_SCALARS.contains(p[1]));
            if (!supported) {
                stubs.append(ret).append(" ").append(name).append("(").append(sig).append(") { _exit(1); }\n");
                continue;
            }
            // Stub (parent).
            stubs.append(ret).append(" ").append(name).append("(").append(sig).append(") {\n")
                    .append("  __ns_write_s(__moodit_wfd, \"").append(name).append("\");\n");
            for (String[] p : params) {
                stubs.append("  { char __b[64]; int __l = snprintf(__b, sizeof(__b), \"").append(cFmt(p[1]))
                        .append("\", ").append(p[0]).append("); __ns_write(__moodit_wfd, __b, __l); }\n");
            }
            stubs.append("  char __st[4]; long __sl = __ns_read(__moodit_rfd, __st, sizeof(__st));\n")
                    .append("  char __rv[128]; long __rl = __ns_read(__moodit_rfd, __rv, sizeof(__rv)); if (__rl < 0) _exit(1); __rv[__rl < 128 ? __rl : 127] = 0;\n")
                    .append("  if (!(__sl == 1 && __st[0] == '1')) _exit(1);\n");
            if (!"void".equals(ret)) {
                stubs.append("  return ").append(cDec("__rv", ret)).append(";\n");
            }
            stubs.append("}\n");
            // Dispatch (child).
            cases.append("    if (__keylen == ").append(name.length()).append(" && __eq(__key, \"")
                    .append(name).append("\", ").append(name.length()).append(")) {\n");
            StringBuilder callArgs = new StringBuilder();
            for (int i = 0; i < params.size(); i++) {
                cases.append("      char __s").append(i).append("[128]; long __l").append(i)
                        .append(" = __ns_read(__moodit_rfd, __s").append(i).append(", sizeof(__s").append(i)
                        .append(")); __s").append(i).append("[__l").append(i).append(" < 128 ? __l").append(i)
                        .append(" : 127] = 0;\n");
                if (i > 0) callArgs.append(", ");
                callArgs.append(cDec("__s" + i, params.get(i)[1]));
            }
            String realCall = "__moodit_s_" + name + "(" + callArgs + ")";
            if (cpp) {
                cases.append("      try {\n");
            }
            if ("void".equals(ret)) {
                cases.append("      ").append(realCall).append(";\n")
                        .append("      __ns_write_s(__moodit_wfd, \"1\"); __ns_write_s(__moodit_wfd, \"\");\n");
            } else {
                cases.append("      ").append(ret).append(" __r = ").append(realCall).append(";\n")
                        .append("      char __ob[64]; int __ol = snprintf(__ob, sizeof(__ob), \"").append(cFmt(ret))
                        .append("\", __r); __ns_write_s(__moodit_wfd, \"1\"); __ns_write(__moodit_wfd, __ob, __ol);\n");
            }
            if (cpp) {
                cases.append("      } catch (...) { __ns_write_s(__moodit_wfd, \"0\"); __ns_write_s(__moodit_wfd, \"\"); }\n");
            }
            cases.append("      continue;\n    }\n");
        }

        // POO C++ : les champs privés sont inaccessibles hors de la classe → modèle HANDLE (comme
        // Java/C#) en codegen. Chaque classe à section publique donne un type STUB (handle) dont le
        // ctor et les méthodes délèguent par RPC ; le child garde les vrais objets dans une table et
        // les instancie/appelle (cast). Périmètre : ctor + méthodes publiques à scalaires (int/long/double).
        if (cpp) {
            List<String> cppClasses = new ArrayList<>();
            Matcher cpm = CPP_CLASS.matcher(student);
            while (cpm.find()) {
                String cn = cpm.group(1);
                int open = student.indexOf('{', cpm.start());
                int close = javaMatchBrace(student, open);
                if (close < 0) continue;
                String body = student.substring(open + 1, close);
                int pub = body.indexOf("public:");
                if (pub < 0) continue;
                int after = pub + "public:".length();
                int end = body.length();
                for (String spec : new String[] {"private:", "protected:"}) {
                    int idx = body.indexOf(spec, after);
                    if (idx >= 0 && idx < end) end = idx;
                }
                cppClasses.add(cn);
                appendCppClassStub(cn, body.substring(after, end), stubs, cases);
            }
            // Renommer les classes étudiant → __MooditStudent_* (déf, ctor, littéraux) ; le stub garde le nom.
            for (String cn : cppClasses) {
                student = student.replaceAll("\\b" + Pattern.quote(cn) + "\\b", "__MooditStudent_" + cn);
            }
        }

        String includes = cpp
                ? "#include <cstdio>\n#include <cstdlib>\n#include <unistd.h>\n#include <sys/types.h>\n#include <vector>\n"
                : "#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <sys/types.h>\n";
        String harnessType = cpp ? "bool" : "int";
        String program = includes + "\n"
                + defines
                + student + "\n"
                + undefs + "\n"
                + (cpp ? "static std::vector<void*> __moodit_objs;\n" : "")
                + "static int __moodit_rfd, __moodit_wfd;\n"
                + "static void __w_all(int fd, const char* b, long n) { long o = 0; while (o < n) { long k = write(fd, b + o, n - o); if (k <= 0) _exit(1); o += k; } }\n"
                + "static int __rd1(int fd) { unsigned char c; long k = read(fd, &c, 1); if (k <= 0) return -1; return c; }\n"
                + "static void __ns_write(int fd, const char* s, long len) {\n"
                + "  char num[24]; int i = 0; long t = len; char tmp[24]; int j = 0;\n"
                + "  if (t == 0) tmp[j++] = '0'; while (t > 0) { tmp[j++] = '0' + (t % 10); t /= 10; }\n"
                + "  while (j > 0) num[i++] = tmp[--j]; num[i++] = ':';\n"
                + "  __w_all(fd, num, i); __w_all(fd, s, len); __w_all(fd, \",\", 1);\n"
                + "}\n"
                + "static void __ns_write_s(int fd, const char* s) { long n = 0; while (s[n]) n++; __ns_write(fd, s, n); }\n"
                + "static long __ns_read(int fd, char* buf, long cap) {\n"
                + "  long n = 0; int any = 0, c;\n"
                + "  while ((c = __rd1(fd)) != ':') { if (c < 0) return -1; n = n * 10 + (c - '0'); any = 1; }\n"
                + "  if (!any) return -1;\n"
                + "  long o = 0; while (o < n) { int d = __rd1(fd); if (d < 0) return -1; if (o < cap) buf[o] = (char)d; o++; }\n"
                + "  __rd1(fd);\n"
                + "  return n;\n"
                + "}\n"
                + "static int __eq(const char* a, const char* b, long n) { for (long i = 0; i < n; i++) if (a[i] != b[i]) return 0; return 1; }\n"
                + stubs
                + "static " + harnessType + " __moodit_harness(void) {\n"
                + harness
                + "\n}\n"
                + "static void __moodit_serve(void) {\n"
                + "  for (;;) {\n"
                + "    char __key[64]; long __keylen = __ns_read(__moodit_rfd, __key, sizeof(__key));\n"
                + "    if (__keylen < 0) return;\n"
                + cases
                + "    __ns_write_s(__moodit_wfd, \"0\"); __ns_write_s(__moodit_wfd, \"\");\n"
                + "  }\n"
                + "}\n"
                + "int main(void) {\n"
                + "  int toC[2], toP[2]; if (pipe(toC) || pipe(toP)) _exit(1);\n"
                + "  pid_t pid = fork(); if (pid < 0) _exit(1);\n"
                + "  if (pid == 0) {\n"
                + "    close(0);\n"
                + "    close(toC[1]); close(toP[0]);\n"
                + "    __moodit_rfd = toC[0]; __moodit_wfd = toP[1];\n"
                + "    __moodit_serve(); _exit(0);\n"
                + "  }\n"
                + "  close(toC[0]); close(toP[1]);\n"
                + "  __moodit_wfd = toC[1]; __moodit_rfd = toP[0];\n"
                + "  char __secret[128]; int __sn = 0, ch;\n"
                + "  while (__sn < 127 && (ch = __rd1(0)) >= 0 && ch != '\\n') __secret[__sn++] = (char)ch;\n"
                + "  __secret[__sn] = 0;\n"
                + "  int __ok = __moodit_harness() ? 1 : 0;\n"
                + "  if (__ok) __w_all(2, __secret, __sn);\n"
                + "  close(__moodit_wfd);\n"
                + "  _exit(__ok ? 0 : 1);\n"
                + "}\n";
        return new Assembled(cpp ? "c++" : "c",
                List.of(new PistonClient.File(cpp ? "main.cpp" : "main.c", program)));
    }

    /**
     * POO C++ (section publique d'une classe) : ajoute le type STUB (handle + ctor + méthodes qui
     * délèguent par RPC {@code @new}/{@code @call}) et les cas de dispatch du child (instanciation via
     * {@code new}, appel via cast du handle). Pilote : 1 constructeur, méthodes à scalaires.
     */
    private void appendCppClassStub(String cn, String pubBody, StringBuilder stubs, StringBuilder cases) {
        stubs.append("class ").append(cn).append(" {\npublic:\n  long __moodit_h;\n");
        // Un seul constructeur (le premier à paramètres scalaires).
        Matcher ctm = Pattern.compile("(?<![\\w:])" + Pattern.quote(cn) + "\\s*\\(([^)]*)\\)").matcher(pubBody);
        boolean ctorDone = false;
        while (!ctorDone && ctm.find()) {
            List<String[]> params = cParseParams(ctm.group(1));
            if (!params.stream().allMatch(p -> C_SCALARS.contains(p[1]))) continue;
            ctorDone = true;
            String sig = params.isEmpty() ? ""
                    : params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
            stubs.append("  ").append(cn).append("(").append(sig).append(") {\n")
                    .append("    __ns_write_s(__moodit_wfd, \"@new:").append(cn).append("\");\n");
            for (String[] p : params) {
                stubs.append("    { char __b[64]; int __l = snprintf(__b, sizeof(__b), \"").append(cFmt(p[1]))
                        .append("\", ").append(p[0]).append("); __ns_write(__moodit_wfd, __b, __l); }\n");
            }
            stubs.append("    char __st[4]; long __sl = __ns_read(__moodit_rfd, __st, sizeof(__st));\n")
                    .append("    char __rv[128]; long __rl = __ns_read(__moodit_rfd, __rv, sizeof(__rv)); if (__rl < 0) _exit(1); __rv[__rl < 128 ? __rl : 127] = 0;\n")
                    .append("    if (!(__sl == 1 && __st[0] == '1')) _exit(1);\n")
                    .append("    __moodit_h = strtol(__rv, 0, 10);\n  }\n");
            String key = "@new:" + cn;
            cases.append("    if (__keylen == ").append(key.length()).append(" && __eq(__key, \"").append(key)
                    .append("\", ").append(key.length()).append(")) {\n");
            StringBuilder callArgs = new StringBuilder();
            for (int i = 0; i < params.size(); i++) {
                cases.append("      char __s").append(i).append("[128]; long __l").append(i)
                        .append(" = __ns_read(__moodit_rfd, __s").append(i).append(", sizeof(__s").append(i)
                        .append(")); __s").append(i).append("[__l").append(i).append(" < 128 ? __l").append(i).append(" : 127] = 0;\n");
                if (i > 0) callArgs.append(", ");
                callArgs.append(cDec("__s" + i, params.get(i)[1]));
            }
            cases.append("      try {\n")
                    .append("        long __h = (long)__moodit_objs.size();\n")
                    .append("        __moodit_objs.push_back((void*) new __MooditStudent_").append(cn).append("(").append(callArgs).append("));\n")
                    .append("        char __ob[64]; int __ol = snprintf(__ob, sizeof(__ob), \"%ld\", __h); __ns_write_s(__moodit_wfd, \"1\"); __ns_write(__moodit_wfd, __ob, __ol);\n")
                    .append("      } catch (...) { __ns_write_s(__moodit_wfd, \"0\"); __ns_write_s(__moodit_wfd, \"\"); }\n")
                    .append("      continue;\n    }\n");
        }
        // Méthodes publiques (type de retour présent → ne matche pas un ctor).
        Matcher mm = CPP_METHOD.matcher(pubBody);
        while (mm.find()) {
            String ret = mm.group(1);
            String method = mm.group(2);
            if (method.equals(cn)) continue;
            List<String[]> params = cParseParams(mm.group(3));
            String sig = params.isEmpty() ? ""
                    : params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
            boolean ok = ("void".equals(ret) || C_SCALARS.contains(ret))
                    && params.stream().allMatch(p -> C_SCALARS.contains(p[1]));
            if (!ok) {
                stubs.append("  ").append(ret).append(" ").append(method).append("(").append(sig).append(") { _exit(1); }\n");
                continue;
            }
            stubs.append("  ").append(ret).append(" ").append(method).append("(").append(sig).append(") {\n")
                    .append("    __ns_write_s(__moodit_wfd, \"@call:").append(cn).append(":").append(method).append("\");\n")
                    .append("    { char __b[64]; int __l = snprintf(__b, sizeof(__b), \"%ld\", __moodit_h); __ns_write(__moodit_wfd, __b, __l); }\n");
            for (String[] p : params) {
                stubs.append("    { char __b[64]; int __l = snprintf(__b, sizeof(__b), \"").append(cFmt(p[1]))
                        .append("\", ").append(p[0]).append("); __ns_write(__moodit_wfd, __b, __l); }\n");
            }
            stubs.append("    char __st[4]; long __sl = __ns_read(__moodit_rfd, __st, sizeof(__st));\n")
                    .append("    char __rv[128]; long __rl = __ns_read(__moodit_rfd, __rv, sizeof(__rv)); if (__rl < 0) _exit(1); __rv[__rl < 128 ? __rl : 127] = 0;\n")
                    .append("    if (!(__sl == 1 && __st[0] == '1')) _exit(1);\n");
            if (!"void".equals(ret)) stubs.append("    return ").append(cDec("__rv", ret)).append(";\n");
            stubs.append("  }\n");
            String key = "@call:" + cn + ":" + method;
            cases.append("    if (__keylen == ").append(key.length()).append(" && __eq(__key, \"").append(key)
                    .append("\", ").append(key.length()).append(")) {\n")
                    .append("      char __sh[128]; long __lh = __ns_read(__moodit_rfd, __sh, sizeof(__sh)); __sh[__lh < 128 ? __lh : 127] = 0; long __h = strtol(__sh, 0, 10);\n");
            StringBuilder callArgs = new StringBuilder();
            for (int i = 0; i < params.size(); i++) {
                cases.append("      char __s").append(i).append("[128]; long __l").append(i)
                        .append(" = __ns_read(__moodit_rfd, __s").append(i).append(", sizeof(__s").append(i)
                        .append(")); __s").append(i).append("[__l").append(i).append(" < 128 ? __l").append(i).append(" : 127] = 0;\n");
                if (i > 0) callArgs.append(", ");
                callArgs.append(cDec("__s" + i, params.get(i)[1]));
            }
            String recv = "((__MooditStudent_" + cn + "*)__moodit_objs[__h])->" + method + "(" + callArgs + ")";
            cases.append("      try {\n");
            if ("void".equals(ret)) {
                cases.append("        ").append(recv).append(";\n")
                        .append("        __ns_write_s(__moodit_wfd, \"1\"); __ns_write_s(__moodit_wfd, \"\");\n");
            } else {
                cases.append("        ").append(ret).append(" __r = ").append(recv).append(";\n")
                        .append("        char __ob[64]; int __ol = snprintf(__ob, sizeof(__ob), \"").append(cFmt(ret))
                        .append("\", __r); __ns_write_s(__moodit_wfd, \"1\"); __ns_write(__moodit_wfd, __ob, __ol);\n");
            }
            cases.append("      } catch (...) { __ns_write_s(__moodit_wfd, \"0\"); __ns_write_s(__moodit_wfd, \"\"); }\n")
                    .append("      continue;\n    }\n");
        }
        stubs.append("};\n");
    }

    /** Paramètres C/C++ ({@code "int a, long b"} ; {@code void} = aucun) → couples {@code {nom, type}}. */
    private static List<String[]> cParseParams(String params) {
        List<String[]> out = new ArrayList<>();
        String trimmed = params == null ? "" : params.trim();
        if (trimmed.isEmpty() || "void".equals(trimmed)) {
            return out;
        }
        for (String seg : trimmed.split(",")) {
            String[] toks = seg.trim().split("\\s+");
            String name = toks[toks.length - 1].replace("*", "");
            String type = String.join(" ", java.util.Arrays.copyOf(toks, toks.length - 1));
            out.add(new String[] {name, type});
        }
        return out;
    }

    /** Spécificateur {@code printf} pour {@code snprintf} selon le type C. */
    private static String cFmt(String type) {
        return switch (type) {
            case "long" -> "%ld";
            case "double" -> "%.17g";
            default -> "%d";
        };
    }

    /** Expression C décodant une chaîne C {@code s} vers le type {@code type}. */
    private static String cDec(String s, String type) {
        return switch (type) {
            case "long" -> "strtol(" + s + ", 0, 10)";
            case "double" -> "strtod(" + s + ", 0)";
            default -> "(int)strtol(" + s + ", 0, 10)";
        };
    }

    // ── C++ ──────────────────────────────────────────────────────────────────────

    /**
     * C++ : même modèle deux-processus que le C (cf. {@link #assembleC}/{@link #assembleCLike}), avec
     * en-têtes C++ et appel réel enveloppé dans un {@code try/catch} (une exception = échec). Le harnais
     * renvoie un {@code bool}. Périmètre identique : fonctions à paramètres/retour {@code int, long, double}.
     */
    private Assembled assembleCpp(String studentCode, String harnessCode, String nonce) {
        return assembleCLike(studentCode, harnessCode, true);
    }

    // ── C# ───────────────────────────────────────────────────────────────────────

    /** Déclaration de classe C# top-level (capture le nom). */
    private static final Pattern CS_CLASS_DECL = Pattern.compile(
            "(?:public\\s+|internal\\s+|sealed\\s+|abstract\\s+|static\\s+|partial\\s+)*class\\s+(\\w+)[^{]*\\{");
    /** Méthode statique C# : {@code [vis] static RET nom(params) {} } (vis capturée). */
    private static final Pattern CS_STATIC_METHOD = Pattern.compile(
            "(public|private|protected|internal)?\\s*static\\s+([\\w\\[\\]<>]+)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{");
    /** N'importe quelle méthode C# : modifieurs + type de retour + nom + params (le `static` est filtré
     *  à l'exécution pour ne garder que les méthodes d'INSTANCE — POO). */
    private static final Pattern CS_METHOD_ANY = Pattern.compile(
            "((?:(?:public|private|protected|internal|static|sealed|virtual|override)\\s+)*)"
                    + "([\\w\\[\\]<>]+)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*\\{");
    /** Directive {@code using …;}, à hisser en tête (un using après une classe ne compile pas). */
    private static final Pattern CS_USING = Pattern.compile("(?m)^[ \\t]*using\\s+[^;]+;[ \\t]*\\n?");

    /**
     * C# : exécution ISOLÉE en DEUX processus (cf. #116, même modèle que {@link #assembleJava}). mono
     * compile en {@code .exe} à l'étape COMPILE ; notre {@code Main} RE-EXÉCUTE {@code mono <exe>
     * __moodit_student} (pas de recompilation → rapide) comme serveur étudiant. Le PARENT (noteur) lit
     * le nonce sur SON stdin, exécute le harnais INCHANGÉ et réémet le nonce en cas de succès ; le
     * CHILD héberge le vrai code étudiant et répond par RPC (netstring). Classes étudiant renommées
     * {@code __MooditStudent_*} + classes STUB de même nom. POO : les stubs ont aussi des CONSTRUCTEURS
     * et méthodes d'INSTANCE qui délèguent par handle ({@code @new}/{@code @call}), le child
     * instanciant/appelant par réflexion. Périmètre : paramètres/retours scalaires ({@code int, long,
     * double, bool, string}), méthodes {@code public}/{@code internal}.
     */
    private Assembled assembleCSharp(String studentCode, String harnessCode, String nonce) {
        String student = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;

        // Hisser les using étudiant (interdits après les classes).
        java.util.LinkedHashSet<String> usings = new java.util.LinkedHashSet<>(
                List.of("using System;", "using System.IO;", "using System.Diagnostics;"));
        Matcher um = CS_USING.matcher(student);
        while (um.find()) usings.add(um.group().strip());
        student = CS_USING.matcher(student).replaceAll("");
        // Neutraliser le Main étudiant (un seul point d'entrée : le nôtre).
        student = student.replaceAll("(static\\s+(?:void|int)\\s+)Main(\\s*\\()", "$1__moodit_student_main$2");

        StringBuilder stubs = new StringBuilder();
        StringBuilder cases = new StringBuilder();
        List<String> classNames = new ArrayList<>();
        Matcher cm = CS_CLASS_DECL.matcher(student);
        while (cm.find()) {
            String className = cm.group(1);
            classNames.add(className);
            int bodyOpen = student.indexOf('{', cm.start());
            int bodyClose = javaMatchBrace(student, bodyOpen);
            String body = student.substring(bodyOpen + 1, bodyClose);
            stubs.append("class ").append(className).append(" {\n");
            stubs.append("  int __moodit_h = -1;\n"); // handle de l'objet réel côté child (POO)
            Matcher mm = CS_STATIC_METHOD.matcher(body);
            while (mm.find()) {
                String vis = mm.group(1);
                String ret = mm.group(2);
                String method = mm.group(3);
                // Appelable par le harnais (autre classe) ⇒ public ou internal seulement.
                if ("__moodit_student_main".equals(method)
                        || !("public".equals(vis) || "internal".equals(vis))) continue;
                List<String[]> params = javaParseParams(mm.group(4));
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                String key = className + "." + method;
                boolean supported = ("void".equals(ret) || CS_SCALARS.contains(ret))
                        && params.stream().allMatch(p -> CS_SCALARS.contains(p[1]));
                if (!supported) {
                    stubs.append("  public static ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { throw new System.Exception(\"type non supporte\"); }\n");
                    continue;
                }
                String encArgs = params.stream().map(p -> csEnc(p[0], p[1])).collect(Collectors.joining(", "));
                String rpc = "__MooditMain.__rpc(\"" + key + "\", new string[]{" + encArgs + "})";
                if ("void".equals(ret)) {
                    stubs.append("  public static void ").append(method).append("(").append(sig).append(") { ")
                            .append(rpc).append("; }\n");
                } else {
                    stubs.append("  public static ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { return ").append(csDec(rpc, ret)).append("; }\n");
                }
                StringBuilder readRaw = new StringBuilder();
                StringBuilder callArgs = new StringBuilder();
                for (int i = 0; i < params.size(); i++) {
                    readRaw.append("      string __s").append(i).append(" = __MooditMain.__nsRead(__in);\n");
                    if (i > 0) callArgs.append(", ");
                    callArgs.append(csDec("__s" + i, params.get(i)[1]));
                }
                String realCall = "__MooditStudent_" + key + "(" + callArgs + ")";
                cases.append("    case \"").append(key).append("\": {\n").append(readRaw);
                if ("void".equals(ret)) {
                    cases.append("      try { ").append(realCall)
                            .append("; __MooditMain.__nsWrite(__out, \"1\"); __MooditMain.__nsWrite(__out, \"\"); }")
                            .append(" catch (System.Exception) { __MooditMain.__nsWrite(__out, \"0\"); __MooditMain.__nsWrite(__out, \"\"); }\n");
                } else {
                    cases.append("      try { ").append(ret).append(" __r = ").append(realCall)
                            .append("; __MooditMain.__nsWrite(__out, \"1\"); __MooditMain.__nsWrite(__out, ")
                            .append(csEnc("__r", ret)).append("); }")
                            .append(" catch (System.Exception) { __MooditMain.__nsWrite(__out, \"0\"); __MooditMain.__nsWrite(__out, \"\"); }\n");
                }
                cases.append("      break;\n    }\n");
            }
            // POO — constructeurs : délèguent "@new <Classe>" et mémorisent le handle du vrai objet.
            Pattern ctorP = Pattern.compile(
                    "(?:(?:public|private|protected|internal)\\s+)*" + Pattern.quote(className)
                            + "\\s*\\(([^)]*)\\)\\s*\\{");
            Matcher ctm = ctorP.matcher(body);
            while (ctm.find()) {
                List<String[]> params = javaParseParams(ctm.group(1));
                if (!params.stream().allMatch(p -> CS_SCALARS.contains(p[1]))) continue;
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                String encArgs = params.stream().map(p -> csEnc(p[0], p[1])).collect(Collectors.joining(", "));
                stubs.append("  public ").append(className).append("(").append(sig)
                        .append(") { __moodit_h = int.Parse(__MooditMain.__rpcNew(\"").append(className)
                        .append("\", new string[]{").append(encArgs).append("})); }\n");
            }
            // POO — méthodes d'INSTANCE : délèguent "@call <handle> <methode>".
            Matcher instM = CS_METHOD_ANY.matcher(body);
            while (instM.find()) {
                String mods = instM.group(1);
                if (mods.contains("static")) continue;
                if (!(mods.contains("public") || mods.contains("internal"))) continue;
                String ret = instM.group(2);
                String method = instM.group(3);
                if (method.equals(className)) continue; // garde-fou (ctor géré à part)
                List<String[]> params = javaParseParams(instM.group(4));
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                boolean supported = ("void".equals(ret) || CS_SCALARS.contains(ret))
                        && params.stream().allMatch(p -> CS_SCALARS.contains(p[1]));
                if (!supported) {
                    stubs.append("  public ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { throw new System.Exception(\"type non supporte\"); }\n");
                    continue;
                }
                String encArgs = params.stream().map(p -> csEnc(p[0], p[1])).collect(Collectors.joining(", "));
                String rpc = "__MooditMain.__rpcCall(__moodit_h, \"" + method + "\", new string[]{" + encArgs + "})";
                if ("void".equals(ret)) {
                    stubs.append("  public ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { ").append(rpc).append("; }\n");
                } else {
                    stubs.append("  public ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { return ").append(csDec(rpc, ret)).append("; }\n");
                }
            }
            stubs.append("}\n");
        }

        String renamed = student;
        for (String className : classNames) {
            renamed = renamed.replaceAll("\\b" + Pattern.quote(className) + "\\b", "__MooditStudent_" + className);
        }

        String program = String.join("\n", usings) + "\n"
                + "public class __MooditMain {\n"
                + "  static Stream __rpcOut; static Stream __rpcIn;\n"
                + "  public static void __nsWrite(Stream o, string s) {\n"
                + "    byte[] b = System.Text.Encoding.UTF8.GetBytes(s);\n"
                + "    byte[] h = System.Text.Encoding.ASCII.GetBytes(b.Length + \":\");\n"
                + "    o.Write(h,0,h.Length); o.Write(b,0,b.Length); o.WriteByte((byte)','); o.Flush();\n"
                + "  }\n"
                + "  public static string __nsRead(Stream ins) {\n"
                + "    int n = 0, c; bool any = false;\n"
                + "    while ((c = ins.ReadByte()) != ':') { if (c < 0) throw new EndOfStreamException(); n = n*10 + (c - '0'); any = true; }\n"
                + "    if (!any) throw new IOException(\"ns\");\n"
                + "    byte[] b = new byte[n]; int off = 0; while (off < n) { int k = ins.Read(b, off, n - off); if (k <= 0) throw new EndOfStreamException(); off += k; }\n"
                + "    ins.ReadByte();\n"
                + "    return System.Text.Encoding.UTF8.GetString(b);\n"
                + "  }\n"
                + "  public static string __rpc(string key, string[] args) {\n"
                + "    __nsWrite(__rpcOut, key);\n"
                + "    foreach (var a in args) __nsWrite(__rpcOut, a);\n"
                + "    string st = __nsRead(__rpcIn); string rv = __nsRead(__rpcIn);\n"
                + "    if (st != \"1\") throw new System.Exception(\"appel etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                // POO (grader → child) : construction et appel de méthode par handle.
                + "  public static string __rpcNew(string cls, string[] args) {\n"
                + "    __nsWrite(__rpcOut, \"@new\"); __nsWrite(__rpcOut, cls); __nsWrite(__rpcOut, args.Length.ToString());\n"
                + "    foreach (var a in args) __nsWrite(__rpcOut, a);\n"
                + "    string st = __nsRead(__rpcIn); string rv = __nsRead(__rpcIn);\n"
                + "    if (st != \"1\") throw new System.Exception(\"construction etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                + "  public static string __rpcCall(int h, string name, string[] args) {\n"
                + "    __nsWrite(__rpcOut, \"@call\"); __nsWrite(__rpcOut, h.ToString()); __nsWrite(__rpcOut, name); __nsWrite(__rpcOut, args.Length.ToString());\n"
                + "    foreach (var a in args) __nsWrite(__rpcOut, a);\n"
                + "    string st = __nsRead(__rpcIn); string rv = __nsRead(__rpcIn);\n"
                + "    if (st != \"1\") throw new System.Exception(\"appel methode etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                // POO (child) : table d'objets + instanciation/appel par réflexion (args coercés par type).
                + "  static System.Collections.Generic.List<object> __moodit_objs = new System.Collections.Generic.List<object>();\n"
                + "  static object __moodit_coerce(System.Type t, string s) { return System.Convert.ChangeType(s, t, System.Globalization.CultureInfo.InvariantCulture); }\n"
                + "  static string __moodit_fmt(object o) { if (o == null) return \"\"; if (o is double) return ((double)o).ToString(System.Globalization.CultureInfo.InvariantCulture); if (o is float) return ((float)o).ToString(System.Globalization.CultureInfo.InvariantCulture); return o.ToString(); }\n"
                + "  static int __moodit_newObj(string cls, string[] a) {\n"
                + "    var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;\n"
                + "    System.Type k = System.Type.GetType(\"__MooditStudent_\" + cls);\n"
                + "    foreach (var c in k.GetConstructors(flags)) if (c.GetParameters().Length == a.Length) {\n"
                + "      var pt = c.GetParameters(); object[] o = new object[a.Length];\n"
                + "      for (int i=0;i<a.Length;i++) o[i]=__moodit_coerce(pt[i].ParameterType, a[i]);\n"
                + "      __moodit_objs.Add(c.Invoke(o)); return __moodit_objs.Count-1;\n"
                + "    }\n"
                + "    throw new System.Exception(\"ctor\");\n"
                + "  }\n"
                + "  static object __moodit_callObj(int h, string name, string[] a) {\n"
                + "    var flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;\n"
                + "    object obj = __moodit_objs[h];\n"
                + "    foreach (var m in obj.GetType().GetMethods(flags)) if (m.Name == name && m.GetParameters().Length == a.Length) {\n"
                + "      var pt = m.GetParameters(); object[] o = new object[a.Length];\n"
                + "      for (int i=0;i<a.Length;i++) o[i]=__moodit_coerce(pt[i].ParameterType, a[i]);\n"
                + "      return m.Invoke(obj, o);\n"
                + "    }\n"
                + "    throw new System.Exception(\"method\");\n"
                + "  }\n"
                + "  static bool __moodit_harness() {\n"
                + harness
                + "\n  }\n"
                + "  static void __serve() {\n"
                + "    Stream __in = Console.OpenStandardInput(); Stream __out = Console.OpenStandardOutput();\n"
                + "    Console.SetOut(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });\n"
                + "    while (true) {\n"
                + "      string __key;\n"
                + "      try { __key = __nsRead(__in); } catch (System.Exception) { break; }\n"
                + "      switch (__key) {\n"
                + cases
                + "      case \"@new\": {\n"
                + "        string __cls = __nsRead(__in); int __ac = int.Parse(__nsRead(__in));\n"
                + "        string[] __a = new string[__ac]; for (int __i=0;__i<__ac;__i++) __a[__i]=__nsRead(__in);\n"
                + "        try { int __h = __moodit_newObj(__cls, __a); __nsWrite(__out, \"1\"); __nsWrite(__out, __h.ToString()); }\n"
                + "        catch (System.Exception) { __nsWrite(__out, \"0\"); __nsWrite(__out, \"\"); }\n"
                + "        break;\n      }\n"
                + "      case \"@call\": {\n"
                + "        int __h = int.Parse(__nsRead(__in)); string __m = __nsRead(__in); int __ac = int.Parse(__nsRead(__in));\n"
                + "        string[] __a = new string[__ac]; for (int __i=0;__i<__ac;__i++) __a[__i]=__nsRead(__in);\n"
                + "        try { object __r = __moodit_callObj(__h, __m, __a); __nsWrite(__out, \"1\"); __nsWrite(__out, __moodit_fmt(__r)); }\n"
                + "        catch (System.Exception) { __nsWrite(__out, \"0\"); __nsWrite(__out, \"\"); }\n"
                + "        break;\n      }\n"
                + "      default: __nsWrite(__out, \"0\"); __nsWrite(__out, \"\"); break;\n"
                + "      }\n"
                + "    }\n"
                + "  }\n"
                + "  public static void Main(string[] __args) {\n"
                + "    if (__args.Length > 0 && __args[0] == \"__moodit_student\") { __serve(); return; }\n"
                + "    string __secret = Console.In.ReadLine(); __secret = __secret == null ? \"\" : __secret.Trim();\n"
                + "    string __exe = System.Reflection.Assembly.GetEntryAssembly().Location;\n"
                + "    var __psi = new ProcessStartInfo(\"mono\", \"\\\"\" + __exe + \"\\\" __moodit_student\");\n"
                + "    __psi.RedirectStandardInput = true; __psi.RedirectStandardOutput = true; __psi.UseShellExecute = false;\n"
                + "    var __child = Process.Start(__psi);\n"
                + "    __rpcOut = __child.StandardInput.BaseStream; __rpcIn = __child.StandardOutput.BaseStream;\n"
                + "    bool __ok = false;\n"
                + "    try { __ok = __moodit_harness(); } catch (System.Exception) {}\n"
                + "    if (__ok) Console.Error.Write(__secret);\n"
                + "    try { __rpcOut.Close(); } catch (System.Exception) {}\n"
                + "    Environment.Exit(__ok ? 0 : 1);\n"
                + "  }\n"
                + "}\n\n"
                + stubs + "\n"
                + renamed + "\n";
        return new Assembled("csharp", List.of(new PistonClient.File("main.cs", program)));
    }

    /** Types scalaires marshalables C#. */
    private static final Set<String> CS_SCALARS = Set.of("int", "long", "double", "bool", "string");

    /** Expression C# encodant {@code var} (type {@code type}) en chaîne pour le fil netstring. */
    private static String csEnc(String var, String type) {
        if ("string".equals(type)) return var;
        if ("double".equals(type)) return var + ".ToString(System.Globalization.CultureInfo.InvariantCulture)";
        return var + ".ToString()";
    }

    /** Expression C# décodant une chaîne {@code s} du fil vers le type {@code type}. */
    private static String csDec(String s, String type) {
        return switch (type) {
            case "int" -> "int.Parse(" + s + ")";
            case "long" -> "long.Parse(" + s + ")";
            case "double" -> "double.Parse(" + s + ", System.Globalization.CultureInfo.InvariantCulture)";
            case "bool" -> "bool.Parse(" + s + ")";
            default -> s;
        };
    }

    // ── Java ─────────────────────────────────────────────────────────────────────

    /** Déclaration de classe top-level (capture le nom). */
    private static final Pattern JAVA_CLASS_DECL =
            Pattern.compile("(?:public\\s+|final\\s+|abstract\\s+)*class\\s+(\\w+)[^{]*\\{");
    /** Méthode statique : {@code [vis] static RET nom(params) [throws …] {} } (vis capturée). */
    private static final Pattern JAVA_STATIC_METHOD = Pattern.compile(
            "(public|private|protected)?\\s*static\\s+([\\w\\[\\]<>]+)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:throws[^{]*)?\\{");
    /** Directive d'import, à hisser en tête (un import après une classe ne compile pas). */
    private static final Pattern JAVA_IMPORT = Pattern.compile("(?m)^[ \\t]*import\\s+[^;]+;[ \\t]*\\n?");
    /** Types scalaires marshalables (périmètre pilote Java/C#). */
    private static final Set<String> JAVA_SCALARS = Set.of("int", "long", "double", "boolean", "String");
    /** N'importe quelle méthode : modifieurs + type de retour + nom + params (le `static` est filtré
     *  à l'exécution pour ne garder que les méthodes d'INSTANCE — POO). */
    private static final Pattern JAVA_METHOD_ANY = Pattern.compile(
            "((?:(?:public|private|protected|static|final|abstract)\\s+)*)([\\w\\[\\]<>]+)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:throws[^{]*)?\\{");

    /**
     * Java : exécution ISOLÉE en DEUX processus (cf. #116). Piston lance {@code java <src>} en mode
     * fichier-source ; notre {@code main} RE-EXÉCUTE un 2e JVM ({@code java <src> __moodit_student})
     * pour obtenir le serveur étudiant. Le PARENT (noteur) lit le nonce sur SON stdin, exécute le
     * harnais INCHANGÉ et réémet le nonce en cas de succès ; le CHILD héberge le vrai code étudiant et
     * répond par RPC (protocole netstring sur stdin/stdout). Le child ne voit jamais le nonce (mémoire
     * du parent). Les classes étudiant sont renommées {@code __MooditStudent_*} et remplacées par des
     * classes STUB de même nom dont les méthodes statiques délèguent au child — le harnais
     * {@code Classe.methode(...)} compile donc sans le vrai code. POO : les stubs ont aussi des
     * CONSTRUCTEURS et méthodes d'INSTANCE qui délèguent par handle ({@code @new}/{@code @call}),
     * le child instanciant/appelant par réflexion dans une table d'objets. Périmètre : paramètres et
     * retours scalaires ({@code int, long, double, boolean, String}).
     */
    private Assembled assembleJava(String studentCode, String harnessCode, String nonce) {
        String student = studentCode == null ? "" : studentCode;
        String harness = harnessCode == null ? "" : harnessCode;

        // Hisser les imports étudiant en tête (un import placé après une classe ne compile pas).
        StringBuilder imports = new StringBuilder("import java.io.*;\n");
        Matcher im = JAVA_IMPORT.matcher(student);
        while (im.find()) {
            String stmt = im.group().strip();
            if (!"import java.io.*;".equals(stmt)) imports.append(stmt).append("\n");
        }
        student = JAVA_IMPORT.matcher(student).replaceAll("");

        // 1) Classes étudiant + leurs méthodes statiques (dispatch par clé "Classe.methode").
        StringBuilder stubs = new StringBuilder();
        StringBuilder cases = new StringBuilder();
        Matcher cm = JAVA_CLASS_DECL.matcher(student);
        List<String> classNames = new ArrayList<>();
        while (cm.find()) {
            String className = cm.group(1);
            classNames.add(className);
            int bodyOpen = student.indexOf('{', cm.start());
            int bodyClose = javaMatchBrace(student, bodyOpen);
            String body = student.substring(bodyOpen + 1, bodyClose);
            stubs.append("class ").append(className).append(" {\n");
            stubs.append("  int __moodit_h = -1;\n"); // handle de l'objet réel côté child (POO)
            Matcher mm = JAVA_STATIC_METHOD.matcher(body);
            while (mm.find()) {
                String vis = mm.group(1);
                String ret = mm.group(2);
                String method = mm.group(3);
                // Seules les méthodes appelables par le harnais (autre classe, même paquet) sont
                // exposées : public ou package-private. Les private/protected restent internes au réel.
                if ("main".equals(method) || "private".equals(vis) || "protected".equals(vis)) continue;
                List<String[]> params = javaParseParams(mm.group(4));
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                String key = className + "." + method;
                boolean supported = ("void".equals(ret) || JAVA_SCALARS.contains(ret))
                        && params.stream().allMatch(p -> JAVA_SCALARS.contains(p[1]));
                if (!supported) {
                    stubs.append("  static ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { throw new RuntimeException(\"type non supporte par l'isolation RPC\"); }\n");
                    continue;
                }
                String encArgs = params.stream().map(p -> javaEnc(p[0], p[1])).collect(Collectors.joining(", "));
                String rpc = "__MooditMain.__rpc(\"" + key + "\", new String[]{" + encArgs + "})";
                if ("void".equals(ret)) {
                    stubs.append("  static void ").append(method).append("(").append(sig).append(") { ")
                            .append(rpc).append("; }\n");
                } else {
                    stubs.append("  static ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { return ").append(javaDec(rpc, ret)).append("; }\n");
                }
                // Child : lire N args bruts (jamais d'échec de lecture), puis décoder + appeler dans un try.
                StringBuilder readRaw = new StringBuilder();
                StringBuilder callArgs = new StringBuilder();
                for (int i = 0; i < params.size(); i++) {
                    readRaw.append("      String __s").append(i).append(" = __MooditMain.__nsRead(__in);\n");
                    if (i > 0) callArgs.append(", ");
                    callArgs.append(javaDec("__s" + i, params.get(i)[1]));
                }
                String realCall = "__MooditStudent_" + key + "(" + callArgs + ")";
                cases.append("    case \"").append(key).append("\": {\n").append(readRaw);
                if ("void".equals(ret)) {
                    cases.append("      try { ").append(realCall)
                            .append("; __MooditMain.__nsWrite(__out, \"1\"); __MooditMain.__nsWrite(__out, \"\"); }")
                            .append(" catch (Throwable __t) { __MooditMain.__nsWrite(__out, \"0\"); __MooditMain.__nsWrite(__out, \"\"); }\n");
                } else {
                    cases.append("      try { ").append(ret).append(" __r = ").append(realCall)
                            .append("; __MooditMain.__nsWrite(__out, \"1\"); __MooditMain.__nsWrite(__out, ")
                            .append(javaEnc("__r", ret)).append("); }")
                            .append(" catch (Throwable __t) { __MooditMain.__nsWrite(__out, \"0\"); __MooditMain.__nsWrite(__out, \"\"); }\n");
                }
                cases.append("      break;\n    }\n");
            }
            // POO — constructeurs : délèguent "@new <Classe>" et mémorisent le handle du vrai objet.
            Pattern ctorP = Pattern.compile(
                    "(?:(?:public|private|protected)\\s+)*" + Pattern.quote(className)
                            + "\\s*\\(([^)]*)\\)\\s*(?:throws[^{]*)?\\{");
            Matcher ctm = ctorP.matcher(body);
            while (ctm.find()) {
                List<String[]> params = javaParseParams(ctm.group(1));
                if (!params.stream().allMatch(p -> JAVA_SCALARS.contains(p[1]))) continue;
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                String encArgs = params.stream().map(p -> javaEnc(p[0], p[1])).collect(Collectors.joining(", "));
                stubs.append("  ").append(className).append("(").append(sig)
                        .append(") { __moodit_h = Integer.parseInt(__MooditMain.__rpcNew(\"").append(className)
                        .append("\", new String[]{").append(encArgs).append("})); }\n");
            }
            // POO — méthodes d'INSTANCE : délèguent "@call <handle> <methode>".
            Matcher instM = JAVA_METHOD_ANY.matcher(body);
            while (instM.find()) {
                String mods = instM.group(1);
                if (mods.contains("static") || mods.contains("private") || mods.contains("protected")) continue;
                String ret = instM.group(2);
                String method = instM.group(3);
                if (method.equals(className)) continue; // garde-fou (un ctor ne matche pas : pas de type de retour)
                List<String[]> params = javaParseParams(instM.group(4));
                String sig = params.stream().map(p -> p[1] + " " + p[0]).collect(Collectors.joining(", "));
                boolean supported = ("void".equals(ret) || JAVA_SCALARS.contains(ret))
                        && params.stream().allMatch(p -> JAVA_SCALARS.contains(p[1]));
                if (!supported) {
                    stubs.append("  ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { throw new RuntimeException(\"type non supporte par l'isolation RPC\"); }\n");
                    continue;
                }
                String encArgs = params.stream().map(p -> javaEnc(p[0], p[1])).collect(Collectors.joining(", "));
                String rpc = "__MooditMain.__rpcCall(__moodit_h, \"" + method + "\", new String[]{" + encArgs + "})";
                if ("void".equals(ret)) {
                    stubs.append("  ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { ").append(rpc).append("; }\n");
                } else {
                    stubs.append("  ").append(ret).append(" ").append(method).append("(").append(sig)
                            .append(") { return ").append(javaDec(rpc, ret)).append("; }\n");
                }
            }
            stubs.append("}\n");
        }

        // 2) Renommer les classes étudiant partout → __MooditStudent_* (le dispatch appelle le réel,
        //    les stubs gardent les noms d'origine pour le harnais).
        String renamed = student;
        for (String className : classNames) {
            renamed = renamed.replaceAll("\\b" + Pattern.quote(className) + "\\b", "__MooditStudent_" + className);
        }

        String program = imports.toString()
                + "public class __MooditMain {\n"
                + "  static OutputStream __rpcOut; static InputStream __rpcIn;\n"
                + "  static void __nsWrite(OutputStream o, String s) { try {\n"
                + "    byte[] b = s.getBytes(\"UTF-8\"); o.write((b.length + \":\").getBytes(\"UTF-8\")); o.write(b); o.write(','); o.flush();\n"
                + "  } catch (IOException e) { throw new RuntimeException(e); } }\n"
                + "  static String __nsRead(InputStream in) { try {\n"
                + "    int n = 0, c; boolean any = false;\n"
                + "    while ((c = in.read()) != ':') { if (c < 0) throw new EOFException(); n = n*10 + (c - '0'); any = true; }\n"
                + "    if (!any) throw new IOException(\"netstring\");\n"
                + "    byte[] b = new byte[n]; int off = 0; while (off < n) { int k = in.read(b, off, n - off); if (k < 0) throw new EOFException(); off += k; }\n"
                + "    in.read();\n"
                + "    return new String(b, \"UTF-8\");\n"
                + "  } catch (IOException e) { throw new RuntimeException(e); } }\n"
                + "  static String __rpc(String key, String[] args) {\n"
                + "    __nsWrite(__rpcOut, key);\n"
                + "    for (String a : args) __nsWrite(__rpcOut, a);\n"
                + "    String st = __nsRead(__rpcIn); String rv = __nsRead(__rpcIn);\n"
                + "    if (!st.equals(\"1\")) throw new RuntimeException(\"appel etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                // POO (grader → child) : construction et appel de méthode par handle.
                + "  static String __rpcNew(String cls, String[] args) {\n"
                + "    __nsWrite(__rpcOut, \"@new\"); __nsWrite(__rpcOut, cls); __nsWrite(__rpcOut, String.valueOf(args.length));\n"
                + "    for (String a : args) __nsWrite(__rpcOut, a);\n"
                + "    String st = __nsRead(__rpcIn); String rv = __nsRead(__rpcIn);\n"
                + "    if (!st.equals(\"1\")) throw new RuntimeException(\"construction etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                + "  static String __rpcCall(int h, String name, String[] args) {\n"
                + "    __nsWrite(__rpcOut, \"@call\"); __nsWrite(__rpcOut, String.valueOf(h)); __nsWrite(__rpcOut, name); __nsWrite(__rpcOut, String.valueOf(args.length));\n"
                + "    for (String a : args) __nsWrite(__rpcOut, a);\n"
                + "    String st = __nsRead(__rpcIn); String rv = __nsRead(__rpcIn);\n"
                + "    if (!st.equals(\"1\")) throw new RuntimeException(\"appel methode etudiant en echec\");\n"
                + "    return rv;\n"
                + "  }\n"
                // POO (child) : table d'objets + instanciation/appel par réflexion (args coercés par type).
                + "  static java.util.List<Object> __moodit_objs = new java.util.ArrayList<Object>();\n"
                + "  static Object __moodit_coerce(Class<?> t, String s) {\n"
                + "    if (t==int.class||t==Integer.class) return Integer.valueOf(Integer.parseInt(s));\n"
                + "    if (t==long.class||t==Long.class) return Long.valueOf(Long.parseLong(s));\n"
                + "    if (t==double.class||t==Double.class) return Double.valueOf(Double.parseDouble(s));\n"
                + "    if (t==boolean.class||t==Boolean.class) return Boolean.valueOf(Boolean.parseBoolean(s));\n"
                + "    return s;\n"
                + "  }\n"
                + "  static int __moodit_newObj(String cls, String[] a) throws Exception {\n"
                + "    Class<?> k = Class.forName(\"__MooditStudent_\" + cls);\n"
                + "    for (java.lang.reflect.Constructor<?> c : k.getDeclaredConstructors()) if (c.getParameterCount()==a.length) {\n"
                + "      c.setAccessible(true); Class<?>[] pt = c.getParameterTypes(); Object[] o = new Object[a.length];\n"
                + "      for (int i=0;i<a.length;i++) o[i]=__moodit_coerce(pt[i], a[i]);\n"
                + "      __moodit_objs.add(c.newInstance(o)); return __moodit_objs.size()-1;\n"
                + "    }\n"
                + "    throw new NoSuchMethodException(cls);\n"
                + "  }\n"
                + "  static Object __moodit_callObj(int h, String name, String[] a) throws Exception {\n"
                + "    Object obj = __moodit_objs.get(h);\n"
                + "    for (java.lang.reflect.Method m : obj.getClass().getDeclaredMethods()) if (m.getName().equals(name) && m.getParameterCount()==a.length) {\n"
                + "      m.setAccessible(true); Class<?>[] pt = m.getParameterTypes(); Object[] o = new Object[a.length];\n"
                + "      for (int i=0;i<a.length;i++) o[i]=__moodit_coerce(pt[i], a[i]);\n"
                + "      return m.invoke(obj, o);\n"
                + "    }\n"
                + "    throw new NoSuchMethodException(name);\n"
                + "  }\n"
                + "  static boolean __moodit_harness() {\n"
                + harness
                + "\n  }\n"
                + "  static void __serve() throws Exception {\n"
                + "    InputStream __in = new FileInputStream(FileDescriptor.in);\n"
                + "    OutputStream __out = new FileOutputStream(FileDescriptor.out);\n"
                + "    System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.err)));\n"
                + "    while (true) {\n"
                + "      String __key;\n"
                + "      try { __key = __nsRead(__in); } catch (RuntimeException e) { break; }\n"
                + "      switch (__key) {\n"
                + cases
                + "      case \"@new\": {\n"
                + "        String __cls = __nsRead(__in); int __ac = Integer.parseInt(__nsRead(__in));\n"
                + "        String[] __a = new String[__ac]; for (int __i=0;__i<__ac;__i++) __a[__i]=__nsRead(__in);\n"
                + "        try { int __h = __moodit_newObj(__cls, __a); __nsWrite(__out, \"1\"); __nsWrite(__out, String.valueOf(__h)); }\n"
                + "        catch (Throwable __t) { __nsWrite(__out, \"0\"); __nsWrite(__out, \"\"); }\n"
                + "        break;\n      }\n"
                + "      case \"@call\": {\n"
                + "        int __h = Integer.parseInt(__nsRead(__in)); String __m = __nsRead(__in); int __ac = Integer.parseInt(__nsRead(__in));\n"
                + "        String[] __a = new String[__ac]; for (int __i=0;__i<__ac;__i++) __a[__i]=__nsRead(__in);\n"
                + "        try { Object __r = __moodit_callObj(__h, __m, __a); __nsWrite(__out, \"1\"); __nsWrite(__out, __r==null?\"\":String.valueOf(__r)); }\n"
                + "        catch (Throwable __t) { __nsWrite(__out, \"0\"); __nsWrite(__out, \"\"); }\n"
                + "        break;\n      }\n"
                + "      default: __nsWrite(__out, \"0\"); __nsWrite(__out, \"\");\n"
                + "      }\n"
                + "    }\n"
                + "  }\n"
                + "  public static void main(String[] __args) throws Exception {\n"
                + "    if (__args.length > 0 && __args[0].equals(\"__moodit_student\")) { __serve(); return; }\n"
                + "    BufferedReader __sin = new BufferedReader(new InputStreamReader(System.in));\n"
                + "    String __secret = __sin.readLine(); __secret = __secret == null ? \"\" : __secret.trim();\n"
                + "    String __javaBin = System.getProperty(\"java.home\") + \"/bin/java\";\n"
                + "    File __dir = new File(System.getProperty(\"user.dir\")); String __src = null;\n"
                + "    for (File __f : __dir.listFiles()) if (__f.getName().endsWith(\".java\")) { __src = __f.getName(); break; }\n"
                + "    ProcessBuilder __pb = new ProcessBuilder(__javaBin, __src, \"__moodit_student\");\n"
                + "    __pb.redirectError(ProcessBuilder.Redirect.INHERIT);\n"
                + "    Process __child = __pb.start();\n"
                + "    __rpcOut = __child.getOutputStream(); __rpcIn = __child.getInputStream();\n"
                + "    boolean __ok = false;\n"
                + "    try { __ok = __moodit_harness(); } catch (Throwable __t) {}\n"
                + "    if (__ok) System.err.print(__secret);\n"
                + "    try { __rpcOut.close(); } catch (Exception e) {}\n"
                + "    System.exit(__ok ? 0 : 1);\n"
                + "  }\n"
                + "}\n\n"
                + stubs
                + "\n"
                + renamed
                + "\n";
        return new Assembled("java", List.of(new PistonClient.File("Main.java", program)));
    }

    /** Index du {@code '}'} fermant le bloc ouvert au {@code '{'} d'indice {@code open}. */
    private static int javaMatchBrace(String s, int open) {
        int depth = 0;
        for (int i = open; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{') depth++;
            else if (c == '}') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return s.length() - 1;
    }

    /** Paramètres Java {@code "int a, String s"} → couples {@code {nom, type}}. */
    private static List<String[]> javaParseParams(String params) {
        List<String[]> out = new ArrayList<>();
        String trimmed = params == null ? "" : params.trim();
        if (trimmed.isEmpty()) {
            return out;
        }
        for (String p : trimmed.split(",")) {
            String[] toks = p.trim().split("\\s+");
            String name = toks[toks.length - 1];
            String type = String.join(" ", java.util.Arrays.copyOf(toks, toks.length - 1));
            out.add(new String[] {name, type});
        }
        return out;
    }

    /** Expression Java encodant {@code var} (de type {@code type}) en chaîne pour le fil netstring. */
    private static String javaEnc(String var, String type) {
        return "String".equals(type) ? var : "String.valueOf(" + var + ")";
    }

    /** Expression Java décodant une chaîne {@code s} du fil netstring vers le type {@code type}. */
    private static String javaDec(String s, String type) {
        return switch (type) {
            case "int" -> "Integer.parseInt(" + s + ")";
            case "long" -> "Long.parseLong(" + s + ")";
            case "double" -> "Double.parseDouble(" + s + ")";
            case "boolean" -> "Boolean.parseBoolean(" + s + ")";
            default -> s;
        };
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
        // Exécution ISOLÉE en deux processus (comme les autres langages interprétés) : le NOTEUR
        // (main.js) exécute le harnais INCHANGÉ avec des proxys DOM ; le SERVEUR (jsx-server.js)
        // transpile + rend/monte le composant étudiant et détient le DOM. `html`, `mount`, `click`,
        // `fireEvent` et les nœuds DOM (querySelector, textContent…) sont proxifiés par RPC synchrone.
        // Le nonce est émis par le noteur (aucun code étudiant → infalsifiable) — plus de fichier nonce.
        String server = "const fs = require('fs');\n"
                + "const rt = require('./react-runtime.js');\n"
                + "const { React, ReactDOMServer, ReactDOMClient, act, HappyDOM, Babel } = rt;\n"
                + "const win = new HappyDOM.Window({ url: 'http://localhost/' });\n"
                + "global.window = win; global.document = win.document; global.navigator = win.navigator;\n"
                + "globalThis.IS_REACT_ACT_ENVIRONMENT = true;\n"
                + "['HTMLElement','Element','Node','Text','Event','MouseEvent','KeyboardEvent','InputEvent','CustomEvent','getComputedStyle','customElements','requestAnimationFrame','cancelAnimationFrame'].forEach(function(k){ if(win[k]!==undefined) global[k]=win[k]; });\n"
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
                + "    process.stdout.write(JSON.stringify(r)+NL);\n"
                + "  }});\n";
        String grader = "const cp=require('child_process'), fs=require('fs');\n"
                + "try{fs.unlinkSync('main.js');}catch(e){}\n"
                + "const NL=String.fromCharCode(10);\n"
                + "const child=cp.spawn(process.execPath,['jsx-server.js'],{stdio:['pipe','pipe','inherit']});\n"
                + "child.stdout.pause(); const outFd=child.stdout._handle.fd;\n"
                + "function rpc(o){ child.stdin.write(JSON.stringify(o)+NL); const b=Buffer.alloc(1<<20); let s='';\n"
                + "  while(s.indexOf(NL)<0){ let n; try{n=fs.readSync(outFd,b,0,b.length,null);}catch(e){if(e.code==='EAGAIN')continue;throw e;} if(n===0)break; s+=b.toString('utf8',0,n); }\n"
                + "  const r=JSON.parse(s.split(NL)[0]); if(!r.ok) throw new Error(r.error); return r; }\n"
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
                new PistonClient.File("main.js", grader),
                new PistonClient.File("jsx-server.js", server),
                new PistonClient.File("react-runtime.js", vendor("react-runtime.js")),
                new PistonClient.File("component.tsx", studentCode)));
    }
}
