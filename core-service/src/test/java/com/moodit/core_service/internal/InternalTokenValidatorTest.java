package com.moodit.core_service.internal;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/** Jeton interne : comparaison exacte, et fail-closed si aucun jeton n'est configuré (#31). */
class InternalTokenValidatorTest {

    @Test
    @DisplayName("Bon jeton → valide")
    void bonJeton_valide() {
        assertThat(new InternalTokenValidator("jeton").isValid("jeton")).isTrue();
    }

    @Test
    @DisplayName("Jeton faux, préfixe, plus long ou absent → refusé")
    void mauvaisJeton_refuse() {
        InternalTokenValidator validator = new InternalTokenValidator("jeton");
        assertThat(validator.isValid("jetoN")).isFalse();
        assertThat(validator.isValid("jet")).isFalse();
        assertThat(validator.isValid("jeton2")).isFalse();
        assertThat(validator.isValid("")).isFalse();
        assertThat(validator.isValid(null)).isFalse();
    }

    @Test
    @DisplayName("Aucun jeton configuré (vide ou null) → tout est refusé, même un jeton vide")
    void jetonNonConfigure_toutRefuse() {
        assertThat(new InternalTokenValidator("").isValid("")).isFalse();
        assertThat(new InternalTokenValidator("").isValid("n-importe-quoi")).isFalse();
        assertThat(new InternalTokenValidator(null).isValid("")).isFalse();
        assertThat(new InternalTokenValidator(null).isValid(null)).isFalse();
    }

    @Test
    @DisplayName("Jeton non ASCII : comparé octet à octet en UTF-8")
    void jetonNonAscii_compareEnUtf8() {
        assertThat(new InternalTokenValidator("clé-é").isValid("clé-é")).isTrue();
        assertThat(new InternalTokenValidator("clé-é").isValid("cle-e")).isFalse();
    }
}
