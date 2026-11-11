package com.moodit.core_service.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

import java.time.Duration;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Appelle le service d'EXÉCUTION (conteneurs runner Docker, #116) pour corriger une question Code. Endpoint
 * INTERNE (non exposé par le gateway), authentifié par un jeton partagé {@code X-Internal-Token}.
 * Renvoie le verdict {@code passed} ALIGNÉ sur l'ordre des harnais fournis ; {@code null} si le
 * service est injoignable (le job laisse alors la question « en cours »).
 */
@Component
public class ExecutionClient {

    private static final Logger log = LoggerFactory.getLogger(ExecutionClient.class);

    private final String baseUrl;
    private final String internalToken;
    private final long connectTimeoutMs;
    private final long baseReadTimeoutMs;
    private final long perTestReadTimeoutMs;
    private final long internalQueueWaitMs;
    private final long interpretedBudgetMs;

    /** Budget serveur par défaut (tests et appelants hérités) : 15 min, comme execution-service. */
    public ExecutionClient(String baseUrl, String internalToken, long connectTimeoutMs,
            long baseReadTimeoutMs, long perTestReadTimeoutMs, long internalQueueWaitMs) {
        this(baseUrl, internalToken, connectTimeoutMs, baseReadTimeoutMs, perTestReadTimeoutMs,
                internalQueueWaitMs, DEFAULT_EXEC_BUDGET_MS);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public ExecutionClient(
            @Value("${app.execution-service.internal-url:http://localhost:8084}") String baseUrl,
            @Value("${app.internal.token}") String internalToken,
            @Value("${app.execution-service.connect-timeout-ms:3000}") long connectTimeoutMs,
            @Value("${app.execution-service.read-timeout-ms:10000}") long baseReadTimeoutMs,
            @Value("${app.execution-service.per-test-timeout-ms:20000}") long perTestReadTimeoutMs,
            @Value("${app.execution-service.internal-queue-wait-ms:${EXEC_INTERNAL_QUEUE_WAIT_MS:120000}}") long internalQueueWaitMs,
            // MÊME variable d'environnement qu'execution-service (.env commun), comme
            // internal-queue-wait-ms ci-dessus : un miroir PLUS COURT que le budget réel du
            // serveur ferait abandonner une correction encore en cours (#216). Ce câblage
            // supprime la divergence par OUBLI, pas toute divergence possible : la poser dans
            // le bloc `environment:` d'un seul service, ou surcharger la propriété Spring d'un
            // seul côté, la rétablit. D'où l'avertissement dans .env.example et le compose.
            @Value("${app.execution-service.interpreted-budget-ms:${EXEC_INTERPRETED_BUDGET_MS:900000}}") long interpretedBudgetMs) {
        this.baseUrl = baseUrl;
        this.internalToken = internalToken;
        this.connectTimeoutMs = connectTimeoutMs;
        this.baseReadTimeoutMs = baseReadTimeoutMs;
        this.perTestReadTimeoutMs = perTestReadTimeoutMs;
        this.internalQueueWaitMs = internalQueueWaitMs;
        this.interpretedBudgetMs = interpretedBudgetMs;
    }

    /**
     * Délai d'attente de la réponse (#31, #216), modélisé sur le PIRE CAS réel du runner (#116) :
     * <ul>
     *   <li><b>Interprétés/SQL/vues</b> — une place et un conteneur PAR unité : chaque unité
     *       paie l'attente de file ({@code app.exec.internal-queue-wait-ms}, 120 s par défaut —
     *       seule variable encore PARTAGÉE avec execution-service via le {@code .env} commun,
     *       {@code EXEC_INTERNAL_QUEUE_WAIT_MS} : la surcharger d'un côté impose la même valeur
     *       de l'autre), plus {@code max(per-test-timeout-ms, temps limite + marge)}, plus le
     *       MUR du runner (75 s : démarrage du conteneur, compilation exec — tsc compris) ;</li>
     *   <li><b>Compilés</b> — UN conteneur pour tout le job : une seule attente de file, puis le
     *       miroir du mur de DockerEvaluator (30 s + (N+2) × (run planché VM + 10 s + 90 s de
     *       compilation par cas + 5 s d'inventaire {@code --list})).</li>
     * </ul>
     * Surestimer est sans danger (la correction tourne en tâche de fond) ; sous-estimer supprime
     * la tentative d'un étudiant pendant une correction encore en cours — le bug de #216.
     * {@code per-test-timeout-ms} est désormais un réglage de CORE seul (l'homologue serveur a
     * disparu avec Piston).
     */
    long readTimeoutMs(String language, int workUnits, Integer execTimeoutMs) {
        // Invariant anti-#216 : budget client ≥ PIRE CAS serveur, modélisé d'après le vrai
        // contrat du runner (#116) — surestimer est sans danger (correction asynchrone),
        // sous-estimer supprime la tentative d'un étudiant pendant une correction en cours.
        long run = execTimeoutMs == null ? DEFAULT_RUN_MS
                : Math.min(Math.max(execTimeoutMs, 1), 60_000);
        if (compiled(language)) {
            // UN conteneur pour tout le job (une seule attente de file, une seule place) :
            // miroir du mur de DockerEvaluator — 30 s de base + (N cas + 2 canaris) ×
            // (run planché VM + 10 s de marge + 90 s de compilation par cas + 5 s d'inventaire).
            // CHAQUE terme du perCase serveur doit avoir son miroir ici : il est multiplié par
            // le nombre de cas, donc en oublier un creuse un écart proportionnel.
            long cases = (Math.max(workUnits, 2) + 2L) / 2;   // unités 2N+2 → N+2
            long perRun = vmLanguage(language) ? Math.max(run, VM_FLOOR_MS) : run;
            // Plafonné par le MUR du serveur (DockerEvaluator.MAX_WALL_MS) : au-delà, le
            // conteneur est tué de toute façon. Sans ce miroir, 100 harnais donnaient un délai
            // de ~3 h pendant lesquelles un fil @Async serait resté épinglé si le démon se
            // bloquait sans fermer la socket.
            // Nombre de COMPILATIONS par cas : le chemin NON FALSIFIABLE (#116, harnais booléen)
            // compile le noteur ET le code soumis séparément, et trois fois en Java, où les
            // signatures sont lues sur les classes compilées. On prend ici le PIRE CAS sans
            // regarder la forme des harnais : surestimer fait attendre core un peu plus que le
            // serveur, sous-estimer le ferait renoncer AVANT lui et supprimer une tentative
            // encore en correction — le bug de #216. Le plafond EVAL_MAX_WALL_MS borne les deux.
            // Normalisé comme compiled()/vmLanguage()/sqlLanguage() : un nom stocké avec une
            // espace ou une casse inhabituelle restait reconnu comme compilé mais retombait à 2
            // compilations, donc à un miroir plus court que le mur — la régression #216.
            long compiles = "java".equals(language == null ? ""
                    : language.trim().toLowerCase(java.util.Locale.ROOT)) ? 3 : 2;
            long serverWall = Math.min(EVAL_BASE_MS + cases * (perRun + EVAL_CASE_MARGIN_MS
                    + compiles * COMPILE_SLACK_MS + LIST_SLACK_MS), EVAL_MAX_WALL_MS);
            return baseReadTimeoutMs + internalQueueWaitMs + serverWall + RUN_MARGIN_MS
                    + CONTAINER_LIFECYCLE_MS;
        }
        // Interprétés/SQL/vues : UNE place et UN conteneur PAR UNITÉ — chaque unité paie
        // l'attente de file et le mur du runner (75 s, miroir de WALL_OVERHEAD_MS : démarrage
        // du conteneur et compilation exec, tsc compris) en plus de son temps limite.
        long perUnit = Math.max(perTestReadTimeoutMs, run + RUN_MARGIN_MS)
                + EXEC_WALL_SLACK_MS + CONTAINER_LIFECYCLE_MS;
        long perUnitWithQueue = perUnit + internalQueueWaitMs;
        // Plafonné par le BUDGET GLOBAL du serveur (app.exec.interpreted-budget-ms) : passé son
        // échéance, les harnais restants ne sont plus lancés. Le budget est consulté AVANT
        // chaque harnais, donc un harnais déjà parti le dépasse d'une unité — de DEUX en SQL
        // (phases isolées) ; ce dépassement est AJOUTÉ, sans quoi le client renoncerait avant le
        // serveur et supprimerait une tentative encore en correction (le bug de #216).
        // Sans ce plafond, 100 harnais Python donnaient près de 7 h de délai, pendant lesquelles
        // un fil @Async restait épinglé si execution-service pendait sans fermer la socket — le
        // chemin compilé, lui, était déjà borné par EVAL_MAX_WALL_MS.
        long overshootUnits = sqlLanguage(language) ? 2 : 1;
        long serverWork = Math.min((long) Math.max(workUnits, 1) * perUnitWithQueue,
                interpretedBudgetMs + overshootUnits * perUnitWithQueue);
        return baseReadTimeoutMs + serverWork;
    }

    /** Marge par unité au-delà du temps limite du prof (collecte, strace, va-et-vient). */
    private static final long RUN_MARGIN_MS = 5_000;

    /** Temps limite par défaut quand la question n'en fixe pas (défaut du superviseur). */
    private static final long DEFAULT_RUN_MS = 10_000;

    /** Mur du mode exec PAR UNITÉ — miroir de {@code RunnerExec.WALL_OVERHEAD_MS} (75 s) :
     * démarrage du conteneur et compilation exec (tsc…), le temps limite s'y ajoute. */
    private static final long EXEC_WALL_SLACK_MS = 75_000;

    /** Base du conteneur de notation compilée — miroir de {@code BASE_OVERHEAD_MS} (30 s). */
    private static final long EVAL_BASE_MS = 30_000;

    /** Marge par cas de notation — miroir de {@code PER_CASE_OVERHEAD_MS} (10 s). */
    private static final long EVAL_CASE_MARGIN_MS = 10_000;

    /** Budget de compilation PAR CAS — miroir de {@code COMPILE_TIMEOUT_S} du superviseur. */
    private static final long COMPILE_SLACK_MS = 90_000;

    /**
     * Inventaire {@code --list} PAR CAS (Rust) — miroir de {@code LIST_BUDGET_MS} de
     * DockerEvaluator et de {@code LIST_TIMEOUT_S} du superviseur. Ce terme est PROPORTIONNEL
     * au nombre de cas : l'omettre rendait le miroir plus court que le mur réel, et le read
     * timeout expirait pendant une notation encore en cours — le bug de #216.
     */
    private static final long LIST_SLACK_MS = 5_000;

    /** Mur maximal d'un conteneur de notation — miroir de {@code DockerEvaluator.MAX_WALL_MS}. */
    private static final long EVAL_MAX_WALL_MS = 15 * 60_000;

    /**
     * Budget global de la boucle interprétée/SQL/vues d'execution-service, par défaut : miroir
     * d'{@code app.exec.interpreted-budget-ms} (15 min). La valeur effective vient de la MÊME
     * variable d'environnement que côté serveur ({@code EXEC_INTERPRETED_BUDGET_MS}), cf. le
     * constructeur, et le {@code .env} commun la porte (cf. {@code .env.example}) — la poser
     * dans le bloc {@code environment:} d'un seul service la ferait diverger en silence.
     */
    static final long DEFAULT_EXEC_BUDGET_MS = 15 * 60_000;

    /**
     * Cycle de vie du conteneur HORS mur, par unité de travail : création, copie du job,
     * démarrage, suppression, et surtout la collecte des logs — {@code DockerSandbox} l'attend
     * jusqu'à 30 s APRÈS le mur. Sans ce miroir, l'invariant « budget client ≥ pire cas
     * serveur » était faux au sens strict, et un flux de logs qui traîne pouvait faire
     * abandonner une correction encore en cours (le défaut de #216).
     */
    private static final long CONTAINER_LIFECYCLE_MS = 35_000;

    /** Plancher VM du superviseur (JVM/mono froids) — miroir du mode evaluate. */
    private static final long VM_FLOOR_MS = 10_000;

    /** Langage à machine virtuelle lente au départ (plancher du superviseur). */
    static boolean vmLanguage(String language) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return switch (lang) {
            case "java", "csharp", "c#", "cs", "c-sharp" -> true;
            default -> false;
        };
    }

    /**
     * Nombre d'unités de travail du sandbox pour corriger {@code harnessCount} harnais en
     * {@code language} — dimensionne le délai d'attente de la réponse :
     * <ul>
     *   <li>un par harnais (interprétés) ;</li>
     *   <li>DEUX par harnais en SQL : un harnais de modification ({@code -- @student}) s'exécute en
     *       deux phases isolées, chacune avec son attente et son conteneur runner. Le mode n'est pas
     *       déduit ici (execution-service l'analyse dans le harnais) : tout harnais SQL compte pour
     *       deux, ce qui ne fait qu'allonger le délai d'une question SQL en lecture seule ;</li>
     *   <li>DEUX par harnais + 2 pour un langage COMPILÉ (#116) : le runner Docker COMPILE puis
     *       exécute chaque cas, et ajoute deux canaris anti-falsification — la compilation (jusqu'à
     *       90 s de budget côté runner) peut dominer le temps d'exécution.</li>
     * </ul>
     */
    static int workUnits(String language, int harnessCount) {
        if (sqlLanguage(language)) {
            return 2 * harnessCount;
        }
        return compiled(language) ? 2 * harnessCount + 2 : harnessCount;
    }

    /**
     * Langage SQL : un harnais de MODIFICATION y vaut deux unites (deux phases isolees), donc un
     * harnais deja lance peut depasser l'echeance du serveur de deux unites, pas d'une.
     */
    static boolean sqlLanguage(String language) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return lang.equals("sql") || lang.equals("sqlite") || lang.equals("sqlite3");
    }

    /** Langage noté dans le runner compilé (budget de compilation à prévoir côté client). */
    static boolean compiled(String language) {
        String lang = language == null ? "" : language.trim().toLowerCase(Locale.ROOT);
        return switch (lang) {
            case "c", "c++", "cpp", "cplusplus", "go", "golang", "rust",
                 "csharp", "c#", "cs", "c-sharp", "java" -> true;
            default -> false;
        };
    }

    // Client par appel : le délai de lecture dépend du nombre d'appels au sandbox, du temps
    // limite de la question et du langage. Un sandbox injoignable ou bloqué échoue proprement
    // (→ null) plutôt que de faire traîner le thread indéfiniment.
    private RestClient restClient(long readTimeoutMs) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofMillis(connectTimeoutMs));
        factory.setReadTimeout(Duration.ofMillis(readTimeoutMs));
        return RestClient.builder().requestFactory(factory).build();
    }

    /** Un harnais à exécuter (nom + code + poids). */
    public record Harness(String name, String harnessCode, int weight) {}

    /** Verdict renvoyé par execution-service (on n'exploite que {@code passed} + l'ordre). */
    private record Verdict(String name, int weight, boolean passed, String detail) {}

    /**
     * Exécute {@code code} contre {@code harnesses} dans {@code language} ; renvoie la liste des
     * verdicts (true = réussi) dans le MÊME ordre que {@code harnesses}, ou {@code null} en cas
     * d'échec d'appel.
     */
    /** Surcharge sans timeout (défaut du sandbox). */
    public List<Boolean> evaluate(String language, String code, List<Harness> harnesses) {
        return evaluate(language, code, harnesses, null);
    }

    public List<Boolean> evaluate(String language, String code, List<Harness> harnesses, Integer timeoutMs) {
        // Défense en profondeur : la valeur vient de la BD (normalisée à l'écriture par
        // QuizService), mais une ligne aberrante ne doit ni gonfler le budget de lecture ni
        // atteindre execution-service telle quelle.
        Integer timeout = timeoutMs == null || timeoutMs <= 0 ? null : Math.min(timeoutMs, 60_000);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("language", language == null ? "" : language);
        body.put("code", code == null ? "" : code);
        body.put("testCases", harnesses.stream()
                .map(h -> Map.of("name", h.name(), "harnessCode", h.harnessCode(), "weight", h.weight()))
                .toList());
        if (timeout != null) body.put("timeoutMs", timeout);
        long readTimeout = readTimeoutMs(language, workUnits(language, harnesses.size()), timeout);
        try {
            Verdict[] verdicts = restClient(readTimeout).post()
                    .uri(baseUrl + "/internal/exec/evaluate")
                    .header("X-Internal-Token", internalToken)
                    .contentType(MediaType.APPLICATION_JSON)
                    .body(body)
                    .retrieve()
                    .body(Verdict[].class);
            if (verdicts == null) return null;
            return Arrays.stream(verdicts).map(Verdict::passed).toList();
        } catch (RestClientException e) {
            log.warn("Exécution du code (langage {}) échouée : {}", language, e.getMessage());
            return null;
        }
    }

}
