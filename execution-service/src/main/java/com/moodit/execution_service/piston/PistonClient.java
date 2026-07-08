package com.moodit.execution_service.piston;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.util.List;
import java.util.Map;

/**
 * Client du sandbox Piston (API v2). Envoie un ensemble de fichiers dans un langage donné à
 * {@code POST /api/v2/execute} et récupère le résultat des étapes {@code compile}/{@code run}
 * (stdout, stderr, exit code). Piston isole l'exécution (pas de réseau, limites CPU/mémoire/temps).
 * On ne fait AUCUNE exécution locale : tout code non fiable passe par ici.
 */
@Component
public class PistonClient {

    private final RestClient restClient;
    private final String baseUrl;
    private final int runTimeoutMs;
    private final int compileTimeoutMs;

    public PistonClient(
            @Value("${app.piston.base-url:http://localhost:2000}") String baseUrl,
            @Value("${app.piston.run-timeout-ms:3000}") int runTimeoutMs,
            @Value("${app.piston.compile-timeout-ms:10000}") int compileTimeoutMs,
            @Value("${app.piston.http-timeout-ms:20000}") int httpTimeoutMs) {
        this.baseUrl = baseUrl;
        this.runTimeoutMs = runTimeoutMs;
        this.compileTimeoutMs = compileTimeoutMs;
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
        Map<String, Object> body = Map.of(
                "language", language,
                "version", version == null || version.isBlank() ? "*" : version,
                "files", files.stream().map(f -> Map.of("name", f.name(), "content", f.content())).toList(),
                "run_timeout", runTimeoutMs,
                "compile_timeout", compileTimeoutMs);
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
