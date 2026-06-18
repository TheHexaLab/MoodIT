// Envoi des courriels : code de vérification d'inscription et code 2FA.

package com.moodit.auth_service.service;

import lombok.RequiredArgsConstructor;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class EmailService {

  private final JavaMailSender mailSender;

  public void sendVerificationCode(String to, String code) {
    SimpleMailMessage message = new SimpleMailMessage();
    message.setFrom("noreply@moodit.ca");
    message.setTo(to);
    message.setSubject("MoodIT — Code de vérification");
    message.setText(
        "Bonjour,\n\n"
            + "Voici votre code de vérification MoodIT : "
            + code
            + "\n\n"
            + "Ce code expire dans 15 minutes.\n\n"
            + "Si vous n'avez pas demandé ce code, ignorez cet email.\n\n"
            + "L'équipe MoodIT");
    mailSender.send(message);
  }

  public void send2FACode(String to, String code) {
    SimpleMailMessage message = new SimpleMailMessage();
    message.setFrom("noreply@moodit.ca");
    message.setTo(to);
    message.setSubject("MoodIT — Code de connexion");
    message.setText(
        "Bonjour,\n\n"
            + "Voici votre code de connexion MoodIT : "
            + code
            + "\n\n"
            + "Ce code expire dans 15 minutes.\n\n"
            + "Si vous n'avez pas tenté de vous connecter, changez votre mot de passe immédiatement.\n\n"
            + "L'équipe MoodIT");
    mailSender.send(message);
  }
}
