package com.moodit.execution_service.controller;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonException;
import com.moodit.execution_service.security.InternalTokenValidator;
import com.moodit.execution_service.service.ExecutionBusyException;
import com.moodit.execution_service.service.ExecutionLimiter;
import com.moodit.execution_service.service.ExecutionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Contrôleurs REST (public /exec et interne /internal/exec) en MockMvc AUTONOME (sans contexte
 * Spring ni sécurité) : sérialisation, validation des payloads, jeton interne, et traduction des
 * exceptions par {@link GlobalExceptionHandler} (422 langage non supporté, 502 sandbox en panne,
 * 429 trop d'exécutions), et la limite par utilisateur, appliquée au public seulement.
 */
class ExecutionControllersTest {

    private final ExecutionService service = mock(ExecutionService.class);
    /** Une seule requête en cours par utilisateur, pour rendre la limite observable. */
    private final ExecutionLimiter limiter = new ExecutionLimiter(4, 0, 1);
    private MockMvc mvc;

    private static final String EVALUATE_BODY = """
            {"language":"Python","code":"def f(): pass",
             "testCases":[{"name":"t1","harnessCode":"return True","weight":2}]}
            """;

    @BeforeEach
    void setUp() {
        InternalExecutionController internal =
                new InternalExecutionController(service, new InternalTokenValidator("secret-interne"), limiter);
        mvc = MockMvcBuilders.standaloneSetup(new ExecutionController(service, limiter), internal)
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @Test
    void evaluate_renvoie_le_verdict_par_test() throws Exception {
        when(service.evaluate(any())).thenReturn(List.of(new TestResult("t1", 2, false, "AssertionError")));

        mvc.perform(post("/exec/evaluate").contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("t1"))
                .andExpect(jsonPath("$[0].weight").value(2))
                .andExpect(jsonPath("$[0].passed").value(false))
                .andExpect(jsonPath("$[0].detail").value("AssertionError"));
        verify(service).evaluate(new EvaluateRequest("Python", null, "def f(): pass",
                List.of(new TestCaseInput("t1", "return True", 2))));
    }

    @Test
    void evaluate_payload_invalide_est_rejete_sans_appeler_le_service() throws Exception {
        // Aucun harnais (@NotEmpty) → 400.
        mvc.perform(post("/exec/evaluate").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"language\":\"Python\",\"code\":\"x\",\"testCases\":[]}"))
                .andExpect(status().isBadRequest());
        verify(service, never()).evaluate(any());
    }

    @Test
    void run_renvoie_la_sortie_brute() throws Exception {
        when(service.run(any())).thenReturn(new RunResult("bonjour", "", 0, null, null, false));

        mvc.perform(post("/exec/run").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"language\":\"Python\",\"version\":\"3.12\",\"code\":\"print('bonjour')\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stdout").value("bonjour"))
                .andExpect(jsonPath("$.exitCode").value(0))
                .andExpect(jsonPath("$.timedOut").value(false));
        verify(service).run(new RunRequest("Python", "3.12", "print('bonjour')"));
    }

    @Test
    void langage_non_supporte_donne_422_avec_le_message() throws Exception {
        when(service.run(any())).thenThrow(new UnsupportedLanguageException("COBOL"));

        mvc.perform(post("/exec/run").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"language\":\"COBOL\",\"code\":\"x\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.detail").value("Langage non encore supporté par l'exécution : COBOL"));
    }

    @Test
    void piston_en_panne_donne_502_sans_fuiter_le_detail_interne() throws Exception {
        when(service.evaluate(any())).thenThrow(new PistonException("Appel Piston échoué : http://piston:2000 refusé"));

        mvc.perform(post("/exec/evaluate").contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isBadGateway())
                .andExpect(jsonPath("$.detail").value("Sandbox d'exécution indisponible"));
    }

    @Test
    void interne_avec_le_bon_jeton_evalue() throws Exception {
        when(service.evaluate(any())).thenReturn(List.of(new TestResult("t1", 2, true, null)));

        mvc.perform(post("/internal/exec/evaluate").header("X-Internal-Token", "secret-interne")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].passed").value(true));
    }

    @Test
    void interne_sans_jeton_ou_mauvais_jeton_donne_403() throws Exception {
        mvc.perform(post("/internal/exec/evaluate")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isForbidden());
        mvc.perform(post("/internal/exec/evaluate").header("X-Internal-Token", "faux")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isForbidden());
        verify(service, never()).evaluate(any());
    }

    @Test
    void interne_en_tete_vide_refuse() throws Exception {
        // Un jeton vide ne peut pas être configuré (démarrage refusé, #31) : un en-tête vide
        // ne correspond donc jamais au jeton attendu.
        mvc.perform(post("/internal/exec/evaluate").header("X-Internal-Token", "")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isForbidden());
        verify(service, never()).evaluate(any());
    }

    private static final String SLOW_RUN = "{\"language\":\"Python\",\"code\":\"lent\"}";
    private static final String FAST_RUN = "{\"language\":\"Python\",\"code\":\"vite\"}";

    @Test
    void sandbox_sature_donne_429_avec_message_francais_et_retry_after() throws Exception {
        when(service.run(any())).thenThrow(new ExecutionBusyException(ExecutionBusyException.SANDBOX_BUSY));

        mvc.perform(post("/exec/run").contentType(MediaType.APPLICATION_JSON).content(FAST_RUN))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().string("Retry-After", "5"))
                .andExpect(jsonPath("$.detail").value(ExecutionBusyException.SANDBOX_BUSY));
    }

    @Test
    void limite_par_utilisateur_refuse_la_requete_en_trop_du_meme_utilisateur_seulement() throws Exception {
        // Une exécution d'alice reste en cours (bloquée sur un verrou) pendant qu'on envoie les autres.
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(service.run(new RunRequest("Python", null, "lent"))).thenAnswer(inv -> {
            started.countDown();
            release.await(5, TimeUnit.SECONDS);
            return new RunResult("fini", "", 0, null, null, false);
        });
        when(service.run(new RunRequest("Python", null, "vite")))
                .thenReturn(new RunResult("ok", "", 0, null, null, false));
        when(service.evaluate(any())).thenReturn(List.of(new TestResult("t1", 2, true, null)));
        Thread slow = new Thread(() -> {
            try {
                mvc.perform(post("/exec/run").header("X-User-Email", "alice@usherbrooke.ca")
                        .contentType(MediaType.APPLICATION_JSON).content(SLOW_RUN));
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        slow.start();
        assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();

        try {
            // alice a déjà sa requête en cours : la suivante (run comme evaluate) est refusée tout de suite.
            mvc.perform(post("/exec/run").header("X-User-Email", "alice@usherbrooke.ca")
                            .contentType(MediaType.APPLICATION_JSON).content(FAST_RUN))
                    .andExpect(status().isTooManyRequests())
                    .andExpect(jsonPath("$.detail").value(ExecutionBusyException.USER_BUSY));
            mvc.perform(post("/exec/evaluate").header("X-User-Email", "alice@usherbrooke.ca")
                            .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                    .andExpect(status().isTooManyRequests());
            verify(service, never()).evaluate(any());
            // bob n'est pas concerné par la limite d'alice.
            mvc.perform(post("/exec/run").header("X-User-Email", "bob@usherbrooke.ca")
                            .contentType(MediaType.APPLICATION_JSON).content(FAST_RUN))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.stdout").value("ok"));
            // L'appel interne (correction, sans utilisateur) n'est pas soumis à la limite par utilisateur.
            mvc.perform(post("/internal/exec/evaluate").header("X-Internal-Token", "secret-interne")
                            .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                    .andExpect(status().isOk());
        } finally {
            release.countDown();
            slow.join(5000);
        }

        // Requête d'alice terminée : sa place est rendue.
        mvc.perform(post("/exec/run").header("X-User-Email", "alice@usherbrooke.ca")
                        .contentType(MediaType.APPLICATION_JSON).content(FAST_RUN))
                .andExpect(status().isOk());
    }
}
