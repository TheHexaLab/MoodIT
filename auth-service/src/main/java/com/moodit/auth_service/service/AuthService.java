package com.moodit.auth_service.service;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.model.User;
import com.moodit.auth_service.model.PendingRegistration;
import com.moodit.auth_service.repository.UserRepository;
import com.moodit.auth_service.repository.PendingRegistrationRepository;
import com.moodit.auth_service.repository.EstablishmentRepository;
import com.moodit.auth_service.exception.DomainNotAllowedException;
import lombok.RequiredArgsConstructor;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.UsernameAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import java.time.LocalDateTime;
import java.util.Map;
import com.moodit.auth_service.exception.EmailNotVerifiedException;
import com.moodit.auth_service.exception.InvalidVerificationCodeException;
import com.moodit.auth_service.exception.TooManyRequestsException;
import com.moodit.auth_service.service.EmailService;
import java.security.SecureRandom;

@Service
@RequiredArgsConstructor
public class AuthService {

  private final UserRepository userRepository;
  private final PendingRegistrationRepository pendingRepository;
  private final EstablishmentRepository establishmentRepository;
  private final JwtService jwtService;
  private final PasswordEncoder passwordEncoder;
  private final EmailService emailService;

  @Value("${app.security.pepper}")
  private String pepper;

  // Anti-bombing : délai minimal entre deux envois de code et nombre max de renvois par email.
  private static final long RESEND_COOLDOWN_SECONDS = 60;
  private static final int MAX_RESEND = 5;
  // Nombre max de codes erronés avant d'invalider le code (anti brute-force des 6 chiffres).
  private static final int MAX_VERIFY_ATTEMPTS = 5;

  // Register

  public Map<String, String> register(RegisterRequest request) {

    // L'email est insensible à la casse : on normalise pour éviter les doublons
    // et les échecs de login dus à une casse différente.
    String email = normalizeEmail(request.getEmail());

    if (userRepository.existsByEmail(email)) {
      throw new EmailAlreadyUsedException();
    }

    // Re-register sur un email déjà en attente : on réutilise la ligne et on renvoie un code
    // (évite qu'un squatteur bloque une vraie personne, et gère le "je n'ai pas reçu le code")
    PendingRegistration existing = pendingRepository.findByEmail(email).orElse(null);

    // Username pris par un compte confirmé, ou par un AUTRE pending (autre email) ?
    if (userRepository.existsByUsername(request.getUsername())) {
      throw new UsernameAlreadyUsedException();
    }
    pendingRepository
        .findByUsername(request.getUsername())
        .filter(p -> existing == null || !p.getId().equals(existing.getId()))
        .ifPresent(
            p -> {
              throw new UsernameAlreadyUsedException();
            });

    // Seuls les domaines d'établissements autorisés peuvent s'inscrire.
    String domain = extractDomain(email);
    if (!establishmentRepository.existsByDomainEmail(domain)) {
      throw new DomainNotAllowedException();
    }

    LocalDateTime now = LocalDateTime.now();

    // Anti-bombing : sur un renvoi, on impose un délai entre deux courriels et un plafond total.
    if (existing != null) {
      if (existing.getLastCodeSentAt() != null
          && existing.getLastCodeSentAt().plusSeconds(RESEND_COOLDOWN_SECONDS).isAfter(now)) {
        throw new TooManyRequestsException(
            "Un code vous a déjà été envoyé. Patientez avant d'en redemander un.");
      }
      if (existing.getResendCount() >= MAX_RESEND) {
        throw new TooManyRequestsException(
            "Trop de demandes d'envoi pour cet email. Réessayez plus tard.");
      }
    }

    PendingRegistration pending = existing != null ? existing : new PendingRegistration();

    String code = generateCode();
    pending.setUsername(request.getUsername());
    pending.setFirstName(request.getFirstName());
    pending.setLastName(request.getLastName());
    pending.setEmail(email);
    pending.setPasswordHash(passwordEncoder.encode(request.getPassword() + pepper));
    pending.setVerificationCode(code);
    pending.setVerificationCodeExpiresAt(now.plusMinutes(15));
    pending.setLastCodeSentAt(now);
    pending.setVerificationAttempts(0);
    if (existing != null) {
      pending.setResendCount(pending.getResendCount() + 1);
    }

    pendingRepository.save(pending);

    emailService.sendVerificationCode(email, code);

    return Map.of("message", "Compte créé! Vérifiez votre email pour activer votre compte.");
  }

  // Login

  public AuthResponse login(LoginRequest request) {

    // Trouver le user (email insensible à la casse)
    String email = normalizeEmail(request.getEmail());
    User user =
        userRepository.findByEmail(email).orElseThrow(() -> new InvalidCredentialsException());
    // Vérifier si l'email est confirmé
    if (!user.isVerifiedEmail()) {
      throw new EmailNotVerifiedException();
    }
    // Vérifier le mot de passe
    if (!passwordEncoder.matches(request.getPassword() + pepper, user.getPasswordHash())) {
      throw new InvalidCredentialsException();
    }

    // Mot de passe valide : on n'émet pas encore de token, la 2FA doit être
    // validée d'abord. Le token est généré dans verify2FA().

    // Générer et envoyer le code 2FA
    String code = generateCode();
    user.setVerificationCode(code);
    user.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(15));
    user.setVerificationAttempts(0);
    userRepository.save(user);

    emailService.send2FACode(email, code);

    return new AuthResponse(
        null, user.getUsername(), user.getEmail(), user.getFirstName(), user.getLastName());
  }

  // Validate

  public boolean validate(String token) {

    // Vérifier la signature JWT
    if (!jwtService.isTokenValid(token)) {
      return false;
    }

    // Trouver le user
    String email = jwtService.extractEmail(token);
    User user = userRepository.findByEmail(email).orElse(null);
    if (user == null) {
      return false;
    }

    // Vérifier le hash du token
    String hashedToken = jwtService.hashToken(token, email);
    return hashedToken.equals(user.getActiveTokenHash());
  }

  // Vérification manuelle pour le dev : promeut l'inscription en attente vers un vrai compte
  @Transactional
  public Map<String, String> verifyDev(String username) {
    // Déjà un compte confirmé ? rien à faire.
    if (userRepository.existsByUsername(username)) {
      return Map.of("message", "Email déjà vérifié pour " + username);
    }

    PendingRegistration pending =
        pendingRepository
            .findByUsername(username)
            .orElseThrow(() -> new RuntimeException("Inscription en attente non trouvée"));

    User user = new User();
    user.setUsername(pending.getUsername());
    user.setFirstName(pending.getFirstName());
    user.setLastName(pending.getLastName());
    user.setEmail(pending.getEmail());
    user.setPasswordHash(pending.getPasswordHash());
    user.setCreatedAt(LocalDateTime.now());
    user.setVerifiedEmail(true);

    userRepository.save(user);
    pendingRepository.delete(pending);

    return Map.of("message", "Email vérifié pour " + username);
  }

  public Map<String, String> verifyEmail(String email, String code) {
    email = normalizeEmail(email);
    PendingRegistration pending =
        pendingRepository
            .findByEmail(email)
            .orElseThrow(() -> new InvalidVerificationCodeException("Code invalide"));

    if (pending.getVerificationCode() == null) {
      throw new InvalidVerificationCodeException("Code invalide. Demandez un nouveau code.");
    }

    if (pending.getVerificationCodeExpiresAt().isBefore(LocalDateTime.now())) {
      throw new InvalidVerificationCodeException("Code expiré");
    }

    if (!pending.getVerificationCode().equals(code)) {
      // Mauvais code : on compte la tentative et on invalide le code au-delà du plafond,
      // pour empêcher le brute-force des 6 chiffres.
      pending.setVerificationAttempts(pending.getVerificationAttempts() + 1);
      if (pending.getVerificationAttempts() >= MAX_VERIFY_ATTEMPTS) {
        pending.setVerificationCode(null);
        pendingRepository.save(pending);
        throw new InvalidVerificationCodeException(
            "Trop de tentatives. Demandez un nouveau code.");
      }
      pendingRepository.save(pending);
      throw new InvalidVerificationCodeException("Code invalide");
    }

    // Garde-fou contre une course (un autre signup confirmé entre-temps)
    if (userRepository.existsByEmail(email)) {
      throw new EmailAlreadyUsedException();
    }
    if (userRepository.existsByUsername(pending.getUsername())) {
      throw new UsernameAlreadyUsedException();
    }

    User user = new User();
    user.setUsername(pending.getUsername());
    user.setFirstName(pending.getFirstName());
    user.setLastName(pending.getLastName());
    user.setEmail(pending.getEmail());
    user.setPasswordHash(pending.getPasswordHash());
    user.setCreatedAt(LocalDateTime.now());
    user.setVerifiedEmail(true);

    userRepository.save(user);
    pendingRepository.delete(pending);

    return Map.of("message", "Email vérifié avec succès!");
  }

  public AuthResponse verify2FA(String email, String code) {
    email = normalizeEmail(email);
    User user =
        userRepository
            .findByEmail(email)
            .orElseThrow(() -> new InvalidVerificationCodeException("Code invalide"));

    if (user.getVerificationCode() == null) {
      throw new InvalidVerificationCodeException("Code invalide. Reconnectez-vous.");
    }

    if (user.getVerificationCodeExpiresAt().isBefore(LocalDateTime.now())) {
      throw new InvalidVerificationCodeException("Code expiré");
    }

    if (!user.getVerificationCode().equals(code)) {
      // Mauvais code 2FA : on compte la tentative et on invalide le code au-delà du plafond.
      user.setVerificationAttempts(user.getVerificationAttempts() + 1);
      if (user.getVerificationAttempts() >= MAX_VERIFY_ATTEMPTS) {
        user.setVerificationCode(null);
        userRepository.save(user);
        throw new InvalidVerificationCodeException(
            "Trop de tentatives. Reconnectez-vous pour recevoir un nouveau code.");
      }
      userRepository.save(user);
      throw new InvalidVerificationCodeException("Code invalide");
    }

    user.setVerificationCode(null);
    user.setVerificationCodeExpiresAt(null);
    user.setVerificationAttempts(0);

    String token = jwtService.generateToken(user.getEmail());
    String hashedToken = jwtService.hashToken(token, user.getEmail());
    user.setActiveTokenHash(hashedToken);
    userRepository.save(user);

    return new AuthResponse(
        token, user.getUsername(), user.getEmail(), user.getFirstName(), user.getLastName());
  }

  // Renvoi d'un code (inscription ou 2FA), avec le même cooldown / plafond anti-bombing.
  public Map<String, String> resendCode(String email, String mode) {
    email = normalizeEmail(email);
    LocalDateTime now = LocalDateTime.now();

    if ("2fa".equals(mode)) {
      User user =
          userRepository
              .findByEmail(email)
              .orElseThrow(
                  () -> new InvalidVerificationCodeException("Aucune connexion en cours."));
      if (user.getVerificationCode() == null) {
        throw new InvalidVerificationCodeException("Aucun code à renvoyer. Reconnectez-vous.");
      }
      // user_ n'a pas de last_code_sent_at : on dérive le dernier envoi de l'expiration.
      LocalDateTime lastSent = user.getVerificationCodeExpiresAt().minusMinutes(15);
      if (lastSent.plusSeconds(RESEND_COOLDOWN_SECONDS).isAfter(now)) {
        throw new TooManyRequestsException("Patientez avant de redemander un code.");
      }
      String code = generateCode();
      user.setVerificationCode(code);
      user.setVerificationCodeExpiresAt(now.plusMinutes(15));
      user.setVerificationAttempts(0);
      userRepository.save(user);
      emailService.send2FACode(email, code);
      return Map.of("message", "Code renvoyé.");
    }

    // mode "email" (inscription) par défaut
    PendingRegistration pending =
        pendingRepository
            .findByEmail(email)
            .orElseThrow(
                () -> new InvalidVerificationCodeException("Aucune inscription en attente."));

    if (pending.getLastCodeSentAt() != null
        && pending.getLastCodeSentAt().plusSeconds(RESEND_COOLDOWN_SECONDS).isAfter(now)) {
      throw new TooManyRequestsException("Patientez avant de redemander un code.");
    }
    if (pending.getResendCount() >= MAX_RESEND) {
      throw new TooManyRequestsException("Trop de demandes d'envoi. Réessayez plus tard.");
    }

    String code = generateCode();
    pending.setVerificationCode(code);
    pending.setVerificationCodeExpiresAt(now.plusMinutes(15));
    pending.setLastCodeSentAt(now);
    pending.setResendCount(pending.getResendCount() + 1);
    pending.setVerificationAttempts(0);
    pendingRepository.save(pending);
    emailService.sendVerificationCode(email, code);
    return Map.of("message", "Code renvoyé.");
  }

  // Méthodes privées

  private String generateCode() {
    SecureRandom random = new SecureRandom();
    int code = 100000 + random.nextInt(900000);
    return String.valueOf(code);
  }

  private String extractDomain(String email) {
    return email.substring(email.indexOf('@') + 1);
  }

  private String normalizeEmail(String email) {
    return email == null ? null : email.trim().toLowerCase();
  }
}
