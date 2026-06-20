// Envoi des courriels (asynchrone) : code de vérification d'inscription, code 2FA, et
// notification de tentative d'inscription sur un email déjà utilisé.
//
// Les envois sont @Async : la latence/un timeout SMTP ne bloque pas la requête HTTP. En
// contrepartie, l'échec ne remonte plus dans la réponse -> on le journalise ici (sans jamais
// logguer le code, qui est un secret).

package com.moodit.auth_service.service;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.mail.SimpleMailMessage;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

@Service
@Slf4j
@RequiredArgsConstructor
public class EmailService {

  private final JavaMailSender mailSender;

  @Async("emailExecutor")
  public void sendVerificationCode(String to, String code) {
    try {
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
    } catch (Exception e) {
      log.error("Échec d'envoi du code de vérification à {}", to, e);
    }
  }

  // Prévient le propriétaire d'un email déjà inscrit qu'une nouvelle inscription a été tentée.
  // Permet au register de renvoyer une réponse générique (anti-énumération) tout en informant
  // la personne réellement concernée, hors-bande.
  @Async("emailExecutor")
  public void sendAccountAlreadyExists(String to) {
    try {
      SimpleMailMessage message = new SimpleMailMessage();
      message.setFrom("noreply@moodit.ca");
      message.setTo(to);
      message.setSubject("MoodIT — Tentative d'inscription");
      message.setText(
          "Bonjour,\n\n"
              + "Une inscription vient d'être tentée avec cette adresse, mais un compte MoodIT "
              + "existe déjà pour cet email.\n\n"
              + "Si c'était vous, connectez-vous directement.\n\n"
              + "Si ce n'était pas vous, ignorez simplement cet email : aucun nouveau compte "
              + "n'a été créé.\n\n"
              + "L'équipe MoodIT");
      mailSender.send(message);
    } catch (Exception e) {
      log.error("Échec d'envoi de la notification de compte existant à {}", to, e);
    }
  }

  @Async("emailExecutor")
  public void send2FACode(String to, String code) {
    try {
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
    } catch (Exception e) {
      log.error("Échec d'envoi du code de connexion (2FA) à {}", to, e);
    }
  }
}
