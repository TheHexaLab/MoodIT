package com.moodit.execution_service.piston;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Client du sandbox Piston (API v2). Envoie un ensemble de fichiers dans un langage donné à
 * {@code POST /api/v2/execute} et récupère le résultat des étapes {@code compile}/{@code run}
 * (stdout, stderr, exit code). Piston isole l'exécution (pas de réseau, limites CPU/mémoire/temps :
 * temps ET mémoire sont envoyés explicitement à chaque appel).
 * On ne fait AUCUNE exécution locale : tout code non fiable passe par ici.
 */
@Component
public class PistonClient {

    /** Limite mémoire par défaut de l'étape run (octets, convention de Piston) : 256 Mo. */
    public static final long DEFAULT_RUN_MEMORY_LIMIT = 256_000_000L;
    /** Limite mémoire par défaut de l'étape compile (octets) : 512 Mo (rustc, javac, mono…). */
    public static final long DEFAULT_COMPILE_MEMORY_LIMIT = 512_000_000L;

    private final RestClient restClient;
    private final String baseUrl;
    private final int runTimeoutMs;
    private final int compileTimeoutMs;
    private final long runMemoryLimit;
    private final long compileMemoryLimit;

    /** Limites mémoire par défaut ({@link #DEFAULT_RUN_MEMORY_LIMIT}, {@link #DEFAULT_COMPILE_MEMORY_LIMIT}). */
    public PistonClient(String baseUrl, int runTimeoutMs, int compileTimeoutMs, int httpTimeoutMs) {
        this(baseUrl, runTimeoutMs, compileTimeoutMs, httpTimeoutMs,
                DEFAULT_RUN_MEMORY_LIMIT, DEFAULT_COMPILE_MEMORY_LIMIT);
    }

    /**
     * Les limites mémoire sont envoyées à CHAQUE exécution (#24) : sans elles, Piston n'en applique
     * aucune (défaut -1) et une boucle d'allocation consomme la mémoire du conteneur. Une valeur
     * ≤ 0 n'est pas envoyée (Piston applique alors sa propre configuration).
     */
    @Autowired
    public PistonClient(
            @Value("${app.piston.base-url:http://localhost:2000}") String baseUrl,
            @Value("${app.piston.run-timeout-ms:3000}") int runTimeoutMs,
            @Value("${app.piston.compile-timeout-ms:10000}") int compileTimeoutMs,
            @Value("${app.piston.http-timeout-ms:20000}") int httpTimeoutMs,
            @Value("${app.piston.run-memory-limit-bytes:256000000}") long runMemoryLimit,
            @Value("${app.piston.compile-memory-limit-bytes:512000000}") long compileMemoryLimit) {
        this.baseUrl = baseUrl;
        this.runTimeoutMs = runTimeoutMs;
        this.compileTimeoutMs = compileTimeoutMs;
        this.runMemoryLimit = runMemoryLimit;
        this.compileMemoryLimit = compileMemoryLimit;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(5000);
        factory.setReadTimeout(httpTimeoutMs);
        this.restClient = RestClient.builder().requestFactory(factory).build();
    }

    /** Un fichier soumis à Piston (nom + contenu). */
    public record File(String name, String content) {}

    /** Une étape d'exécution Piston (compile ou run). {@code code} = exit code (null si absent). */
    public record Stage(String stdout, String stderr, Integer code, String signal, String message) {}

    /** Résultat d'un execute : étape compile (optionnelle), étape run, et message d'erreur global. */
    public record Result(Stage compile, Stage run, String message) {}

    /**
     * Exécute {@code files} dans {@code language} (version SemVer ou « * » pour n'importe laquelle).
     * @throws PistonException si Piston est injoignable ou renvoie une erreur de requête.
     */
    public Result execute(String language, String version, List<File> files) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("language", language);
        body.put("version", version == null || version.isBlank() ? "*" : version);
        body.put("files", files.stream().map(f -> Map.of("name", f.name(), "content", f.content())).toList());
        body.put("run_timeout", runTimeoutMs);
        body.put("compile_timeout", compileTimeoutMs);
        if (runMemoryLimit > 0) {
            body.put("run_memory_limit", runMemoryLimit);
        }
        if (compileMemoryLimit > 0) {
            body.put("compile_memory_limit", compileMemoryLimit);
        }
        try {
            Result result = restClient.post()
                    .uri(baseUrl + "/api/v2/execute")
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .body(Result.class);
            if (result == null) {
                throw new PistonException("Réponse Piston vide");
            }
            // Erreur de requête Piston (langage inconnu, limites dépassées…) : pas d'étape run.
            if (result.run() == null && result.message() != null) {
                throw new PistonException("Piston: " + result.message());
            }
            return result;
        } catch (RestClientException e) {
            throw new PistonException("Appel Piston échoué : " + e.getMessage(), e);
        }
    }
}
