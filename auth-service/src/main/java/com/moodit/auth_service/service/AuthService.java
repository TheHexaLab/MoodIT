// Logique métier de l'authentification : inscription, login, 2FA, vérification email et renvoi de
// code.

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
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.UsernameAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import java.time.LocalDateTime;
import java.util.Map;
import com.moodit.auth_service.exception.InvalidVerificationCodeException;
import com.moodit.auth_service.exception.NotFoundException;
import com.moodit.auth_service.exception.TooManyRequestsException;
import com.moodit.auth_service.service.EmailService;
import java.security.SecureRandom;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

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
  // Nombre max de mots de passe erronés au login avant de bloquer le compte (anti brute-force
  // du mot de passe, PAR COMPTE — remplace le rate-limit par IP, l'IP n'étant pas conservée).
  private static final int MAX_LOGIN_ATTEMPTS = 5;
  // Durée du blocage après le plafond de codes erronés : aucun nouveau code n'est émis pendant
  // ce délai, même en se reconnectant (sinon le plafond serait trivialement contournable).
  private static final int LOCKOUT_MINUTES = 15;
  // Réponse unique du register (vrai succès ET email déjà pris) : empêche l'énumération
  // de comptes via le statut/message de retour.
  private static final String REGISTER_OK_MESSAGE =
      "Compte créé! Vérifiez votre email pour activer votre compte.";
  // Réponse unique du "mot de passe oublié" (email existant OU non) : empêche l'énumération
  // de comptes via le statut/message de retour.
  private static final String RESET_REQUESTED_MESSAGE =
      "Si un compte existe pour cet email, un code de réinitialisation vient d'être envoyé.";
  // Générateur cryptographique réutilisé (thread-safe) plutôt qu'instancié à chaque code.
  private static final SecureRandom RANDOM = new SecureRandom();
  // Hash BCrypt bidon (valide, même cost que les vrais) pour égaliser le temps de réponse du
  // login quand l'email est introuvable : sans ce matches factice, l'absence de BCrypt rendrait
  // la réponse plus rapide et trahirait par timing l'existence du compte. Doit être un VRAI
  // hash BCrypt, sinon matches() le rejette aussitôt sans brûler de temps.
  private static final String DUMMY_HASH = new BCryptPasswordEncoder().encode("timing-equalizer");

  // Register
  //
  // NON @Transactional volontairement : la récupération de la course concurrente (catch de
  // DataIntegrityViolationException puis re-requête existsBy...) ne fonctionne QUE si chaque
  // appel repository tourne dans sa propre transaction. Sous une transaction unique, le save en
  // échec abandonne la transaction Postgres (la re-requête échouerait) ou diffère l'exception au
  // commit (le catch deviendrait mort). La course est de toute façon fermée par la contrainte
  // UNIQUE en BD, pas par @Transactional (inopérant contre un check-then-insert en READ COMMITTED).
  public Map<String, String> register(RegisterRequest request) {

    // L'email est insensible à la casse : on normalise pour éviter les doublons
    // et les échecs de login dus à une casse différente.
    String email = normalizeEmail(request.getEmail());

    // Re-register sur un email déjà en attente : on réutilise la ligne et on renvoie un code
    PendingRegistration existing = pendingRepository.findByEmail(email).orElse(null);

    // Username pris par un compte confirmé, ou par un AUTRE pending (autre email) ?
    // 409 conservé volontairement : un username est semi-public et le formulaire
    // d'inscription doit pouvoir signaler qu'il faut en choisir un autre.
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

    // Seuls les domaines d'établissements autorisés (ou leurs sous-domaines) peuvent s'inscrire.
    // 403 conservé : la liste des domaines d'établissements autorisés est publique.
    if (!isAllowedDomain(extractDomain(email))) {
      throw new DomainNotAllowedException();
    }

    // Anti-énumération d'email : si l'email appartient déjà à un compte CONFIRMÉ, on ne
    // révèle PAS son existence par une 409. On renvoie EXACTEMENT la même réponse qu'une
    // vraie inscription et on prévient le propriétaire hors-bande (email dédié).
    // Ce test vient APRÈS username/domaine, sinon un username connu-pris servirait d'oracle
    // (200 = email pris et court-circuité, 409 = email libre puis username rejeté).
    if (userRepository.existsByEmail(email)) {
      emailService.sendAccountAlreadyExists(email);
      return Map.of("message", REGISTER_OK_MESSAGE);
    }

    LocalDateTime now = LocalDateTime.now();

    // Anti-bombing : sur un renvoi, on impose un délai entre deux courriels et un plafond total.
    if (existing != null) {
      enforceResendCooldown(existing.getLastCodeSentAt(), now);
      enforceResendCap(existing.getResendCount());
    }

    PendingRegistration pending = existing != null ? existing : new PendingRegistration();

    String code = generateCode();
    pending.setUsername(request.getUsername());
    pending.setFirstName(request.getFirstName());
    pending.setLastName(request.getLastName());
    pending.setEmail(email);
    pending.setPasswordHash(passwordEncoder.encode(peppered(request.getPassword())));
    pending.setVerificationCode(code);
    pending.setVerificationCodeExpiresAt(now.plusMinutes(15));
    pending.setLastCodeSentAt(now);
    pending.setVerificationAttempts(0);
    if (existing != null) {
      pending.setResendCount(pending.getResendCount() + 1);
    }

    // Les contrôles d'unicité ci-dessus ne suffisent pas en concurrence : entre la vérif et
    // ce save, un autre register peut avoir pris le même username/email. Les contraintes UNIQUE
    // (username, email) de pending_registration ferment la course ; on traduit la violation
    // selon la colonne en cause, en restant cohérent avec l'anti-énumération du point 6.
    try {
      pendingRepository.save(pending);
    } catch (DataIntegrityViolationException e) {
      if (userRepository.existsByUsername(request.getUsername())
          || pendingRepository.existsByUsername(request.getUsername())) {
        throw new UsernameAlreadyUsedException();
      }
      // Sinon : collision sur l'email pending. On ne révèle pas l'existence (réponse générique)
      // et on prévient le propriétaire hors-bande, comme pour un email déjà confirmé.
      emailService.sendAccountAlreadyExists(email);
      return Map.of("message", REGISTER_OK_MESSAGE);
    }

    emailService.sendVerificationCode(email, code);

    return Map.of("message", REGISTER_OK_MESSAGE);
  }

  // Login

  public AuthResponse login(LoginRequest request) {

    // Trouver le user (email insensible à la casse)
    String email = normalizeEmail(request.getEmail());
    // Un compte n'existe dans User_ qu'après vérification de l'email : être ici
    // suffit donc à prouver que l'email est confirmé (pas de flag dédié).
    User user = userRepository.findByEmail(email).orElse(null);
    if (user == null) {
      // Compte introuvable : on exécute quand même un BCrypt (sur un hash bidon) pour que le
      // temps de réponse soit indiscernable d'un mauvais mot de passe sur un compte existant.
      passwordEncoder.matches(peppered(request.getPassword()), DUMMY_HASH);
      throw new InvalidCredentialsException();
    }

    LocalDateTime now = LocalDateTime.now();

    // Verrou de connexion : après trop de mots de passe erronés, le compte est bloqué un
    // moment. Le comptage est PAR COMPTE (l'IP n'est jamais lue ni mise en mémoire).
    if (user.getLoginLockedUntil() != null && user.getLoginLockedUntil().isAfter(now)) {
      throw new TooManyRequestsException(
          "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
    }

    // Vérifier le mot de passe ; chaque échec est compté pour déclencher le verrou.
    if (!passwordEncoder.matches(peppered(request.getPassword()), user.getPasswordHash())) {
      user.setFailedLoginAttempts(user.getFailedLoginAttempts() + 1);
      if (user.getFailedLoginAttempts() >= MAX_LOGIN_ATTEMPTS) {
        user.setLoginLockedUntil(now.plusMinutes(LOCKOUT_MINUTES));
      }
      userRepository.save(user);
      throw new InvalidCredentialsException();
    }

    // Mot de passe valide. Blocage 2FA actif (trop de codes erronés) : on refuse d'émettre un
    // nouveau code, sinon le plafond serait contournable en se reconnectant. Ce contrôle vient
    // AVANT toute mutation, pour ne pas réinitialiser un compteur qui ne serait jamais persisté
    // (on `throw` avant le `save()`). Il reste APRÈS la vérification du mot de passe pour ne pas
    // divulguer l'état du verrou sans prouver les identifiants.
    if (user.getVerificationLockedUntil() != null
        && user.getVerificationLockedUntil().isAfter(now)) {
      throw new TooManyRequestsException(
          "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
    }

    // On réinitialise le compteur d'échecs de mot de passe (mot de passe correct). Le token
    // n'est pas émis tout de suite, la 2FA doit d'abord être validée (token généré dans verify2FA()).
    user.setFailedLoginAttempts(0);
    user.setLoginLockedUntil(null);

    // Générer et envoyer le code 2FA
    String code = generateCode();
    user.setVerificationCode(code);
    user.setVerificationCodeExpiresAt(now.plusMinutes(15));
    user.setVerificationAttempts(0);
    user.setVerificationLockedUntil(null);
    user.setLastCodeSentAt(now);
    userRepository.save(user);

    emailService.send2FACode(email, code);

    return authResponseFor(user, null);
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

    // Aucun token actif (jamais connecté, ou révoqué au logout) : rien à comparer.
    // On rejette explicitement plutôt que de comparer contre la chaîne littérale "null".
    String activeTokenHash = user.getActiveTokenHash();
    if (activeTokenHash == null) {
      return false;
    }

    // Vérifier le hash du token. Comparaison à temps constant pour ne pas révéler,
    // par le temps de réponse, à quel préfixe deux hash diffèrent.
    String hashedToken = jwtService.hashToken(token, email);
    return MessageDigest.isEqual(
        hashedToken.getBytes(StandardCharsets.UTF_8),
        activeTokenHash.getBytes(StandardCharsets.UTF_8));
  }

  public void logout(String token) {
    // Entrée vide : rien à révoquer côté serveur.
    if (token == null || token.isBlank()) {
      return;
    }

    String email;
    try {
      // JWT illisible/invalide : logout idempotent, on sort sans erreur.
      email = jwtService.extractEmail(token);
    } catch (Exception e) {
      return;
    }

    // Email absent du token : aucun utilisateur à cibler.
    if (email == null || email.isBlank()) {
      return;
    }

    User user = userRepository.findByEmail(email).orElse(null);
    // Token pointant vers un compte inexistant : on ignore silencieusement.
    if (user == null) {
      return;
    }

    // Révocation de la session active : tout JWT précédemment émis devient invalide au validate().
    user.setActiveTokenHash(null);
    userRepository.save(user);
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
            .orElseThrow(() -> new NotFoundException("Inscription en attente non trouvée"));

    User user = new User();
    user.setUsername(pending.getUsername());
    user.setFirstName(pending.getFirstName());
    user.setLastName(pending.getLastName());
    user.setEmail(pending.getEmail());
    user.setPasswordHash(pending.getPasswordHash());
    user.setCreatedAt(LocalDateTime.now());

    userRepository.save(user);
    pendingRepository.delete(pending);

    return Map.of("message", "Email vérifié pour " + username);
  }

  public AuthResponse verifyEmail(String email, String code) {
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
        throw new InvalidVerificationCodeException("Trop de tentatives. Demandez un nouveau code.");
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

    // Auto-login : le code email prouve la possession de la boîte, il tient lieu de 2FA pour
    // cette première session. On mémorise le token actif AVANT le save pour n'avoir qu'un
    // seul aller-retour BD (même hash de session que verify2FA, via issueToken()).
    String token = issueToken(user);

    // Même course possible ici (deux pendings au même username/email promus en même temps) :
    // User_.username et User_.email sont UNIQUE, on traduit la violation en 409 plutôt qu'un 500.
    try {
      userRepository.save(user);
    } catch (DataIntegrityViolationException e) {
      if (userRepository.existsByUsername(pending.getUsername())) {
        throw new UsernameAlreadyUsedException();
      }
      throw new EmailAlreadyUsedException();
    }
    pendingRepository.delete(pending);

    return authResponseFor(user, token);
  }

  // PAS @Transactional : le chemin "mauvais code" incrémente le compteur de tentatives puis
  // `throw`. Sous une transaction englobante, le rollback par défaut (sur RuntimeException)
  // annulerait cet incrément ET le verrou -> l'anti-brute-force ne se déclencherait jamais.
  // Chaque save() doit committer indépendamment.
  public AuthResponse verify2FA(String email, String code) {
    email = normalizeEmail(email);
    User user =
        userRepository
            .findByEmail(email)
            .orElseThrow(() -> new InvalidVerificationCodeException("Code invalide"));

    LocalDateTime now = LocalDateTime.now();
    // Blocage actif : on refuse toute tentative tant que le délai n'est pas écoulé.
    if (user.getVerificationLockedUntil() != null
        && user.getVerificationLockedUntil().isAfter(now)) {
      throw new TooManyRequestsException(
          "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
    }

    if (user.getVerificationCode() == null) {
      throw new InvalidVerificationCodeException("Code invalide. Reconnectez-vous.");
    }

    if (user.getVerificationCodeExpiresAt().isBefore(now)) {
      throw new InvalidVerificationCodeException("Code expiré");
    }

    if (!user.getVerificationCode().equals(code)) {
      // Mauvais code 2FA : on compte la tentative et, au plafond, on invalide le code ET on pose
      // un blocage temporel — le verrou survit à une reconnexion (vérifié dans login()).
      user.setVerificationAttempts(user.getVerificationAttempts() + 1);
      if (user.getVerificationAttempts() >= MAX_VERIFY_ATTEMPTS) {
        user.setVerificationCode(null);
        user.setVerificationLockedUntil(now.plusMinutes(LOCKOUT_MINUTES));
        userRepository.save(user);
        throw new TooManyRequestsException(
            "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
      }
      userRepository.save(user);
      throw new InvalidVerificationCodeException("Code invalide");
    }

    user.setVerificationCode(null);
    user.setVerificationCodeExpiresAt(null);
    user.setVerificationAttempts(0);
    user.setVerificationLockedUntil(null);

    String token = issueToken(user);
    userRepository.save(user);

    return authResponseFor(user, token);
  }

  // Renvoi d'un code (inscription ou 2FA), avec le même cooldown / plafond anti-bombing.
  @Transactional
  public Map<String, String> resendCode(String email, String mode) {
    email = normalizeEmail(email);
    LocalDateTime now = LocalDateTime.now();

    if ("2fa".equals(mode)) {
      User user =
          userRepository
              .findByEmail(email)
              .orElseThrow(
                  () -> new InvalidVerificationCodeException("Aucune connexion en cours."));
      if (user.getVerificationLockedUntil() != null
          && user.getVerificationLockedUntil().isAfter(now)) {
        throw new TooManyRequestsException(
            "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
      }
      if (user.getVerificationCode() == null) {
        throw new InvalidVerificationCodeException("Aucun code à renvoyer. Reconnectez-vous.");
      }
      enforceResendCooldown(user.getLastCodeSentAt(), now);
      String code = generateCode();
      user.setVerificationCode(code);
      user.setVerificationCodeExpiresAt(now.plusMinutes(15));
      user.setVerificationAttempts(0);
      user.setLastCodeSentAt(now);
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

    enforceResendCooldown(pending.getLastCodeSentAt(), now);
    enforceResendCap(pending.getResendCount());

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

  // Mot de passe oublié : envoi d'un code de réinitialisation.
  //
  // Anti-énumération : la réponse est TOUJOURS générique (jamais de 429/404 qui révélerait
  // l'existence de l'email). Le cooldown et le verrou sont appliqués en silence (on n'envoie
  // simplement pas de courriel), sans jamais lever d'exception qui trahirait un compte.
  public Map<String, String> forgotPassword(String email) {
    email = normalizeEmail(email);
    // Anti-énumération (timing) : on paie le coût CPU de génération du code de façon UNIFORME,
    // que le compte existe ou non, pour ne pas exposer d'écart mesurable au chemin "not found".
    // Résidu accepté : le save() indexé + l'envoi d'email ASYNC (non bloquant) du chemin
    // "compte existant", dominés par la latence réseau/mail.
    String code = generateCode();
    User user = userRepository.findByEmail(email).orElse(null);
    if (user == null) {
      return Map.of("message", RESET_REQUESTED_MESSAGE);
    }

    LocalDateTime now = LocalDateTime.now();

    // Verrou actif (trop de codes erronés) : on n'émet pas de nouveau code, sinon le
    // plafond serait contournable — mais en silence (pas de 429, anti-énumération).
    if (user.getResetLockedUntil() != null && user.getResetLockedUntil().isAfter(now)) {
      return Map.of("message", RESET_REQUESTED_MESSAGE);
    }

    // Anti-bombing : un seul courriel par fenêtre de cooldown, en silence.
    if (user.getResetLastSentAt() != null
        && user.getResetLastSentAt().plusSeconds(RESEND_COOLDOWN_SECONDS).isAfter(now)) {
      return Map.of("message", RESET_REQUESTED_MESSAGE);
    }

    user.setResetCode(code);
    user.setResetCodeExpiresAt(now.plusMinutes(15));
    user.setResetAttempts(0);
    user.setResetLastSentAt(now);
    userRepository.save(user);

    emailService.sendPasswordResetCode(email, code);
    return Map.of("message", RESET_REQUESTED_MESSAGE);
  }

  // Réinitialisation effective. PAS @Transactional : comme verify2FA, le chemin "mauvais
  // code" incrémente le compteur puis `throw` — chaque save() doit committer indépendamment,
  // sinon le rollback annulerait l'incrément et l'anti-brute-force ne se déclencherait jamais.
  public Map<String, String> resetPassword(String email, String code, String newPassword) {
    email = normalizeEmail(email);
    // Compte introuvable : même message générique que "mauvais code" (pas d'oracle).
    User user =
        userRepository
            .findByEmail(email)
            .orElseThrow(() -> new InvalidVerificationCodeException("Code invalide"));

    LocalDateTime now = LocalDateTime.now();

    if (user.getResetLockedUntil() != null && user.getResetLockedUntil().isAfter(now)) {
      throw new TooManyRequestsException(
          "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
    }

    // Pas de code actif : on groupe l'expiry null avec le code null (état incohérent = pas de
    // code valide) pour éviter un NPE 500 qui serait un oracle (500 vs 4xx générique).
    if (user.getResetCode() == null || user.getResetCodeExpiresAt() == null) {
      throw new InvalidVerificationCodeException("Code invalide. Demandez un nouveau code.");
    }

    if (user.getResetCodeExpiresAt().isBefore(now)) {
      throw new InvalidVerificationCodeException("Code expiré");
    }

    if (!user.getResetCode().equals(code)) {
      // Mauvais code : on compte la tentative et, au plafond, on invalide le code et on pose
      // un verrou temporel (anti brute-force des 6 chiffres).
      user.setResetAttempts(user.getResetAttempts() + 1);
      if (user.getResetAttempts() >= MAX_VERIFY_ATTEMPTS) {
        user.setResetCode(null);
        user.setResetLockedUntil(now.plusMinutes(LOCKOUT_MINUTES));
        userRepository.save(user);
        throw new TooManyRequestsException(
            "Trop de tentatives. Réessayez dans " + LOCKOUT_MINUTES + " minutes.");
      }
      userRepository.save(user);
      throw new InvalidVerificationCodeException("Code invalide");
    }

    // Code valide : on pose le nouveau mot de passe (peppered + BCrypt, comme au register).
    user.setPasswordHash(passwordEncoder.encode(peppered(newPassword)));

    // Nettoyage des champs de reset.
    user.setResetCode(null);
    user.setResetCodeExpiresAt(null);
    user.setResetAttempts(0);
    user.setResetLockedUntil(null);

    // Sécurité : un changement de mot de passe invalide les sessions existantes (le token
    // actif cesse d'être reconnu par /auth/validate) et lève le verrou de login — la personne
    // a prouvé qu'elle contrôle l'email, on la laisse se reconnecter immédiatement.
    user.setActiveTokenHash(null);
    user.setFailedLoginAttempts(0);
    user.setLoginLockedUntil(null);
    userRepository.save(user);

    return Map.of("message", "Mot de passe réinitialisé avec succès.");
  }

  // Méthodes privées

  // Émet un JWT pour l'utilisateur et mémorise son hash comme token actif (ce qui invalide toute
  // session précédente). L'appelant persiste ensuite l'utilisateur. Partagé par verify2FA (login)
  // et verifyEmail (auto-login après inscription).
  private String issueToken(User user) {
    String token = jwtService.generateToken(user.getEmail());
    user.setActiveTokenHash(jwtService.hashToken(token, user.getEmail()));
    return token;
  }

  // Construit la réponse d'authentification à partir de l'utilisateur (mapping d'identité
  // mutualisé entre login, verify2FA et verifyEmail). token null tant que la session n'est pas émise.
  private AuthResponse authResponseFor(User user, String token) {
    return new AuthResponse(
        token, user.getUsername(), user.getEmail(), user.getFirstName(), user.getLastName());
  }

  // BCrypt ignore tout au-delà de 72 octets. On pré-hache donc le mot de passe avec le pepper
  // via HMAC-SHA256 (sortie de taille fixe, 44 caractères en Base64) : le pepper est entièrement
  // pris en compte et aucun mot de passe long n'est silencieusement tronqué.
  private String peppered(String rawPassword) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(pepper.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] h = mac.doFinal(rawPassword.getBytes(StandardCharsets.UTF_8));
      return Base64.getEncoder().encodeToString(h);
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("HMAC indisponible", e);
    }
  }

  private String generateCode() {
    int code = 100000 + RANDOM.nextInt(900000);
    return String.valueOf(code);
  }

  // Anti-bombing partagé (register / resendCode) : délai minimal entre deux envois de code.
  private void enforceResendCooldown(LocalDateTime lastCodeSentAt, LocalDateTime now) {
    if (lastCodeSentAt != null
        && lastCodeSentAt.plusSeconds(RESEND_COOLDOWN_SECONDS).isAfter(now)) {
      throw new TooManyRequestsException(
          "Un code vous a déjà été envoyé. Patientez avant d'en redemander un.");
    }
  }

  // Anti-bombing partagé : plafond total de renvois pour un même email.
  private void enforceResendCap(int resendCount) {
    if (resendCount >= MAX_RESEND) {
      throw new TooManyRequestsException(
          "Trop de demandes d'envoi pour cet email. Réessayez plus tard.");
    }
  }

  private String extractDomain(String email) {
    return email.substring(email.indexOf('@') + 1);
  }

  // Autorise le domaine exact OU un sous-domaine d'un domaine d'établissement autorisé.
  // On remonte label par label en testant l'égalité EXACTE à chaque frontière de label :
  // "etu.usherbrooke.ca" matche "usherbrooke.ca", mais jamais "evilusherbrooke.ca" ni
  // "usherbrooke.ca.attaquant.com" (aucune comparaison de suffixe naïve, donc pas de faille).
  private boolean isAllowedDomain(String domain) {
    String candidate = domain;
    while (candidate.contains(".")) {
      if (establishmentRepository.existsByDomainEmail(candidate)) {
        return true;
      }
      candidate = candidate.substring(candidate.indexOf('.') + 1);
    }
    return false;
  }

  private String normalizeEmail(String email) {
    return email == null ? null : email.trim().toLowerCase();
  }
}
