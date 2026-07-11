package com.moodit.auth_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.exception.DomainNotAllowedException;
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
    assertThat(saved.getVerificationCode()).hasSize(6);
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
  void login_whenAccountLocked_throwsTooManyRequests_withoutCheckingPassword() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("Sup3rPass!");
    User u = verifiedUser();
    u.setLoginLockedUntil(LocalDateTime.now().plusMinutes(10)); // verrou encore actif
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(TooManyRequestsException.class);
    verify(passwordEncoder, never()).matches(anyString(), anyString());
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
    p.setVerificationCode("123456");
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
    u.setVerificationCode("123456");
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
    u.setVerificationCode("123456");
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA("karine.roussel@usherbrooke.ca", "999999"))
        .isInstanceOf(InvalidVerificationCodeException.class);
    assertThat(u.getVerificationAttempts()).isEqualTo(1);
  }

  @Test
  void verify2FA_maxAttempts_locksAccount() {
    User u = verifiedUser();
    u.setVerificationCode("123456");
    u.setVerificationCodeExpiresAt(LocalDateTime.now().plusMinutes(10));
    u.setVerificationAttempts(4); // la prochaine tentative ratée atteint le plafond
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(() -> authService.verify2FA("karine.roussel@usherbrooke.ca", "999999"))
        .isInstanceOf(TooManyRequestsException.class);
    assertThat(u.getVerificationLockedUntil()).isAfter(LocalDateTime.now());
    assertThat(u.getVerificationCode()).isNull();
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
    assertThat(u.getResetCode()).hasSize(6);
    assertThat(u.getResetCodeExpiresAt()).isAfter(LocalDateTime.now());
    verify(userRepository).save(u);
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
    u.setResetCode("123456");
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

    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "000000", "N0uveauPass!"))
        .isInstanceOf(TooManyRequestsException.class);
    assertThat(u.getResetLockedUntil()).isAfter(LocalDateTime.now());
    assertThat(u.getResetCode()).isNull();
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
  void resetPassword_whenLocked_throws_withoutTouchingPassword() {
    User u = userWithResetCode();
    u.setResetLockedUntil(LocalDateTime.now().plusMinutes(10));
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));

    assertThatThrownBy(
            () -> authService.resetPassword("karine.roussel@usherbrooke.ca", "123456", "N0uveauPass!"))
        .isInstanceOf(TooManyRequestsException.class);
    verify(passwordEncoder, never()).encode(anyString());
  }
}
