package com.moodit.auth_service.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class DevFixedTwoFactorCodeTest {

  private static MockEnvironment env(String code, String... profiles) {
    MockEnvironment env = new MockEnvironment();
    env.setActiveProfiles(profiles);
    if (code != null) env.setProperty(DevFixedTwoFactorCode.PROPERTY, code);
    return env;
  }

  @Test
  void disabledByDefault() {
    assertThat(new DevFixedTwoFactorCode(env(null, "dev")).code()).isEmpty();
    assertThat(new DevFixedTwoFactorCode(env("  ", "prod")).code()).isEmpty();
  }

  @Test
  void activeOnlyUnderDevProfile() {
    assertThat(new DevFixedTwoFactorCode(env("000000", "dev")).code()).contains("000000");
  }

  @Test
  void refusesToStartInProd() {
    assertThatThrownBy(() -> new DevFixedTwoFactorCode(env("000000", "prod")))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void refusesToStartWithoutProfileOrWithDevAndProd() {
    assertThatThrownBy(() -> new DevFixedTwoFactorCode(env("000000")))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> new DevFixedTwoFactorCode(env("000000", "dev", "prod")))
        .isInstanceOf(IllegalStateException.class);
  }

  @Test
  void rejectsMalformedCode() {
    assertThatThrownBy(() -> new DevFixedTwoFactorCode(env("1234", "dev")))
        .isInstanceOf(IllegalStateException.class);
    assertThatThrownBy(() -> new DevFixedTwoFactorCode(env("abcdef", "dev")))
        .isInstanceOf(IllegalStateException.class);
  }
}
