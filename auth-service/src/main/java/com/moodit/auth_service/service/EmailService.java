// Envoi des courriels (asynchrone) : code de vérification d'inscription, code 2FA, et
// notification de tentative d'inscription sur un email déjà utilisé.
//
// Les envois sont @Async : la latence/un timeout SMTP ne bloque pas la requête HTTP. En
// contrepartie, l'échec ne remonte plus dans la réponse -> on le journalise ici (sans jamais
// logguer le code, qui est un secret).

package com.moodit.auth_service.service;

import java.util.List;
import java.util.Locale;
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
      deliver(message);
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
      deliver(message);
    } catch (Exception e) {
      log.error("Échec d'envoi de la notification de compte existant à {}", to, e);
    }
  }

  @Async("emailExecutor")
  public void sendPasswordResetCode(String to, String code) {
    try {
      SimpleMailMessage message = new SimpleMailMessage();
      message.setFrom("noreply@moodit.ca");
      message.setTo(to);
      message.setSubject("MoodIT — Réinitialisation du mot de passe");
      message.setText(
          "Bonjour,\n\n"
              + "Voici votre code de réinitialisation de mot de passe MoodIT : "
              + code
              + "\n\n"
              + "Ce code expire dans 15 minutes.\n\n"
              + "Si vous n'avez pas demandé à réinitialiser votre mot de passe, ignorez cet email : "
              + "votre mot de passe actuel reste inchangé.\n\n"
              + "L'équipe MoodIT");
      deliver(message);
    } catch (Exception e) {
      log.error("Échec d'envoi du code de réinitialisation à {}", to, e);
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
      deliver(message);
    } catch (Exception e) {
      log.error("Échec d'envoi du code de connexion (2FA) à {}", to, e);
    }
  }

  // Prévient le titulaire du compte qu'un appareil a été ajouté à son vocal chiffré (voice-service/
  // E2EE.md §5.3) : un appareil injecté à son insu (compte compromis) devient visible hors-bande.
  @Async("emailExecutor")
  public void sendNewVoiceDevice(String to, String deviceLabel, String createdAt) {
    try {
      SimpleMailMessage message = new SimpleMailMessage();
      message.setFrom("noreply@moodit.ca");
      message.setTo(to);
      message.setSubject("MoodIT — Nouvel appareil pour le vocal chiffré");
      message.setText(
          "Bonjour,\n\n"
              + "Un nouvel appareil a été ajouté au vocal chiffré de votre compte MoodIT :\n"
              + "  "
              + (deviceLabel == null || deviceLabel.isBlank() ? "Appareil inconnu" : deviceLabel)
              + " — "
              + createdAt
              + "\n\n"
              + "Si c'était vous (nouveau navigateur, données du site effacées), ignorez cet email.\n\n"
              + "Sinon, révoquez-le depuis « Mes appareils » dans un salon vocal et changez votre "
              + "mot de passe immédiatement.\n\n"
              + "L'équipe MoodIT");
      deliver(message);
    } catch (Exception e) {
      log.error("Échec d'envoi de la notification de nouvel appareil à {}", to, e);
    }
  }

  // Domaines RÉSERVÉS (RFC 2606 / 6761) : ils ne peuvent jamais recevoir d'email. On n'envoie
  // rien (pas de rebond SMTP) — c'est le cas des comptes de test E2E (@e2e.test).
  private static final List<String> RESERVED_TLDS =
      List.of(".test", ".example", ".invalid", ".localhost");

  static boolean isUndeliverable(String to) {
    if (to == null) return true;
    String domain = to.substring(to.lastIndexOf('@') + 1).toLowerCase(Locale.ROOT);
    return RESERVED_TLDS.stream()
        .anyMatch(tld -> domain.endsWith(tld) || domain.equals(tld.substring(1)));
  }

  private void deliver(SimpleMailMessage message) {
    String[] to = message.getTo();
    if (to != null && to.length == 1 && isUndeliverable(to[0])) {
      log.debug("Email non envoyé : domaine réservé ({})", to[0]);
      return;
    }
    mailSender.send(message);
  }
}
