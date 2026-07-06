package com.moodit.mcp_service.util;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Anonymisation conservatrice : le PII à motif fiable est caviardé, l'OPINION survit.
 * (Contrat de confidentialité avant envoi au LLM externe — cf. {@link ForumTextRedactor}.)
 */
class ForumTextRedactorTest {

    @Test
    void redacts_email() {
        String out = ForumTextRedactor.redact("Contacte john.doe@example.com pour la suite.");
        assertThat(out).contains("[courriel]").doesNotContain("example.com").doesNotContain("@");
    }

    @Test
    void redacts_http_and_www_links() {
        assertThat(ForumTextRedactor.redact("Voir https://evil.test/x")).contains("[lien]");
        assertThat(ForumTextRedactor.redact("mon site www.perso.fr")).contains("[lien]");
    }

    @Test
    void redacts_mention() {
        assertThat(ForumTextRedactor.redact("merci @prof pour l'aide")).contains("[mention]");
    }

    @Test
    void redacts_long_number_like_phone_or_id() {
        assertThat(ForumTextRedactor.redact("appelle-moi au 0612345678")).contains("[numéro]");
    }

    @Test
    void keeps_short_numbers_like_grades_and_percentages() {
        String out = ForumTextRedactor.redact("j'ai eu 8/10 au quiz, soit 70% environ");
        assertThat(out).doesNotContain("[numéro]").contains("8/10").contains("70%");
    }

    @Test
    void preserves_the_opinion_text() {
        String msg = "Le cours est trop rapide et mal expliqué.";
        assertThat(ForumTextRedactor.redact(msg)).isEqualTo(msg);
    }

    @Test
    void combined_message_keeps_opinion_but_strips_pii() {
        String out = ForumTextRedactor.redact(
                "Super cours mais écris-moi à a.b@mail.com, cours trop rapide");
        assertThat(out)
                .contains("Super cours")
                .contains("cours trop rapide")
                .contains("[courriel]")
                .doesNotContain("a.b@mail.com");
    }

    @Test
    void handles_null_and_blank() {
        assertThat(ForumTextRedactor.redact(null)).isNull();
        assertThat(ForumTextRedactor.redact("   ")).isEqualTo("   ");
    }
}
