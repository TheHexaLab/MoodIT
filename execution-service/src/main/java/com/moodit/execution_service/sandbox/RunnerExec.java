package com.moodit.execution_service.sandbox;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Exécution GÉNÉRIQUE d'un programme assemblé dans un conteneur runner (mode « exec » du
 * superviseur) — reprend le rôle de Piston (#116) : les langages interprétés/SQL/vues y font
 * tourner leurs programmes RPC 2-processus à nonce INCHANGÉS, et le bouton « Exécuter » de tous
 * les langages y passe aussi. Tout le job tourne sous l'UID étudiant (le noteur assemblé embarque
 * sa propre protection) ; une étape de compilation précède l'exécution pour les langages qui en
 * ont une. Résultat au FORMAT PISTON ({@code compile}/{@code run}, {@code signal} = "SIGKILL" en
 * cas de temps dépassé) : la logique de verdict d'ExecutionService est inchangée.
 *
 * Le PREMIER fichier de la liste est le point d'entrée (convention héritée de Piston, respectée
 * par CodeAssembler).
 */
@Component
public class RunnerExec {

    /** Fichier source envoyé au runner (le premier de la liste est exécuté). */
    public record File(String name, String content) {}

    /** Étape (compilation ou exécution) : sorties, code de sortie, signal (SIGKILL = temps dépassé). */
    /**
     * Une étape (compilation ou exécution). {@code message} est un canal de diagnostic
     * OPTIONNEL du contrat : le superviseur actuel ne l'alimente jamais (il met tout dans
     * {@code stderr}) — il n'est lu qu'en repli par {@code firstNonBlank}. À retirer si le
     * contrat se stabilise sans lui.
     */
    public record Stage(String stdout, String stderr, Integer code, String signal, String message) {}

    /** Résultat complet ; {@code compile} est null pour les langages sans compilation. */
    public record Result(Stage compile, Stage run, String message) {}

    /** Plafond du temps limite d'exécution par requête (aligné sur l'éditeur : max 60 s). */
    public static final int MAX_RUN_TIMEOUT_MS = 60_000;

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    /**
     * Démarrage du conteneur + compilation : doit COUVRIR le budget de compilation du superviseur
     * (EXEC_COMPILE_TIMEOUT_S = 60 s), sinon le mur tue le conteneur pendant une compilation
     * légitime (rustc, mcs…) et l'utilisateur reçoit un 502 au lieu d'une erreur claire.
     */
    private static final long WALL_OVERHEAD_MS = 75_000;
    private static final long DEFAULT_RUN_TIMEOUT_MS = 3_000;

    private final DockerSandbox sandbox;
    private final String imagePrefix;
    private final String imageTag;

    @Autowired
    public RunnerExec(DockerSandbox sandbox,
            @Value("${app.sandbox.image-prefix:moodit-runner-}") String imagePrefix,
            @Value("${app.sandbox.image-tag:latest}") String imageTag) {
        this.sandbox = sandbox;
        this.imagePrefix = imagePrefix;
        this.imageTag = imageTag;
    }

    public DockerSandbox sandbox() {
        return sandbox;
    }

    /** Image runner du runtime assemblé (noms produits par CodeAssembler). */
    public String imageFor(String runtime) {
        String name = switch (runtime == null ? "" : runtime.trim().toLowerCase(Locale.ROOT)) {
            case "python" -> "python";
            case "javascript", "typescript" -> "node";
            case "php" -> "php";
            case "bash" -> "bash";
            case "sqlite3" -> "sqlite";
            case "c", "c++" -> "c";
            case "java" -> "java";
            case "csharp" -> "csharp";
            case "go" -> "go";
            case "rust" -> "rust";
            default -> throw new UnsupportedLanguageException("Runtime inconnu du runner : " + runtime);
        };
        return imagePrefix + name + ":" + imageTag;
    }

    public Result execute(String runtime, List<File> files) {
        return execute(runtime, files, null, null);
    }

    /**
     * Exécute le programme assemblé ; {@code runTimeoutMsOverride} = temps limite du prof
     * ({@code null} → défaut 3 s, comme Piston), borné à {@link #MAX_RUN_TIMEOUT_MS} et ≥ 1 ms.
     */
    public Result execute(String runtime, List<File> files, String stdin, Integer runTimeoutMsOverride) {
        if (files == null || files.isEmpty()) {
            throw new SandboxException("Aucun fichier à exécuter");
        }
        long timeoutMs = runTimeoutMsOverride == null ? DEFAULT_RUN_TIMEOUT_MS
                : Math.max(1, Math.min(runTimeoutMsOverride, MAX_RUN_TIMEOUT_MS));

        Map<String, String> jobFiles = new LinkedHashMap<>();
        for (File file : files) {
            jobFiles.put("src/" + file.name(), file.content());
        }
        Map<String, Object> job = new LinkedHashMap<>();
        job.put("mode", "exec");
        job.put("runtime", runtime == null ? "" : runtime.trim().toLowerCase(Locale.ROOT));
        job.put("entry", files.get(0).name());
        job.put("timeout_ms", timeoutMs);
        if (stdin != null) {
            job.put("stdin", stdin);
        }
        jobFiles.put("job.json", MAPPER.writeValueAsString(job));

        DockerSandbox.ContainerRun run = sandbox.run(imageFor(runtime), jobFiles,
                WALL_OVERHEAD_MS + timeoutMs);
        return parse(run);
    }

    private static Result parse(DockerSandbox.ContainerRun run) {
        JsonNode root;
        try {
            root = MAPPER.readTree(run.stdout());
        } catch (RuntimeException e) {
            throw new SandboxException("Réponse du runner illisible (exit " + run.exitCode() + ")");
        }
        if (root.has("error")) {
            throw new SandboxException("Runner : " + root.get("error").asString());
        }
        return new Result(stage(root.path("compile")), stage(root.path("run")), null);
    }

    private static Stage stage(JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) {
            return null;
        }
        return new Stage(
                node.path("stdout").asString(""),
                node.path("stderr").asString(""),
                node.path("code").isNumber() ? node.path("code").asInt() : null,
                node.path("signal").isString() ? node.path("signal").asString() : null,
                null);
    }
}
