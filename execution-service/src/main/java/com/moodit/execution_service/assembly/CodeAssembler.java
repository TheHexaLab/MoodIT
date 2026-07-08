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
                + "    if ($r === null) continue;\n"
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
                + "  fwrite(STDOUT, json_encode($__moodit_r).\"\\n\");\n"
                + "}\n";
        return new Assembled("php", List.of(
                new PistonClient.File("grader.php", grader),
                new PistonClient.File("student_server.php", server)));
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
