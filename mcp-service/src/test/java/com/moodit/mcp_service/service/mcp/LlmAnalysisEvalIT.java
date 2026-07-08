package com.moodit.mcp_service.service.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.moodit.mcp_service.dto.McpAnalysis;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

/**
 * HARNAIS D'ÉVAL du prompt d'analyse (Phase 0 du tuning). Appelle le VRAI LLM sur un jeu de
 * fixtures représentatives, K fois chacune, et imprime un « scorecard » (score moyen ± écart-type,
 * dimensions, taux de strengths vides). Sert de base de mesure AVANT d'itérer le prompt : on ne
 * modifie le prompt qu'en comparant ce tableau.
 *
 * <p>Opt-in (tag « llm-eval ») : exclu du {@code test} normal. Lancer :
 * <pre>./gradlew llmEval</pre>
 *
 * <p>Prérequis : un Ollama joignable à {@code mcp.eval.baseUrl} (défaut
 * {@code http://localhost:11434/v1}). Le conteneur {@code moodit_ollama} n'expose PAS son port ;
 * pour l'éval, lancer un Ollama éphémère qui réutilise le volume du modèle déjà téléchargé :
 * <pre>
 * docker run --rm -d --name ollama-eval --gpus all -p 11434:11434 \
 *     -v moodit_ollama_data:/root/.ollama ollama/ollama
 * ./gradlew llmEval
 * docker rm -f ollama-eval
 * </pre>
 * Si l'endpoint est injoignable, l'éval est IGNORÉE (pas d'échec). Réglages :
 * {@code -Dmcp.eval.runs=5}, {@code -Dmcp.eval.model=...}, {@code -Dmcp.eval.baseUrl=...}.
 */
@Tag("llm-eval")
class LlmAnalysisEvalIT {

    private static final String BASE_URL =
            System.getProperty("mcp.eval.baseUrl", envOr("MCP_EVAL_BASE_URL", "http://localhost:11434/v1"));
    private static final String MODEL =
            System.getProperty("mcp.eval.model", envOr("MCP_EVAL_MODEL", "qwen2.5:7b-instruct"));
    private static final int RUNS = Integer.getInteger("mcp.eval.runs", 3);

    private static String envOr(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.isBlank() ? def : v;
    }

    /** Un cas d'éval : contexte + bande de score attendue + attente d'ancrage (strengths vide). */
    private record Fixture(
            String name, CourseAnalysisContext ctx, int minScore, int maxScore, boolean expectEmptyStrengths) {}

    @Test
    void evaluatePrompt() {
        assumeTrue(reachable(BASE_URL),
                "Ollama injoignable sur " + BASE_URL + " — éval ignorée (cf. Javadoc pour exposer le port).");

        var client = new OpenAiCompatibleMcpAnalysisClient(new ObjectMapper(), BASE_URL, "ollama", MODEL, 120_000);
        List<Fixture> fixtures = fixtures();

        System.out.printf("%n=== ÉVAL PROMPT — modèle=%s, runs=%d ===%n", MODEL, RUNS);
        System.out.printf("%-28s %4s  %-12s  %4s %4s %4s %4s  %7s  %-9s %s%n",
                "fixture", "n", "score(µ±σ)", "cont", "eng", "succ", "sent", "empty%", "bande", "ok?");

        double richMean = 0, mediumMean = 0, emptyMean = 0;

        for (Fixture f : fixtures) {
            List<Integer> scores = new ArrayList<>();
            double cont = 0, eng = 0, succ = 0, sent = 0;
            int emptyStrengths = 0, ok = 0, succN = 0, sentN = 0;

            for (int i = 0; i < RUNS; i++) {
                try {
                    McpAnalysis a = client.analyze(f.ctx());
                    scores.add(a.score());
                    cont += a.dimensions().content();
                    eng += a.dimensions().engagement();
                    Integer su = a.dimensions().success();   // null = N/D
                    Integer se = a.dimensions().sentiment();
                    if (su != null) { succ += su; succN++; }
                    if (se != null) { sent += se; sentN++; }
                    if (a.strengths().isEmpty()) emptyStrengths++;
                    ok++;
                } catch (RuntimeException e) {
                    System.out.printf("  ! run %d de %s a échoué : %s%n", i, f.name(), e.getMessage());
                }
            }
            if (ok == 0) {
                System.out.printf("%-28s  aucun run réussi%n", f.name());
                continue;
            }

            double mean = scores.stream().mapToInt(Integer::intValue).average().orElse(0);
            double std = Math.sqrt(scores.stream().mapToDouble(s -> (s - mean) * (s - mean)).sum() / ok);
            boolean inBand = mean >= f.minScore() && mean <= f.maxScore();
            String succStr = succN > 0 ? String.format(Locale.ROOT, "%4.0f", succ / succN) : " N/D";
            String sentStr = sentN > 0 ? String.format(Locale.ROOT, "%4.0f", sent / sentN) : " N/D";

            System.out.printf(Locale.ROOT,
                    "%-28s %4d  %5.1f±%-5.1f  %4.0f %4.0f %4s %4s  %6.0f%%  %3d-%-3d %s%n",
                    f.name(), ok, mean, std, cont / ok, eng / ok, succStr, sentStr,
                    100.0 * emptyStrengths / ok, f.minScore(), f.maxScore(), inBand ? "✓" : "✗");

            switch (f.name()) {
                case "riche (MCP100-like)" -> richMean = mean;
                case "moyen (MCP150-like)" -> mediumMean = mean;
                case "vide (MCP200-like)" -> emptyMean = mean;
                default -> { /* fixtures synthétiques : reportées, pas d'invariant dur */ }
            }
        }

        // Invariants DURS (stables malgré le non-déterminisme) — le reste est reporté, pas asserté.
        assertThat(emptyMean).as("cours vide < 50").isLessThan(50);
        assertThat(richMean).as("riche > moyen").isGreaterThan(mediumMean);
        assertThat(mediumMean).as("moyen > vide").isGreaterThan(emptyMean);
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static List<Fixture> fixtures() {
        List<String> positifs = List.of(
                "Cours super clair, les explications aident vraiment.",
                "Les quiz hebdomadaires sont parfaits pour réviser.",
                "Le forum est actif, on obtient de l'aide rapidement.",
                "Par contre les délais des travaux sont trop serrés.");
        List<String> mitiges = List.of(
                "Le cours est correct mais les explications manquent parfois de clarté.",
                "Les quiz aident à réviser, j'ai senti une progression.",
                "Le rythme est un peu rapide par moments.",
                "On manque d'exemples concrets sur certains sujets.");
        List<String> negatifs = List.of(
                "Les consignes sont confuses, je perds beaucoup de temps.",
                "Le rythme est intenable, impossible de suivre.",
                "Aucune rétroaction utile sur les exercices.",
                "Franchement déçu, le cours manque de structure.");

        return List.of(
                new Fixture("riche (MCP100-like)",
                        new CourseAnalysisContext(1, "Cours actif", "MCP100", 10, 22, 3,
                                positifs, 6, 3, 78, 67), 70, 100, false),
                new Fixture("moyen (MCP150-like)",
                        new CourseAnalysisContext(2, "Cours moyen", "MCP150", 6, 9, 3,
                                mitiges, 3, 3, null, 67), 50, 69, false),
                new Fixture("vide (MCP200-like)",
                        new CourseAnalysisContext(3, "Cours inactif", "MCP200", 0, 0, 0,
                                List.of(), 0, 0, null, null), 0, 49, true),
                // Synthétique : beaucoup d'activité MAIS ressenti négatif → le sentiment doit chuter.
                new Fixture("actif + ressenti négatif",
                        new CourseAnalysisContext(4, "Cours tendu", "SYN1", 8, 20, 15,
                                negatifs, 40, 15, 30, 45), 25, 65, false),
                // Synthétique : beaucoup de quiz, forum VIDE → contenu haut, ressenti non jugeable.
                new Fixture("quiz nombreux, forum vide",
                        new CourseAnalysisContext(5, "Cours silencieux", "SYN2", 12, 0, 10,
                                List.of(), 20, 8, 80, 75), 50, 85, false));
    }

    private static boolean reachable(String baseUrl) {
        try {
            URI u = URI.create(baseUrl);
            int port = u.getPort() == -1 ? 11434 : u.getPort();
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(u.getHost(), port), 1500);
                return true;
            }
        } catch (Exception e) {
            return false;
        }
    }
}
