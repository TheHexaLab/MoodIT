package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mail.MailSendException;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

// Tests unitaires de la construction des courriels : destinataire, expéditeur, sujet et corps.
// Le JavaMailSender est mocké : aucun courriel n'est réellement envoyé. Les méthodes sont
// appelées directement (sans proxy @Async), donc de façon synchrone.
@ExtendWith(MockitoExtension.class)
class EmailServiceTest {

  @Mock private JavaMailSender mailSender;

  @InjectMocks private EmailService emailService;

  private static final String TO = "karine.roussel@usherbrooke.ca";
  private static final String FROM = "noreply@moodit.ca";

  private SimpleMailMessage sentMessage() {
    ArgumentCaptor<SimpleMailMessage> captor = ArgumentCaptor.forClass(SimpleMailMessage.class);
    verify(mailSender).send(captor.capture());
    return captor.getValue();
  }

  // ----- sendVerificationCode -----

  @Test
  void sendVerificationCode_buildsMessage_withRecipientSubjectAndCode() {
    emailService.sendVerificationCode(TO, "123456");

    SimpleMailMessage m = sentMessage();
    assertThat(m.getFrom()).isEqualTo(FROM);
    assertThat(m.getTo()).containsExactly(TO);
    assertThat(m.getSubject()).isEqualTo("MoodIT — Code de vérification");
    assertThat(m.getText())
        .contains("code de vérification MoodIT : 123456")
        .contains("expire dans 15 minutes")
        .endsWith("L'équipe MoodIT");
  }

  @Test
  void sendVerificationCode_whenSmtpFails_swallowsException() {
    // L'envoi est asynchrone : l'échec SMTP est journalisé, jamais propagé à l'appelant.
    doThrow(new MailSendException("SMTP indisponible"))
        .when(mailSender)
        .send(any(SimpleMailMessage.class));

    assertThatCode(() -> emailService.sendVerificationCode(TO, "123456"))
        .doesNotThrowAnyException();
  }

  // ----- sendAccountAlreadyExists -----

  @Test
  void sendAccountAlreadyExists_buildsNotification_withoutAnyCode() {
    emailService.sendAccountAlreadyExists(TO);

    SimpleMailMessage m = sentMessage();
    assertThat(m.getFrom()).isEqualTo(FROM);
    assertThat(m.getTo()).containsExactly(TO);
    assertThat(m.getSubject()).isEqualTo("MoodIT — Tentative d'inscription");
    assertThat(m.getText())
        .contains("un compte MoodIT existe déjà pour cet email")
        .contains("aucun nouveau compte n'a été créé")
        // Notification purement informative : aucun code à 6 chiffres ne doit y figurer.
        .doesNotContainPattern("\\d{6}");
  }

  @Test
  void sendAccountAlreadyExists_whenSmtpFails_swallowsException() {
    doThrow(new MailSendException("SMTP indisponible"))
        .when(mailSender)
        .send(any(SimpleMailMessage.class));

    assertThatCode(() -> emailService.sendAccountAlreadyExists(TO)).doesNotThrowAnyException();
  }

  // ----- sendPasswordResetCode -----

  @Test
  void sendPasswordResetCode_buildsMessage_withRecipientSubjectAndCode() {
    emailService.sendPasswordResetCode(TO, "654321");

    SimpleMailMessage m = sentMessage();
    assertThat(m.getFrom()).isEqualTo(FROM);
    assertThat(m.getTo()).containsExactly(TO);
    assertThat(m.getSubject()).isEqualTo("MoodIT — Réinitialisation du mot de passe");
    assertThat(m.getText())
        .contains("code de réinitialisation de mot de passe MoodIT : 654321")
        .contains("expire dans 15 minutes")
        .contains("votre mot de passe actuel reste inchangé");
  }

  @Test
  void sendPasswordResetCode_whenSmtpFails_swallowsException() {
    doThrow(new MailSendException("SMTP indisponible"))
        .when(mailSender)
        .send(any(SimpleMailMessage.class));

    assertThatCode(() -> emailService.sendPasswordResetCode(TO, "654321"))
        .doesNotThrowAnyException();
  }

  // ----- send2FACode -----

  @Test
  void send2FACode_buildsMessage_withRecipientSubjectAndCode() {
    emailService.send2FACode(TO, "987654");

    SimpleMailMessage m = sentMessage();
    assertThat(m.getFrom()).isEqualTo(FROM);
    assertThat(m.getTo()).containsExactly(TO);
    assertThat(m.getSubject()).isEqualTo("MoodIT — Code de connexion");
    assertThat(m.getText())
        .contains("code de connexion MoodIT : 987654")
        .contains("expire dans 15 minutes")
        .contains("changez votre mot de passe immédiatement");
  }

  @Test
  void send2FACode_whenSmtpFails_swallowsException() {
    doThrow(new MailSendException("SMTP indisponible"))
        .when(mailSender)
        .send(any(SimpleMailMessage.class));

    assertThatCode(() -> emailService.send2FACode(TO, "987654")).doesNotThrowAnyException();
  }

  @Test
  void eachEmailKind_hasDistinctSubject() {
    // Les quatre courriels doivent rester distinguables par leur sujet dans la boîte de réception.
    emailService.sendVerificationCode(TO, "111111");
    emailService.sendAccountAlreadyExists(TO);
    emailService.sendPasswordResetCode(TO, "222222");
    emailService.send2FACode(TO, "333333");

    ArgumentCaptor<SimpleMailMessage> captor = ArgumentCaptor.forClass(SimpleMailMessage.class);
    verify(mailSender, org.mockito.Mockito.times(4)).send(captor.capture());
    assertThat(captor.getAllValues())
        .extracting(SimpleMailMessage::getSubject)
        .doesNotHaveDuplicates()
        .allMatch(s -> s.startsWith("MoodIT — "));
  }
}
