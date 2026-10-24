package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.auth_service.config.DevFixedTwoFactorCode;
import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.exception.DomainNotAllowedException;
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import com.moodit.auth_service.exception.InvalidVerificationCodeException;
import com.moodit.auth_service.exception.NotFoundException;
import com.moodit.auth_service.exception.TooManyRequestsException;
import com.moodit.auth_service.exception.UsernameAlreadyUsedException;
import com.moodit.auth_service.model.PendingRegistration;
import com.moodit.auth_service.model.User;
import com.moodit.auth_service.repository.EstablishmentRepository;
import com.moodit.auth_service.repository.PendingRegistrationRepository;
import com.moodit.auth_service.repository.UserRepository;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
class AuthServiceTest {

  @Mock private UserRepository userRepository;
  @Mock private PendingRegistrationRepository pendingRepository;
  @Mock private EstablishmentRepository establishmentRepository;
  @Mock private JwtService jwtService;
  @Mock private PasswordEncoder passwordEncoder;
  @Mock private EmailService emailService;
  // Mock = Optional.empty() par défaut → code 2FA aléatoire, comme en prod.
  @Mock private DevFixedTwoFactorCode devFixedTwoFactorCode;

  @InjectMocks private AuthService authService;

  private static final String PEPPER = "test-pepper";

  @BeforeEach
  void setUp() {
    ReflectionTestUtils.setField(authService, "pepper", PEPPER);
  }

  // Réplique du pré-hash HMAC-SHA256 fait par AuthService.peppered() : permet de stubber
  // encode()/matches() avec la valeur réellement transmise à BCrypt.
  private static String peppered(String rawPassword) {
    try {
      javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
      mac.init(
          new javax.crypto.spec.SecretKeySpec(
              PEPPER.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
      byte[] h = mac.doFinal(rawPassword.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      return java.util.Base64.getEncoder().encodeToString(h);
    } catch (java.security.GeneralSecurityException e) {
      throw new IllegalStateException(e);
    }
  }

  private RegisterRequest registerRequest() {
    RegisterRequest r = new RegisterRequest();
    r.setUsername("rkarine");
    r.setFirstName("Karine");
    r.setLastName("Roussel");
    r.setEmail("Karine.Roussel@USHERBROOKE.ca");
    r.setPassword("Sup3rPass!");
    return r;
  }

  // ----- register -----

  @Test
  void register_normalizesEmail_andPersistsPending() {
    RegisterRequest req = registerRequest();
    when(userRepository.existsByEmail("karine.roussel@usherbrooke.ca")).thenReturn(false);
    when(pendingRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");

    authService.register(req);

    ArgumentCaptor<PendingRegistration> captor =
        ArgumentCaptor.forClass(PendingRegistration.class);
    verify(pendingRepository).save(captor.capture());
    PendingRegistration saved = captor.getValue();
    assertThat(saved.getEmail()).isEqualTo("karine.roussel@usherbrooke.ca"); // minuscules
    assertThat(saved.getPasswordHash()).isEqualTo("hashed");
    assertThat(saved.getVerificationCode()).hasSize(44); // HMAC Base64, jamais le code en clair
    verify(emailService).sendVerificationCode(eq("karine.roussel@usherbrooke.ca"), anyString());
  }

  @Test
  void register_emailAlreadyUsed_returnsGenericSuccess_andNotifiesOwner() {
    // Anti-énumération : un email déjà pris ne doit PAS renvoyer 409, mais la même réponse
    // qu'un vrai succès, en prévenant le propriétaire hors-bande.
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail("karine.roussel@usherbrooke.ca"))
        .thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail("karine.roussel@usherbrooke.ca")).thenReturn(true);

    Map<String, String> res = authService.register(req);

    assertThat(res.get("message")).contains("Vérifiez votre email");
    verify(emailService).sendAccountAlreadyExists("karine.roussel@usherbrooke.ca");
    // Aucune inscription en attente créée, aucun code de vérification envoyé.
    verify(pendingRepository, never()).save(any());
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void register_usernameAlreadyUsed_throws() {
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
  }

  @Test
  void register_domainNotAllowed_throws() {
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(userRepository.existsByUsername(anyString())).thenReturn(false);
    when(pendingRepository.findByUsername(anyString())).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(false);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(DomainNotAllowedException.class);
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void register_subdomainOfAllowedDomain_isAccepted() {
    // etu.usherbrooke.ca n'est pas enregistré, mais usherbrooke.ca l'est -> sous-domaine accepté.
    RegisterRequest req = registerRequest();
    req.setEmail("Karine.Roussel@etu.usherbrooke.ca");
    when(pendingRepository.findByEmail("karine.roussel@etu.usherbrooke.ca"))
        .thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("etu.usherbrooke.ca")).thenReturn(false);
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail("karine.roussel@etu.usherbrooke.ca")).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");

    authService.register(req);

    verify(pendingRepository).save(any(PendingRegistration.class));
  }

  @Test
  void register_lookAlikeDomain_isRejected() {
    // evilusherbrooke.ca n'est PAS un sous-domaine de usherbrooke.ca -> refusé (pas de suffixe naïf).
    RegisterRequest req = registerRequest();
    req.setEmail("attacker@evilusherbrooke.ca");
    when(pendingRepository.findByEmail("attacker@evilusherbrooke.ca")).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("evilusherbrooke.ca")).thenReturn(false);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(DomainNotAllowedException.class);
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void register_resendBeforeCooldown_throwsTooManyRequests() {
    RegisterRequest req = registerRequest();
    PendingRegistration existing = new PendingRegistration();
    existing.setId(1);
    existing.setLastCodeSentAt(LocalDateTime.now()); // tout juste envoyé
    existing.setResendCount(0);

    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.of(existing));
    when(userRepository.existsByUsername(anyString())).thenReturn(false);
    when(pendingRepository.findByUsername(anyString())).thenReturn(Optional.of(existing));
    when(establishmentRepository.existsByDomainEmail(anyString())).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(TooManyRequestsException.class);
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void register_resendCapReached_throwsTooManyRequests() {
    RegisterRequest req = registerRequest();
    PendingRegistration existing = new PendingRegistration();
    existing.setId(1);
    existing.setLastCodeSentAt(LocalDateTime.now().minusMinutes(5)); // cooldown passé
    existing.setResendCount(5); // plafond atteint

    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.of(existing));
    when(userRepository.existsByUsername(anyString())).thenReturn(false);
    when(pendingRepository.findByUsername(anyString())).thenReturn(Optional.of(existing));
    when(establishmentRepository.existsByDomainEmail(anyString())).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(TooManyRequestsException.class);
  }

  @Test
  void register_concurrentUsernameRace_mapsTo409() {
    // Le save échoue sur la contrainte UNIQUE (course) ; à la re-vérif le username existe.
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");
    when(pendingRepository.save(any()))
        .thenThrow(new DataIntegrityViolationException("duplicate username"));
    // false au contrôle initial, true à la re-vérif dans le catch.
    when(userRepository.existsByUsername("rkarine")).thenReturn(false, true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void register_concurrentEmailRace_returnsGenericSuccess_andNotifiesOwner() {
    // Le save échoue sur la contrainte UNIQUE de l'email : on reste sur la réponse générique
    // (anti-énumération) et on prévient le propriétaire, sans révéler l'existence.
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");
    when(pendingRepository.save(any()))
        .thenThrow(new DataIntegrityViolationException("duplicate email"));

    Map<String, String> res = authService.register(req);

    assertThat(res.get("message")).contains("Vérifiez votre email");
    verify(emailService).sendAccountAlreadyExists("karine.roussel@usherbrooke.ca");
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void verifyEmail_concurrentUsernameRace_mapsTo409() {
    // Insert User_ rejeté par la contrainte UNIQUE (course) ; le username existe à la re-vérif.
    when(pendingRepository.findByEmail("karine.roussel@usherbrooke.ca"))
        .thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(userRepository.existsByUsername("rkarine")).thenReturn(false, true);
    when(userRepository.save(any()))
        .thenThrow(new DataIntegrityViolationException("duplicate username"));

    assertThatThrownBy(
            () -> authService.verifyEmail("karine.roussel@usherbrooke.ca", "123456"))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(pendingRepository, never()).delete(any());
  }

  // ----- login -----

  private User verifiedUser() {
    User u = new User();
    u.setUsername("rkarine");
    u.setEmail("karine.roussel@usherbrooke.ca");
    u.setFirstName("Karine");
    u.setLastName("Roussel");
    u.setPasswordHash("storedHash");
    return u;
  }

  @Test
  void login_userNotFound_throwsInvalidCredentials() {
    LoginRequest req = new LoginRequest();
    req.setEmail("nobody@usherbrooke.ca");
    req.setPassword("x");
    when(userRepository.findByEmail("nobody@usherbrooke.ca")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class);
    // Anti-timing : un BCrypt factice est exécuté même quand le compte est introuvable,
    // pour que la réponse ne soit pas plus rapide qu'un mauvais mot de passe.
    verify(passwordEncoder).matches(eq(peppered("x")), anyString());
  }

  @Test
  void login_wrongPassword_throwsInvalidCredentials() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("wrong");
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(verifiedUser()));
    when(passwordEncoder.matches(peppered("wrong"), "storedHash")).thenReturn(false);

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class);
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  @Test
  void login_success_sends2FA_andReturnsNullToken() {
    LoginRequest req = new LoginRequest();
    req.setEmail("Karine.Roussel@USHERBROOKE.ca"); // casse mixte
    req.setPassword("Sup3rPass!");
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca"))
        .thenReturn(Optional.of(verifiedUser()));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    AuthResponse res = authService.login(req);

    assertThat(res.getToken()).isNull(); // 2FA requise avant l'émission du token
    verify(emailService).send2FACode(eq("karine.roussel@usherbrooke.ca"), anyString());
    verify(userRepository).save(any(User.class));
  }

  @Test
  void login_withDevFixedCode_storesTheFixedCode_andSendsNoEmail() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("Sup3rPass!");
    User user = verifiedUser();
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.of(user));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);
    when(devFixedTwoFactorCode.code()).thenReturn(Optional.of("000000"));

    authService.login(req);

    verify(emailService, never()).send2FACode(anyString(), anyString());
    // Toujours HACHÉ en BD, même en mode dev (le parcours reste celui de la prod).
    assertThat(user.getVerificationCode()).isEqualTo(peppered("000000"));
  }

  @Test
  void login_whenActiveCodeExists_reusesSession_withoutReemittingNorResettingAttempts() {
    // HIGH #1 : un code 2FA valide est déjà en circulation. Une reconnexion ne doit ni renvoyer
    // un nouveau code ni remettre le compteur de tentatives à zéro (sinon le plafond par-code
    // serait contournable avec un mot de passe volé).
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("Sup3rPass!");
    User u = verifiedUser();
    String storedCode = peppered("111111");
    u.setVerificationCode(storedCode);
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10)); // encore valide
    u.setVerificationAttempts(3); // essais déjà consommés sur ce code
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    AuthResponse res = authService.login(req);

    assertThat(res.getToken()).isNull(); // 2FA toujours requise
    verify(emailService, never()).send2FACode(anyString(), anyString()); // pas de réémission
    assertThat(u.getVerificationAttempts()).isEqualTo(3); // compteur préservé
    assertThat(u.getVerificationCode()).isEqualTo(storedCode); // code inchangé
  }

  @Test
  void login_fifthWrongPassword_locksAccount() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("wrong");
    User u = verifiedUser();
    u.setFailedLoginAttempts(4); // la prochaine tentative ratée atteint le plafond
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("wrong"), "storedHash")).thenReturn(false);

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class);
    assertThat(u.getLoginLockedUntil()).isAfter(LocalDateTime.now());
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  @Test
  void login_whenAccountLocked_returnsGenericInvalidCredentials_andEqualizesTiming() {
    // HIGH #2 (anti-énumération) : un compte verrouillé ne doit PAS renvoyer un 429 distinctif —
    // même 401 générique qu'un mauvais mot de passe, + un BCrypt bidon pour égaliser le temps.
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("Sup3rPass!");
    User u = verifiedUser();
    u.setLoginLockedUntil(LocalDateTime.now().plusMinutes(10)); // verrou encore actif
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class); // plus de TooManyRequests
    verify(passwordEncoder).matches(anyString(), anyString()); // BCrypt bidon exécuté (timing)
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  // ----- verifyEmail -----

  private PendingRegistration validPending() {
    PendingRegistration p = new PendingRegistration();
    p.setUsername("rkarine");
    p.setFirstName("Karine");
    p.setLastName("Roussel");
    p.setEmail("karine.roussel@usherbrooke.ca");
    p.setPasswordHash("hashed");
    // Le service ne stocke que le HMAC du code : on reproduit ce hachage dans le setup.
    p.setVerificationCode(peppered("123456"));
    p.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    p.setVerificationAttempts(0);
    return p;
  }

  @Test
  void verifyEmail_success_movesToUser_andDeletesPending() {
    when(pendingRepository.findByEmail("karine.roussel@usherbrooke.ca"))
        .thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(userRepository.existsByUsername(anyString())).thenReturn(false);

    authService.verifyEmail("karine.roussel@usherbrooke.ca", "123456");

    ArgumentCaptor<User> captor = ArgumentCaptor.forClass(User.class);
    verify(userRepository).save(captor.capture());
    User created = captor.getValue();
    assertThat(created.getPasswordHash()).isEqualTo("hashed");
    verify(pendingRepository).delete(any(PendingRegistration.class));
  }

  @Test
  void verifyEmail_wrongCode_incrementsAttempts_andDoesNotCreateUser() {
    PendingRegistration p = validPending();
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.verifyEmail("karine.roussel@usherbrooke.ca", "000000"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(p.getVerificationAttempts()).isEqualTo(1);
    verify(userRepository, never()).save(any());
  }

  @Test
  void verifyEmail_wrongCodeAtCap_invalidatesCode() {
    PendingRegistration p = validPending();
    p.setVerificationAttempts(4); // la 5e tentative atteint le plafond
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.verifyEmail("karine.roussel@usherbrooke.ca", "000000"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(p.getVerificationCode()).isNull(); // code invalidé
  }

  @Test
  void verifyEmail_expiredCode_throws() {
    PendingRegistration p = validPending();
    p.setVerificationCodeExpiresAt(LocalDateTime.now().minusMinutes(1));
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.verifyEmail("karine.roussel@usherbrooke.ca", "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class);
  }

  // ----- validate -----

  @Test
  void validate_nullActiveTokenHash_returnsFalse_withoutHashing() {
    // Fix B4 : aucun token actif (jamais connecté / après logout) -> false, sans comparer
    // contre la chaîne littérale "null".
    User u = verifiedUser();
    u.setActiveTokenHash(null);
    when(jwtService.isTokenValid("jwt-token")).thenReturn(true);
    when(jwtService.extractEmail("jwt-token")).thenReturn("karine.roussel@usherbrooke.ca");
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.of(u));

    assertThat(authService.validate("jwt-token")).isFalse();
    verify(jwtService, never()).hashToken(anyString(), anyString());
  }

  @Test
  void validate_matchingHash_returnsTrue() {
    User u = verifiedUser();
    u.setActiveTokenHash("token-hash");
    when(jwtService.isTokenValid("jwt-token")).thenReturn(true);
    when(jwtService.extractEmail("jwt-token")).thenReturn("karine.roussel@usherbrooke.ca");
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.of(u));
    when(jwtService.hashToken("jwt-token", "karine.roussel@usherbrooke.ca"))
        .thenReturn("token-hash");

    assertThat(authService.validate("jwt-token")).isTrue();
  }

  @Test
  void validate_invalidSignature_returnsFalse() {
    when(jwtService.isTokenValid("bad")).thenReturn(false);

    assertThat(authService.validate("bad")).isFalse();
    verify(userRepository, never()).findByEmail(anyString());
  }

  @Test
  void logout_validToken_clearsActiveTokenHash() {
    // Vérifie qu'un logout avec token valide supprime le hash de session active et persiste l'utilisateur.
    User u = verifiedUser();
    u.setActiveTokenHash("token-hash");
    when(jwtService.extractEmail("jwt-token")).thenReturn("karine.roussel@usherbrooke.ca");
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.of(u));

    authService.logout("jwt-token");

    assertThat(u.getActiveTokenHash()).isNull();
    verify(userRepository).save(u);
  }

  @Test
  void logout_invalidToken_doesNothing() {
    authService.logout("not-a-token");

    verify(userRepository, never()).save(any());
  }

  // ----- verifyDev -----

  @Test
  void verifyDev_pendingNotFound_throwsNotFound() {
    // Renvoie une 404 gérée (NotFoundException) au lieu d'un RuntimeException brut (500).
    when(userRepository.existsByUsername("ghost")).thenReturn(false);
    when(pendingRepository.findByUsername("ghost")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.verifyDev("ghost"))
        .isInstanceOf(NotFoundException.class);
  }

  // ----- verify2FA -----

  @Test
  void verify2FA_success_returnsToken_andStoresHash() {
    User u = verifiedUser();
    u.setVerificationCode(peppered("123456"));
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(jwtService.generateToken("karine.roussel@usherbrooke.ca")).thenReturn("jwt-token");
    when(jwtService.hashToken("jwt-token", "karine.roussel@usherbrooke.ca")).thenReturn("token-hash");

    AuthResponse res = authService.verify2FA("karine.roussel@usherbrooke.ca", "123456");

    assertThat(res.getToken()).isEqualTo("jwt-token");
    assertThat(u.getActiveTokenHash()).isEqualTo("token-hash");
    assertThat(u.getVerificationCode()).isNull();
  }

  @Test
  void verify2FA_wrongCode_incrementsAttempts() {
    User u = verifiedUser();
    u.setVerificationCode(peppered("123456"));
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA("karine.roussel@usherbrooke.ca", "999999"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getVerificationAttempts()).isEqualTo(1);
  }

  @Test
  void verify2FA_maxAttempts_locksAccount() {
    User u = verifiedUser();
    u.setVerificationCode(peppered("123456"));
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    u.setVerificationAttempts(4); // la prochaine tentative ratée atteint le plafond
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    // HIGH #2 : au plafond, le verrou est bien posé et le code invalidé EN INTERNE, mais la
    // réponse reste la même erreur générique (400) — pas de 429 qui trahirait l'état verrouillé.
    assertThatThrownBy(() -> authService.verify2FA("karine.roussel@usherbrooke.ca", "999999"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getVerificationLockedUntil()).isAfter(LocalDateTime.now());
    assertThat(u.getVerificationCode()).isNull();
  }

  @Test
  void verify2FA_unknownAccount_genericError_noOracle() {
    // HIGH #2 : un compte inexistant renvoie EXACTEMENT la même erreur générique qu'un mauvais
    // code sur un compte existant — aucun moyen de distinguer l'existence du compte.
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.verify2FA("ghost@usherbrooke.ca", "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Code invalide ou expiré.");
  }

  @Test
  void login_whenLocked_throwsAndSendsNoCode() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("Sup3rPass!");
    User u = verifiedUser();
    u.setVerificationLockedUntil(LocalDateTime.now().plusMinutes(10)); // blocage encore actif
    u.setFailedLoginAttempts(3); // compteur non nul avant le login
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(TooManyRequestsException.class);
    verify(emailService, never()).send2FACode(anyString(), anyString());
    // Le verrou 2FA est testé AVANT toute mutation : aucun reset incohérent / non persisté.
    assertThat(u.getFailedLoginAttempts()).isEqualTo(3);
    verify(userRepository, never()).save(any(User.class));
  }

  // ----- forgotPassword -----

  @Test
  void forgotPassword_userFound_setsCode_andSendsEmail() {
    User u = verifiedUser();
    when(userRepository.findByEmail("karine.roussel@usherbrooke.ca")).thenReturn(Optional.of(u));

    Map<String, String> res = authService.forgotPassword("Karine.Roussel@USHERBROOKE.ca");

    assertThat(res.get("message")).contains("Si un compte existe");
    assertThat(u.getResetCode()).hasSize(44); // HMAC Base64, jamais le code en clair
    assertThat(u.getResetCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(userRepository).save(u);
    verify(emailService).sendPasswordResetCode(eq("karine.roussel@usherbrooke.ca"), anyString());
  }

  @Test
  void forgotPassword_activeResetCode_reemits_butKeepsAttempts() {
    // HIGH #1 : un code de reset valide existe déjà (cooldown écoulé). On renvoie bien un code
    // (UX de récupération), mais on NE réinitialise PAS `resetAttempts` — redemander un code ne
    // remet donc plus le plafond d'essais à zéro.
    User u = verifiedUser();
    u.setResetCode(peppered("222222"));
    u.setResetCodeExpiresAt(LocalDateTime.now().plusMinutes(10)); // encore valide
    u.setResetAttempts(3); // essais déjà consommés
    u.setResetLastSentAt(LocalDateTime.now().minusMinutes(2)); // cooldown 60 s écoulé
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    authService.forgotPassword("karine.roussel@usherbrooke.ca");

    assertThat(u.getResetAttempts()).isEqualTo(3); // compteur préservé
    verify(emailService).sendPasswordResetCode(eq("karine.roussel@usherbrooke.ca"), anyString());
  }

  @Test
  void forgotPassword_userNotFound_genericResponse_noEmail() {
    // Anti-énumération : réponse identique, aucun email, aucune écriture.
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.empty());

    Map<String, String> res = authService.forgotPassword("ghost@usherbrooke.ca");

    assertThat(res.get("message")).contains("Si un compte existe");
    verify(emailService, never()).sendPasswordResetCode(anyString(), anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void forgotPassword_withinCooldown_silent_noEmail() {
    User u = verifiedUser();
    u.setResetLastSentAt(LocalDateTime.now()); // vient d'être envoyé
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    Map<String, String> res = authService.forgotPassword("karine.roussel@usherbrooke.ca");

    assertThat(res.get("message")).contains("Si un compte existe"); // pas de 429 (anti-énum)
    verify(emailService, never()).sendPasswordResetCode(anyString(), anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void forgotPassword_whenLocked_silent_noEmail() {
    User u = verifiedUser();
    u.setResetLockedUntil(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    authService.forgotPassword("karine.roussel@usherbrooke.ca");

    verify(emailService, never()).sendPasswordResetCode(anyString(), anyString());
    verify(userRepository, never()).save(any());
  }

  // ----- resetPassword -----

  private User userWithResetCode() {
    User u = verifiedUser();
    u.setResetCode(peppered("123456"));
    u.setResetCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    return u;
  }

  @Test
  void resetPassword_success_setsNewHash_clearsReset_andInvalidatesSession() {
    User u = userWithResetCode();
    u.setActiveTokenHash("old-token-hash");
    u.setFailedLoginAttempts(3);
    u.setLoginLockedUntil(LocalDateTime.now().plusMinutes(5));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.encode(peppered("N0uveauPass!"))).thenReturn("new-hash");

    Map<String, String> res =
        authService.resetPassword("karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!");

    assertThat(res.get("message")).contains("réinitialisé");
    assertThat(u.getPasswordHash()).isEqualTo("new-hash");
    assertThat(u.getResetCode()).isNull();
    assertThat(u.getResetLockedUntil()).isNull();
    // Sessions invalidées + verrou de login levé.
    assertThat(u.getActiveTokenHash()).isNull();
    assertThat(u.getFailedLoginAttempts()).isZero();
    assertThat(u.getLoginLockedUntil()).isNull();
  }

  @Test
  void resetPassword_codeIsSingleUse_secondUseFails() {
    User u = userWithResetCode();
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.encode(peppered("N0uveauPass!"))).thenReturn("new-hash");

    // 1er usage : succès → le code est CONSOMMÉ (resetCode remis à null).
    authService.resetPassword("karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!");
    assertThat(u.getResetCode()).isNull();

    // 2e usage du MÊME code : refusé (plus de code actif) → pas de replay.
    assertThatThrownBy(
            () ->
                authService.resetPassword(
                    "karine.roussel@usherbrooke.ca", "123456", "Encore1Pass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
  }

  @Test
  void resetPassword_codeWithoutExpiry_treatedAsNoValidCode_noNpe() {
    // État incohérent (code présent mais expiry null) : on refuse proprement (pas de NPE 500).
    User u = userWithResetCode();
    u.setResetCodeExpiresAt(null);
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(
            () ->
                authService.resetPassword(
                    "karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
  }

  @Test
  void resetPassword_wrongCode_incrementsAttempts_andKeepsPassword() {
    User u = userWithResetCode();
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "000000", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getResetAttempts()).isEqualTo(1);
    assertThat(u.getPasswordHash()).isEqualTo("storedHash"); // inchangé
    verify(passwordEncoder, never()).encode(anyString());
  }

  @Test
  void resetPassword_wrongCodeAtCap_locksAndInvalidatesCode() {
    User u = userWithResetCode();
    u.setResetAttempts(4); // la 5e tentative atteint le plafond
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    // HIGH #2 : au plafond, le verrou est posé et le code invalidé EN INTERNE, mais la réponse
    // reste la même erreur générique (400) — pas de 429 qui trahirait l'état verrouillé.
    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "000000", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getResetLockedUntil()).isAfter(LocalDateTime.now());
    assertThat(u.getResetCode()).isNull();
  }

  @Test
  void resetPassword_unknownAccount_genericError_noOracle() {
    // HIGH #2 : un compte inexistant renvoie EXACTEMENT la même erreur générique qu'un mauvais
    // code sur un compte existant — aucun oracle d'existence de compte.
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.empty());

    assertThatThrownBy(
            () -> authService.resetPassword("ghost@usherbrooke.ca", "123456", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Code invalide ou expiré.");
  }

  @Test
  void resetPassword_expiredCode_throws() {
    User u = userWithResetCode();
    u.setResetCodeExpiresAt(LocalDateTime.now().minusMinutes(1));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    verify(passwordEncoder, never()).encode(anyString());
  }

  @Test
  void resetPassword_whenLocked_returnsGenericError_withoutTouchingPassword() {
    // HIGH #2 : un compte au verrou de reset actif renvoie la même erreur générique (400) qu'un
    // mauvais code — pas de 429 distinctif. Le verrou reste effectif (mot de passe non modifié).
    User u = userWithResetCode();
    u.setResetLockedUntil(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    verify(passwordEncoder, never()).encode(anyString());
  }

  // =====================================================================================
  // Cas limites et branches complémentaires (#90) : renvoi de code, verrous expirés,
  // courses, logout idempotent, verifyDev, messages uniformes anti-énumération.
  // =====================================================================================

  private static final String EMAIL = "karine.roussel@usherbrooke.ca";
  private static final String GENERIC_CODE_ERROR = "Code invalide ou expiré.";

  private LoginRequest loginRequest() {
    LoginRequest req = new LoginRequest();
    req.setEmail(EMAIL);
    req.setPassword("Sup3rPass!");
    return req;
  }

  // ----- register : username pris par un AUTRE pending -----

  @Test
  void register_usernameTakenByAnotherPending_throws409_withoutSaving() {
    // Aucun pending pour cet email, mais un autre pending (autre email) détient déjà le username.
    RegisterRequest req = registerRequest();
    PendingRegistration other = new PendingRegistration();
    other.setId(2);
    other.setEmail("autre@usherbrooke.ca");
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.of(other));

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(pendingRepository, never()).save(any());
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void register_reRegisterSameEmail_butUsernameHeldByOtherPending_throws409() {
    // Le pending de CET email existe (id 1), mais le username demandé appartient au pending id 2.
    RegisterRequest req = registerRequest();
    PendingRegistration mine = new PendingRegistration();
    mine.setId(1);
    PendingRegistration other = new PendingRegistration();
    other.setId(2);
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(mine));
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.of(other));

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void register_existingPendingAfterCooldown_reusesRow_incrementsResend_andResetsAttempts() {
    // Re-register sur un email en attente, cooldown écoulé et plafond non atteint : la ligne est
    // réutilisée, un nouveau code est émis, resendCount++ et le compteur d'essais repart à zéro.
    RegisterRequest req = registerRequest();
    PendingRegistration existing = new PendingRegistration();
    existing.setId(1);
    existing.setEmail(EMAIL);
    existing.setLastCodeSentAt(LocalDateTime.now().minusMinutes(2));
    existing.setResendCount(2);
    existing.setVerificationAttempts(3);
    existing.setVerificationCode(peppered("111111"));
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(existing));
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.of(existing));
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");

    Map<String, String> res = authService.register(req);

    assertThat(res.get("message")).contains("Vérifiez votre email");
    verify(pendingRepository).save(existing); // même ligne, pas de nouveau pending
    assertThat(existing.getResendCount()).isEqualTo(3);
    assertThat(existing.getVerificationAttempts()).isZero();
    assertThat(existing.getVerificationCode()).isNotEqualTo(peppered("111111")); // nouveau code
    assertThat(existing.getVerificationCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(emailService).sendVerificationCode(eq(EMAIL), anyString());
  }

  @Test
  void register_concurrentRace_usernameTakenByPending_mapsTo409() {
    // Course : le save échoue, aucun compte confirmé n'a ce username, mais un autre pending
    // l'a pris entre-temps → 409 username (et non la réponse générique « email »).
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");
    when(pendingRepository.save(any()))
        .thenThrow(new DataIntegrityViolationException("duplicate username"));
    when(pendingRepository.existsByUsername("rkarine")).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(emailService, never()).sendAccountAlreadyExists(anyString());
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void register_trimsAndLowercasesEmail_beforeDomainCheck() {
    RegisterRequest req = registerRequest();
    req.setEmail("  Karine.Roussel@USherbrooke.CA  ");
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");

    authService.register(req);

    verify(emailService).sendVerificationCode(eq(EMAIL), anyString());
  }

  @Test
  void register_sendsSixDigitCode_whoseHmacIsPersisted() {
    // Le code envoyé par courriel (en clair) doit correspondre au HMAC persisté : on relie
    // explicitement les deux pour prouver que l'utilisateur recevra un code qui fonctionne.
    RegisterRequest req = registerRequest();
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(true);
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(passwordEncoder.encode(peppered("Sup3rPass!"))).thenReturn("hashed");

    authService.register(req);

    ArgumentCaptor<PendingRegistration> pendingCaptor =
        ArgumentCaptor.forClass(PendingRegistration.class);
    ArgumentCaptor<String> codeCaptor = ArgumentCaptor.forClass(String.class);
    verify(pendingRepository).save(pendingCaptor.capture());
    verify(emailService).sendVerificationCode(eq(EMAIL), codeCaptor.capture());
    assertThat(codeCaptor.getValue()).matches("\\d{6}");
    assertThat(pendingCaptor.getValue().getVerificationCode())
        .isEqualTo(peppered(codeCaptor.getValue()));
    assertThat(pendingCaptor.getValue().getResendCount()).isZero(); // 1re inscription
  }

  // ----- login : verrous expirés, code sans expiration -----

  @Test
  void login_expiredLoginLock_isLifted_andCountersReset() {
    // Verrou de login échu : la connexion reprend normalement et le compteur repart à zéro.
    User u = verifiedUser();
    u.setLoginLockedUntil(LocalDateTime.now().minusMinutes(1));
    u.setFailedLoginAttempts(5);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    AuthResponse res = authService.login(loginRequest());

    assertThat(res.getToken()).isNull();
    assertThat(u.getFailedLoginAttempts()).isZero();
    assertThat(u.getLoginLockedUntil()).isNull();
    verify(emailService).send2FACode(eq(EMAIL), anyString());
  }

  @Test
  void login_expiredVerificationLock_emitsNewCode_andClearsLock() {
    // Verrou 2FA échu (code invalidé au plafond) : un nouveau code part et le verrou est levé.
    User u = verifiedUser();
    u.setVerificationLockedUntil(LocalDateTime.now().minusSeconds(1));
    u.setVerificationCode(null);
    u.setVerificationAttempts(5);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    authService.login(loginRequest());

    assertThat(u.getVerificationLockedUntil()).isNull();
    assertThat(u.getVerificationAttempts()).isZero();
    assertThat(u.getVerificationCode()).hasSize(44);
    assertThat(u.getVerificationCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(emailService).send2FACode(eq(EMAIL), anyString());
  }

  @Test
  void login_expiredActiveCode_emitsNewCode_andResetsAttempts() {
    User u = verifiedUser();
    String oldHash = peppered("111111");
    u.setVerificationCode(oldHash);
    u.setVerificationCodeExpiresAt(LocalDateTime.now().minusMinutes(1)); // expiré
    u.setVerificationAttempts(4);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    authService.login(loginRequest());

    assertThat(u.getVerificationCode()).isNotEqualTo(oldHash);
    assertThat(u.getVerificationAttempts()).isZero();
    verify(emailService).send2FACode(eq(EMAIL), anyString());
  }

  @Test
  void login_codeWithoutExpiry_isNotConsideredActive_newCodeEmitted() {
    // État incohérent (code présent, expiration absente) = pas de code actif → réémission.
    User u = verifiedUser();
    u.setVerificationCode(peppered("111111"));
    u.setVerificationCodeExpiresAt(null);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    authService.login(loginRequest());

    assertThat(u.getVerificationCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(emailService).send2FACode(eq(EMAIL), anyString());
  }

  @Test
  void login_sentCode_matchesPersistedHmac_andHasSixDigits() {
    User u = verifiedUser();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    authService.login(loginRequest());

    ArgumentCaptor<String> codeCaptor = ArgumentCaptor.forClass(String.class);
    verify(emailService).send2FACode(eq(EMAIL), codeCaptor.capture());
    assertThat(codeCaptor.getValue()).matches("\\d{6}");
    assertThat(u.getVerificationCode()).isEqualTo(peppered(codeCaptor.getValue()));
    assertThat(u.getLastCodeSentAt()).isNotNull();
  }

  @Test
  void login_returnsIdentity_withoutToken() {
    User u = verifiedUser();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("Sup3rPass!"), "storedHash")).thenReturn(true);

    AuthResponse res = authService.login(loginRequest());

    assertThat(res.getToken()).isNull();
    assertThat(res.getUsername()).isEqualTo("rkarine");
    assertThat(res.getEmail()).isEqualTo(EMAIL);
    assertThat(res.getFirstName()).isEqualTo("Karine");
    assertThat(res.getLastName()).isEqualTo("Roussel");
  }

  @Test
  void login_wrongPassword_incrementsCounter_withoutLockingBelowCap() {
    LoginRequest req = loginRequest();
    req.setPassword("wrong");
    User u = verifiedUser();
    u.setFailedLoginAttempts(2);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.matches(peppered("wrong"), "storedHash")).thenReturn(false);

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class);
    assertThat(u.getFailedLoginAttempts()).isEqualTo(3);
    assertThat(u.getLoginLockedUntil()).isNull(); // pas encore au plafond
    verify(userRepository).save(u); // l'échec est persisté
  }

  @Test
  void login_nullEmail_isTreatedAsUnknownAccount_noNpe() {
    LoginRequest req = new LoginRequest();
    req.setEmail(null);
    req.setPassword("x");

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(InvalidCredentialsException.class);
    verify(userRepository).findByEmail(null);
  }

  // ----- validate -----

  @Test
  void validate_unknownUser_returnsFalse_withoutHashing() {
    when(jwtService.isTokenValid("jwt-token")).thenReturn(true);
    when(jwtService.extractEmail("jwt-token")).thenReturn("ghost@usherbrooke.ca");
    when(userRepository.findByEmail("ghost@usherbrooke.ca")).thenReturn(Optional.empty());

    assertThat(authService.validate("jwt-token")).isFalse();
    verify(jwtService, never()).hashToken(anyString(), anyString());
  }

  @Test
  void validate_hashMismatch_returnsFalse() {
    // Token valide cryptographiquement mais révoqué/remplacé : le hash actif ne correspond plus.
    User u = verifiedUser();
    u.setActiveTokenHash("hash-of-newer-session");
    when(jwtService.isTokenValid("old-token")).thenReturn(true);
    when(jwtService.extractEmail("old-token")).thenReturn(EMAIL);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(jwtService.hashToken("old-token", EMAIL)).thenReturn("hash-of-old-session");

    assertThat(authService.validate("old-token")).isFalse();
  }

  // ----- logout : idempotence -----

  @Test
  void logout_nullOrBlankToken_doesNothing() {
    authService.logout(null);
    authService.logout("   ");

    verify(jwtService, never()).extractEmail(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void logout_unreadableToken_isIdempotent_noLookup() {
    when(jwtService.extractEmail("garbage")).thenThrow(new RuntimeException("JWT illisible"));

    authService.logout("garbage");

    verify(userRepository, never()).findByEmail(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void logout_tokenWithoutSubject_doesNothing() {
    when(jwtService.extractEmail("no-subject")).thenReturn("");
    when(jwtService.extractEmail("null-subject")).thenReturn(null);

    authService.logout("no-subject");
    authService.logout("null-subject");

    verify(userRepository, never()).findByEmail(any());
  }

  @Test
  void logout_unknownUser_doesNothing() {
    when(jwtService.extractEmail("jwt-token")).thenReturn("ghost@usherbrooke.ca");
    when(userRepository.findByEmail("ghost@usherbrooke.ca")).thenReturn(Optional.empty());

    authService.logout("jwt-token");

    verify(userRepository, never()).save(any());
  }

  // ----- verifyDev -----

  @Test
  void verifyDev_alreadyVerified_returnsMessage_withoutTouchingPending() {
    when(userRepository.existsByUsername("rkarine")).thenReturn(true);

    Map<String, String> res = authService.verifyDev("rkarine");

    assertThat(res.get("message")).isEqualTo("Email déjà vérifié pour rkarine");
    verify(pendingRepository, never()).findByUsername(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void verifyDev_success_promotesPendingToUser_andDeletesPending() {
    PendingRegistration pending = validPending();
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(pendingRepository.findByUsername("rkarine")).thenReturn(Optional.of(pending));

    Map<String, String> res = authService.verifyDev("rkarine");

    assertThat(res.get("message")).isEqualTo("Email vérifié pour rkarine");
    ArgumentCaptor<User> captor = ArgumentCaptor.forClass(User.class);
    verify(userRepository).save(captor.capture());
    User created = captor.getValue();
    assertThat(created.getUsername()).isEqualTo("rkarine");
    assertThat(created.getFirstName()).isEqualTo("Karine");
    assertThat(created.getLastName()).isEqualTo("Roussel");
    assertThat(created.getEmail()).isEqualTo(EMAIL);
    assertThat(created.getPasswordHash()).isEqualTo("hashed"); // hash repris tel quel
    assertThat(created.getActiveTokenHash()).isNull(); // pas d'auto-login en mode dev
    assertThat(created.getCreatedAt()).isNotNull();
    verify(pendingRepository).delete(pending);
  }

  // ----- verifyEmail : cas d'erreur et courses -----

  @Test
  void verifyEmail_unknownEmail_throws() {
    when(pendingRepository.findByEmail("ghost@usherbrooke.ca")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.verifyEmail("ghost@usherbrooke.ca", "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Code invalide");
    verify(userRepository, never()).save(any());
  }

  @Test
  void verifyEmail_invalidatedCode_requiresNewCode() {
    // Code invalidé au plafond d'essais : on refuse sans compter d'essai supplémentaire.
    PendingRegistration p = validPending();
    p.setVerificationCode(null);
    p.setVerificationAttempts(5);
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.verifyEmail(EMAIL, "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessageContaining("Demandez un nouveau code");
    assertThat(p.getVerificationAttempts()).isEqualTo(5);
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void verifyEmail_wrongCodeAtCap_hasExplicitMessage_andPersists() {
    PendingRegistration p = validPending();
    p.setVerificationAttempts(4);
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.verifyEmail(EMAIL, "000000"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Trop de tentatives. Demandez un nouveau code.");
    assertThat(p.getVerificationAttempts()).isEqualTo(5);
    verify(pendingRepository).save(p);
  }

  @Test
  void verifyEmail_emailConfirmedMeanwhile_throwsEmailAlreadyUsed() {
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(EMAIL)).thenReturn(true);

    assertThatThrownBy(() -> authService.verifyEmail(EMAIL, "123456"))
        .isInstanceOf(EmailAlreadyUsedException.class);
    verify(userRepository, never()).save(any());
    verify(pendingRepository, never()).delete(any());
  }

  @Test
  void verifyEmail_usernameTakenMeanwhile_throwsUsernameAlreadyUsed() {
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(userRepository.existsByUsername("rkarine")).thenReturn(true);

    assertThatThrownBy(() -> authService.verifyEmail(EMAIL, "123456"))
        .isInstanceOf(UsernameAlreadyUsedException.class);
    verify(userRepository, never()).save(any());
  }

  @Test
  void verifyEmail_concurrentEmailRace_mapsToEmailAlreadyUsed() {
    // Insert User_ rejeté (course) et le username n'est PAS pris : c'est l'email qui l'est.
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(userRepository.save(any()))
        .thenThrow(new DataIntegrityViolationException("duplicate email"));

    assertThatThrownBy(() -> authService.verifyEmail(EMAIL, "123456"))
        .isInstanceOf(EmailAlreadyUsedException.class);
    verify(pendingRepository, never()).delete(any());
  }

  @Test
  void verifyEmail_success_issuesToken_storesSessionHash_andReturnsIdentity() {
    // Auto-login : le token émis est renvoyé ET son hash devient la session active du compte.
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(validPending()));
    when(userRepository.existsByEmail(EMAIL)).thenReturn(false);
    when(userRepository.existsByUsername("rkarine")).thenReturn(false);
    when(jwtService.generateToken(EMAIL)).thenReturn("jwt-token");
    when(jwtService.hashToken("jwt-token", EMAIL)).thenReturn("token-hash");

    AuthResponse res = authService.verifyEmail("  Karine.Roussel@USHERBROOKE.ca ", "123456");

    assertThat(res.getToken()).isEqualTo("jwt-token");
    assertThat(res.getUsername()).isEqualTo("rkarine");
    assertThat(res.getEmail()).isEqualTo(EMAIL);
    assertThat(res.getFirstName()).isEqualTo("Karine");
    assertThat(res.getLastName()).isEqualTo("Roussel");
    ArgumentCaptor<User> captor = ArgumentCaptor.forClass(User.class);
    verify(userRepository).save(captor.capture());
    assertThat(captor.getValue().getActiveTokenHash()).isEqualTo("token-hash");
    assertThat(captor.getValue().getEmail()).isEqualTo(EMAIL);
  }

  // ----- verify2FA : branches d'erreur uniformes -----

  private User userWith2FACode() {
    User u = verifiedUser();
    u.setVerificationCode(peppered("123456"));
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    return u;
  }

  @Test
  void verify2FA_whenLocked_genericError_evenWithCorrectCode_noTokenNoCounting() {
    User u = userWith2FACode();
    u.setVerificationLockedUntil(LocalDateTime.now().plusMinutes(10));
    u.setVerificationAttempts(5);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    assertThat(u.getVerificationAttempts()).isEqualTo(5);
    assertThat(u.getActiveTokenHash()).isNull();
    verify(jwtService, never()).generateToken(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void verify2FA_noActiveCode_genericError() {
    User u = verifiedUser(); // aucun code émis
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    verify(jwtService, never()).generateToken(anyString());
  }

  @Test
  void verify2FA_codeWithoutExpiry_genericError_noNpe() {
    User u = userWith2FACode();
    u.setVerificationCodeExpiresAt(null);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
  }

  @Test
  void verify2FA_expiredCode_genericError_noToken() {
    User u = userWith2FACode();
    u.setVerificationCodeExpiresAt(LocalDateTime.now().minusSeconds(1));
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, "123456"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    verify(jwtService, never()).generateToken(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void verify2FA_expiredLock_isNotEnforced_validCodeSucceeds() {
    User u = userWith2FACode();
    u.setVerificationLockedUntil(LocalDateTime.now().minusMinutes(1)); // verrou échu
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(jwtService.generateToken(EMAIL)).thenReturn("jwt-token");
    when(jwtService.hashToken("jwt-token", EMAIL)).thenReturn("token-hash");

    AuthResponse res = authService.verify2FA("Karine.Roussel@USHERBROOKE.ca", "123456");

    assertThat(res.getToken()).isEqualTo("jwt-token");
    assertThat(u.getVerificationLockedUntil()).isNull();
    assertThat(u.getVerificationCodeExpiresAt()).isNull();
    assertThat(u.getVerificationAttempts()).isZero();
    verify(userRepository).save(u);
  }

  @Test
  void verify2FA_nullCode_countsAsWrongAttempt() {
    User u = userWith2FACode();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, null))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    assertThat(u.getVerificationAttempts()).isEqualTo(1);
    verify(userRepository).save(u);
  }

  @Test
  void verify2FA_wrongCodeBelowCap_doesNotLock_butPersistsAttempt() {
    User u = userWith2FACode();
    u.setVerificationAttempts(2);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA(EMAIL, "999999"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getVerificationAttempts()).isEqualTo(3);
    assertThat(u.getVerificationLockedUntil()).isNull();
    assertThat(u.getVerificationCode()).isNotNull(); // code toujours actif sous le plafond
    verify(userRepository).save(u);
  }

  @Test
  void verify2FA_everyFailure_sharesExactlyTheSameMessage() {
    // Anti-énumération : compte inexistant, verrou, absence de code, expiration et mauvais code
    // doivent être indiscernables par le message.
    User locked = userWith2FACode();
    locked.setVerificationLockedUntil(LocalDateTime.now().plusMinutes(5));
    User noCode = verifiedUser();
    User expired = userWith2FACode();
    expired.setVerificationCodeExpiresAt(LocalDateTime.now().minusMinutes(5));
    User wrong = userWith2FACode();
    when(userRepository.findByEmail(EMAIL))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(locked))
        .thenReturn(Optional.of(noCode))
        .thenReturn(Optional.of(expired))
        .thenReturn(Optional.of(wrong));

    String[] codes = {"123456", "123456", "123456", "123456", "000000"};
    for (String code : codes) {
      assertThatThrownBy(() -> authService.verify2FA(EMAIL, code))
          .isInstanceOf(InvalidVerificationCodeException.class)
          .hasMessage(GENERIC_CODE_ERROR);
    }
  }

  // ----- resendCode, mode 2fa -----

  private User userAwaiting2FA() {
    User u = userWith2FACode();
    u.setLastCodeSentAt(LocalDateTime.now().minusMinutes(2)); // cooldown 60 s écoulé
    u.setVerificationAttempts(3);
    return u;
  }

  @Test
  void resendCode_2fa_unknownUser_throws() {
    when(userRepository.findByEmail("ghost@usherbrooke.ca")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.resendCode("ghost@usherbrooke.ca", "2fa"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Aucune connexion en cours.");
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  @Test
  void resendCode_2fa_whenLocked_throwsTooManyRequests_noEmail() {
    User u = userAwaiting2FA();
    u.setVerificationLockedUntil(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resendCode(EMAIL, "2fa"))
        .isInstanceOf(TooManyRequestsException.class)
        .hasMessageContaining("15 minutes");
    verify(emailService, never()).send2FACode(anyString(), anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void resendCode_2fa_noCodeInFlight_throws() {
    User u = userAwaiting2FA();
    u.setVerificationCode(null); // jamais connecté ou code invalidé
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resendCode(EMAIL, "2fa"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Aucun code à renvoyer. Reconnectez-vous.");
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  @Test
  void resendCode_2fa_withinCooldown_throwsTooManyRequests() {
    User u = userAwaiting2FA();
    u.setLastCodeSentAt(LocalDateTime.now().minusSeconds(10)); // < 60 s
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resendCode(EMAIL, "2fa"))
        .isInstanceOf(TooManyRequestsException.class)
        .hasMessageContaining("Patientez");
    verify(emailService, never()).send2FACode(anyString(), anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void resendCode_2fa_success_emitsNewCode_keepsAttempts_andSendsEmail() {
    // HIGH #1 : le renvoi émet un nouveau code mais NE remet PAS le compteur d'essais à zéro.
    User u = userAwaiting2FA();
    String oldHash = u.getVerificationCode();
    LocalDateTime before = LocalDateTime.now();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    Map<String, String> res = authService.resendCode("Karine.Roussel@USHERBROOKE.ca", "2fa");

    assertThat(res.get("message")).isEqualTo("Code renvoyé.");
    ArgumentCaptor<String> codeCaptor = ArgumentCaptor.forClass(String.class);
    verify(emailService).send2FACode(eq(EMAIL), codeCaptor.capture());
    assertThat(codeCaptor.getValue()).matches("\\d{6}");
    assertThat(u.getVerificationCode()).isEqualTo(peppered(codeCaptor.getValue()));
    assertThat(u.getVerificationCode()).isNotEqualTo(oldHash);
    assertThat(u.getVerificationCodeExpiresAt()).isAfter(before.plusMinutes(14));
    assertThat(u.getVerificationAttempts()).isEqualTo(3); // compteur préservé
    assertThat(u.getLastCodeSentAt()).isAfterOrEqualTo(before);
    verify(userRepository).save(u);
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void resendCode_2fa_expiredLock_allowsResend() {
    User u = userAwaiting2FA();
    u.setVerificationLockedUntil(LocalDateTime.now().minusMinutes(1));
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    authService.resendCode(EMAIL, "2fa");

    verify(emailService).send2FACode(eq(EMAIL), anyString());
  }

  @Test
  void resendCode_2fa_withDevFixedCode_storesFixedCode_andSendsNoEmail() {
    User u = userAwaiting2FA();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(devFixedTwoFactorCode.code()).thenReturn(Optional.of("000000"));

    authService.resendCode(EMAIL, "2fa");

    assertThat(u.getVerificationCode()).isEqualTo(peppered("000000"));
    verify(emailService, never()).send2FACode(anyString(), anyString());
    verify(userRepository).save(u);
  }

  // ----- resendCode, mode email (inscription) -----

  private PendingRegistration pendingAwaitingCode() {
    PendingRegistration p = validPending();
    p.setLastCodeSentAt(LocalDateTime.now().minusMinutes(2));
    p.setResendCount(1);
    p.setVerificationAttempts(3);
    return p;
  }

  @Test
  void resendCode_email_noPending_throws() {
    when(pendingRepository.findByEmail("ghost@usherbrooke.ca")).thenReturn(Optional.empty());

    assertThatThrownBy(() -> authService.resendCode("ghost@usherbrooke.ca", "email"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage("Aucune inscription en attente.");
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
  }

  @Test
  void resendCode_email_withinCooldown_throwsTooManyRequests() {
    PendingRegistration p = pendingAwaitingCode();
    p.setLastCodeSentAt(LocalDateTime.now());
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.resendCode(EMAIL, "email"))
        .isInstanceOf(TooManyRequestsException.class)
        .hasMessageContaining("Patientez");
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void resendCode_email_capReached_throwsTooManyRequests() {
    PendingRegistration p = pendingAwaitingCode();
    p.setResendCount(5);
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    assertThatThrownBy(() -> authService.resendCode(EMAIL, "email"))
        .isInstanceOf(TooManyRequestsException.class)
        .hasMessageContaining("Trop de demandes");
    verify(emailService, never()).sendVerificationCode(anyString(), anyString());
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void resendCode_email_success_incrementsResend_resetsAttempts_andSendsCode() {
    PendingRegistration p = pendingAwaitingCode();
    String oldHash = p.getVerificationCode();
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    Map<String, String> res = authService.resendCode(" Karine.Roussel@USHERBROOKE.ca ", "email");

    assertThat(res.get("message")).isEqualTo("Code renvoyé.");
    ArgumentCaptor<String> codeCaptor = ArgumentCaptor.forClass(String.class);
    verify(emailService).sendVerificationCode(eq(EMAIL), codeCaptor.capture());
    assertThat(codeCaptor.getValue()).matches("\\d{6}");
    assertThat(p.getVerificationCode()).isEqualTo(peppered(codeCaptor.getValue()));
    assertThat(p.getVerificationCode()).isNotEqualTo(oldHash);
    assertThat(p.getResendCount()).isEqualTo(2);
    // Inscription : le nouveau code repart d'un compteur neuf (le plafond de renvois borne déjà).
    assertThat(p.getVerificationAttempts()).isZero();
    assertThat(p.getVerificationCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(pendingRepository).save(p);
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }

  @Test
  void resendCode_nullMode_defaultsToRegistrationCode() {
    PendingRegistration p = pendingAwaitingCode();
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    authService.resendCode(EMAIL, null);

    verify(emailService).sendVerificationCode(eq(EMAIL), anyString());
    verify(userRepository, never()).findByEmail(anyString());
  }

  @Test
  void resendCode_email_firstResendWithoutPriorSend_isAllowed() {
    // lastCodeSentAt null (ancienne ligne) : pas de cooldown à appliquer.
    PendingRegistration p = pendingAwaitingCode();
    p.setLastCodeSentAt(null);
    p.setResendCount(0);
    when(pendingRepository.findByEmail(EMAIL)).thenReturn(Optional.of(p));

    authService.resendCode(EMAIL, "email");

    assertThat(p.getResendCount()).isEqualTo(1);
    verify(emailService).sendVerificationCode(eq(EMAIL), anyString());
  }

  // ----- forgotPassword : verrous/codes expirés -----

  @Test
  void forgotPassword_expiredLock_emitsCode_andResetsAttempts() {
    User u = verifiedUser();
    u.setResetLockedUntil(LocalDateTime.now().minusMinutes(1)); // verrou échu
    u.setResetAttempts(5);
    u.setResetCode(null);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    authService.forgotPassword(EMAIL);

    assertThat(u.getResetAttempts()).isZero(); // aucun code actif → compteur neuf
    assertThat(u.getResetCode()).hasSize(44);
    assertThat(u.getResetLastSentAt()).isNotNull();
    verify(emailService).sendPasswordResetCode(eq(EMAIL), anyString());
  }

  @Test
  void forgotPassword_expiredResetCode_resetsAttempts() {
    User u = verifiedUser();
    u.setResetCode(peppered("222222"));
    u.setResetCodeExpiresAt(LocalDateTime.now().minusMinutes(1)); // expiré
    u.setResetAttempts(3);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    authService.forgotPassword(EMAIL);

    assertThat(u.getResetAttempts()).isZero();
    verify(emailService).sendPasswordResetCode(eq(EMAIL), anyString());
  }

  @Test
  void forgotPassword_resetCodeWithoutExpiry_isNotActive_attemptsReset() {
    User u = verifiedUser();
    u.setResetCode(peppered("222222"));
    u.setResetCodeExpiresAt(null);
    u.setResetAttempts(3);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    authService.forgotPassword(EMAIL);

    assertThat(u.getResetAttempts()).isZero();
    assertThat(u.getResetCodeExpiresAt()).isAfter(LocalDateTime.now());
  }

  @Test
  void forgotPassword_sentCode_matchesPersistedHmac() {
    User u = verifiedUser();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    authService.forgotPassword(EMAIL);

    ArgumentCaptor<String> codeCaptor = ArgumentCaptor.forClass(String.class);
    verify(emailService).sendPasswordResetCode(eq(EMAIL), codeCaptor.capture());
    assertThat(codeCaptor.getValue()).matches("\\d{6}");
    assertThat(u.getResetCode()).isEqualTo(peppered(codeCaptor.getValue()));
  }

  @Test
  void forgotPassword_nullEmail_genericResponse_noNpe() {
    Map<String, String> res = authService.forgotPassword(null);

    assertThat(res.get("message")).contains("Si un compte existe");
    verify(emailService, never()).sendPasswordResetCode(any(), anyString());
  }

  @Test
  void forgotPassword_allOutcomes_shareTheSameMessage() {
    // Anti-énumération : inconnu, verrouillé, en cooldown et succès renvoient le même texte.
    User locked = verifiedUser();
    locked.setResetLockedUntil(LocalDateTime.now().plusMinutes(5));
    User cooling = verifiedUser();
    cooling.setResetLastSentAt(LocalDateTime.now());
    when(userRepository.findByEmail(EMAIL))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(locked))
        .thenReturn(Optional.of(cooling))
        .thenReturn(Optional.of(verifiedUser()));

    String m1 = authService.forgotPassword(EMAIL).get("message");
    String m2 = authService.forgotPassword(EMAIL).get("message");
    String m3 = authService.forgotPassword(EMAIL).get("message");
    String m4 = authService.forgotPassword(EMAIL).get("message");

    assertThat(m1).isEqualTo(m2).isEqualTo(m3).isEqualTo(m4);
    verify(emailService, times(1)).sendPasswordResetCode(eq(EMAIL), anyString());
  }

  // ----- resetPassword : compléments -----

  @Test
  void resetPassword_noResetCode_genericError_noPasswordChange() {
    User u = verifiedUser(); // aucun reset demandé
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resetPassword(EMAIL, "123456", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    verify(passwordEncoder, never()).encode(anyString());
    verify(userRepository, never()).save(any());
  }

  @Test
  void resetPassword_expiredLock_isNotEnforced_validCodeSucceeds() {
    User u = userWithResetCode();
    u.setResetLockedUntil(LocalDateTime.now().minusMinutes(1));
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
    when(passwordEncoder.encode(peppered("N0uveauPass!"))).thenReturn("new-hash");

    Map<String, String> res =
        authService.resetPassword("Karine.Roussel@USHERBROOKE.ca", "123456", "N0uveauPass!");

    assertThat(res.get("message")).isEqualTo("Mot de passe réinitialisé avec succès.");
    assertThat(u.getPasswordHash()).isEqualTo("new-hash");
    assertThat(u.getResetCodeExpiresAt()).isNull();
    assertThat(u.getResetAttempts()).isZero();
    verify(userRepository).save(u);
  }

  @Test
  void resetPassword_nullCode_countsAsWrongAttempt() {
    User u = userWithResetCode();
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resetPassword(EMAIL, null, "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class)
        .hasMessage(GENERIC_CODE_ERROR);
    assertThat(u.getResetAttempts()).isEqualTo(1);
    verify(userRepository).save(u);
  }

  @Test
  void resetPassword_wrongCodeBelowCap_persistsAttempt_withoutLock() {
    User u = userWithResetCode();
    u.setResetAttempts(2);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.resetPassword(EMAIL, "000000", "N0uveauPass!"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getResetAttempts()).isEqualTo(3);
    assertThat(u.getResetLockedUntil()).isNull();
    assertThat(u.getResetCode()).isNotNull();
    verify(userRepository).save(u);
  }

  @Test
  void resetPassword_everyFailure_sharesExactlyTheSameMessage() {
    User locked = userWithResetCode();
    locked.setResetLockedUntil(LocalDateTime.now().plusMinutes(5));
    User noCode = verifiedUser();
    User expired = userWithResetCode();
    expired.setResetCodeExpiresAt(LocalDateTime.now().minusMinutes(5));
    User wrong = userWithResetCode();
    when(userRepository.findByEmail(EMAIL))
        .thenReturn(Optional.empty())
        .thenReturn(Optional.of(locked))
        .thenReturn(Optional.of(noCode))
        .thenReturn(Optional.of(expired))
        .thenReturn(Optional.of(wrong));

    String[] codes = {"123456", "123456", "123456", "123456", "000000"};
    for (String code : codes) {
      assertThatThrownBy(() -> authService.resetPassword(EMAIL, code, "N0uveauPass!"))
          .isInstanceOf(InvalidVerificationCodeException.class)
          .hasMessage(GENERIC_CODE_ERROR);
    }
    verify(passwordEncoder, never()).encode(anyString());
  }
}
