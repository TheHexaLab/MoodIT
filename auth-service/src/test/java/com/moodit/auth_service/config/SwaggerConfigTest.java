package com.moodit.auth_service.config;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.auth_service.controller.AuthController;
import com.moodit.auth_service.service.AuthService;
import org.junit.jupiter.api.Test;
import org.springdoc.core.configuration.SpringDocConfiguration;
import org.springdoc.core.properties.SpringDocConfigProperties;
import org.springdoc.webmvc.core.configuration.SpringDocWebMvcConfiguration;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.ImportAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

// Documentation OpenAPI servie pour de vrai (chaîne de sécurité active) : accessible sans jeton, et
// elle déclare le schéma Bearer JWT appliqué globalement (bouton « Authorize » de Swagger UI).
@WebMvcTest(AuthController.class)
@Import({SecurityConfig.class, SwaggerConfig.class})
@ImportAutoConfiguration({
  SpringDocConfiguration.class,
  SpringDocConfigProperties.class,
  SpringDocWebMvcConfiguration.class
})
class SwaggerConfigTest {

  @Autowired private MockMvc mockMvc;

  @MockitoBean private AuthService authService;
  @MockitoBean private AuthCookie authCookie;

  @Test
  void apiDocs_publics_declarent_le_schema_bearer_jwt_global() throws Exception {
    mockMvc
        .perform(get("/v3/api-docs"))
        .andExpect(status().isOk())
        .andExpect(jsonPath("$.info.title").value("MoodIT Auth Service"))
        .andExpect(jsonPath("$.components.securitySchemes['Bearer Authentication'].type").value("http"))
        .andExpect(jsonPath("$.components.securitySchemes['Bearer Authentication'].scheme").value("bearer"))
        .andExpect(jsonPath("$.components.securitySchemes['Bearer Authentication'].bearerFormat").value("JWT"))
        .andExpect(jsonPath("$.security[0]['Bearer Authentication']").isArray())
        // Les routes du contrôleur sont bien documentées.
        .andExpect(jsonPath("$.paths['/auth/login']").exists());
  }
}
