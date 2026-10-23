package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.junit.jupiter.api.Test;

class SwaggerConfigTest {

  @Test
  void openApi_describesServiceAndDeclaresBearerJwtScheme() {
    OpenAPI api = new SwaggerConfig().customOpenAPI();

    assertThat(api.getInfo().getTitle()).isEqualTo("MoodIT Auth Service");
    assertThat(api.getInfo().getVersion()).isEqualTo("1.0");
    SecurityScheme scheme = api.getComponents().getSecuritySchemes().get("Bearer Authentication");
    assertThat(scheme).isNotNull();
    assertThat(scheme.getType()).isEqualTo(SecurityScheme.Type.HTTP);
    assertThat(scheme.getScheme()).isEqualTo("bearer");
    assertThat(scheme.getBearerFormat()).isEqualTo("JWT");
    // Le schéma est appliqué globalement à toutes les opérations.
    assertThat(api.getSecurity()).anySatisfy(req -> assertThat(req).containsKey("Bearer Authentication"));
  }
}
