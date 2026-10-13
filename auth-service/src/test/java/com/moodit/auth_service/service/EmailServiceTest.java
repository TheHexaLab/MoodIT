package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;

@ExtendWith(MockitoExtension.class)
class EmailServiceTest {

  @Mock private JavaMailSender mailSender;
  @InjectMocks private EmailService emailService;

  @Test
  void reservedDomainsAreUndeliverable() {
    assertThat(EmailService.isUndeliverable("alice@e2e.test")).isTrue();
    assertThat(EmailService.isUndeliverable("x@sub.example")).isTrue();
    assertThat(EmailService.isUndeliverable("x@foo.INVALID")).isTrue();
    assertThat(EmailService.isUndeliverable("x@localhost")).isTrue();
    assertThat(EmailService.isUndeliverable("karine@usherbrooke.ca")).isFalse();
    // « test » au milieu d'un vrai domaine n'est PAS réservé.
    assertThat(EmailService.isUndeliverable("x@test.usherbrooke.ca")).isFalse();
  }

  @Test
  void noSmtpCallForReservedDomain() {
    emailService.send2FACode("alice@e2e.test", "123456");
    emailService.sendNewVoiceDevice("alice@e2e.test", "Edge · Windows", "2026-10-12 18:00");
    verify(mailSender, never()).send(any(SimpleMailMessage.class));
  }

  @Test
  void realDomainIsSent() {
    emailService.sendNewVoiceDevice("karine@usherbrooke.ca", "Edge · Windows", "2026-10-12 18:00");
    verify(mailSender).send(any(SimpleMailMessage.class));
  }
}
