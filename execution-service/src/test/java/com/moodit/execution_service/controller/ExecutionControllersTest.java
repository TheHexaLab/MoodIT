package com.moodit.execution_service.controller;

import com.moodit.execution_service.assembly.UnsupportedLanguageException;
import com.moodit.execution_service.dto.EvaluateRequest;
import com.moodit.execution_service.dto.RunRequest;
import com.moodit.execution_service.dto.RunResult;
import com.moodit.execution_service.dto.TestCaseInput;
import com.moodit.execution_service.dto.TestResult;
import com.moodit.execution_service.piston.PistonException;
import com.moodit.execution_service.security.InternalTokenValidator;
import com.moodit.execution_service.service.ExecutionService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Contrôleurs REST (public /exec et interne /internal/exec) en MockMvc AUTONOME (sans contexte
 * Spring ni sécurité) : sérialisation, validation des payloads, jeton interne, et traduction des
 * exceptions par {@link GlobalExceptionHandler} (422 langage non supporté, 502 sandbox en panne).
 */
class ExecutionControllersTest {

    private final ExecutionService service = mock(ExecutionService.class);
    private MockMvc mvc;

    private static final String EVALUATE_BODY = """
            {"language":"Python","code":"def f(): pass",
             "testCases":[{"name":"t1","harnessCode":"return True","weight":2}]}
            """;

    @BeforeEach
    void setUp() {
        InternalExecutionController internal =
                new InternalExecutionController(service, new InternalTokenValidator("secret-interne"));
        mvc = MockMvcBuilders.standaloneSetup(new ExecutionController(service), internal)
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
    void interne_jeton_non_configure_refuse_tout() throws Exception {
        InternalExecutionController closed =
                new InternalExecutionController(service, new InternalTokenValidator(""));
        MockMvc closedMvc = MockMvcBuilders.standaloneSetup(closed).build();

        // Ni sans en-tête, ni avec un en-tête vide : un jeton absent de la config n'ouvre rien.
        closedMvc.perform(post("/internal/exec/evaluate")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isForbidden());
        closedMvc.perform(post("/internal/exec/evaluate").header("X-Internal-Token", "")
                        .contentType(MediaType.APPLICATION_JSON).content(EVALUATE_BODY))
                .andExpect(status().isForbidden());
        verify(service, never()).evaluate(any());
    }
}
