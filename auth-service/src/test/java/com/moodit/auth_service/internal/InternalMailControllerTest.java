package com.moodit.auth_service.internal;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.auth_service.service.EmailService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(InternalMailController.class)
@AutoConfigureMockMvc(addFilters = false)
@TestPropertySource(properties = "app.internal.token=secret-interne")
class InternalMailControllerTest {

  private static final String BODY =
      "{\"email\":\"karine@usherbrooke.ca\",\"label\":\"Edge · Windows\",\"createdAt\":\"2026-10-12\"}";

  @Autowired private MockMvc mvc;
  @MockitoBean private EmailService emailService;

  @Test
  void validTokenSendsEmail() throws Exception {
    mvc.perform(
            post("/internal/mail/new-voice-device")
                .header("X-Internal-Token", "secret-interne")
                .contentType(MediaType.APPLICATION_JSON)
                .content(BODY))
        .andExpect(status().isAccepted());
    verify(emailService)
        .sendNewVoiceDevice("karine@usherbrooke.ca", "Edge · Windows", "2026-10-12");
  }

  @Test
  void missingOrWrongTokenIsRefused() throws Exception {
    mvc.perform(
            post("/internal/mail/new-voice-device")
                .contentType(MediaType.APPLICATION_JSON)
                .content(BODY))
        .andExpect(status().isForbidden());
    mvc.perform(
            post("/internal/mail/new-voice-device")
                .header("X-Internal-Token", "mauvais")
                .contentType(MediaType.APPLICATION_JSON)
                .content(BODY))
        .andExpect(status().isForbidden());
    verify(emailService, never()).sendNewVoiceDevice(anyString(), anyString(), anyString());
  }
}
