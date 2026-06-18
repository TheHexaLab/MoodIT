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
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import com.moodit.auth_service.exception.InvalidVerificationCodeException;
import com.moodit.auth_service.exception.TooManyRequestsException;
import com.moodit.auth_service.exception.UsernameAlreadyUsedException;
import com.moodit.auth_service.model.PendingRegistration;
import com.moodit.auth_service.model.User;
import com.moodit.auth_service.repository.EstablishmentRepository;
import com.moodit.auth_service.repository.PendingRegistrationRepository;
import com.moodit.auth_service.repository.UserRepository;
import java.time.LocalDateTime;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
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
    when(passwordEncoder.encode("Sup3rPass!" + PEPPER)).thenReturn("hashed");

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
  void register_emailAlreadyUsed_throws() {
    RegisterRequest req = registerRequest();
    when(userRepository.existsByEmail("karine.roussel@usherbrooke.ca")).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(EmailAlreadyUsedException.class);
    verify(pendingRepository, never()).save(any());
  }

  @Test
  void register_usernameAlreadyUsed_throws() {
    RegisterRequest req = registerRequest();
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(userRepository.existsByUsername("rkarine")).thenReturn(true);

    assertThatThrownBy(() -> authService.register(req))
        .isInstanceOf(UsernameAlreadyUsedException.class);
  }

  @Test
  void register_domainNotAllowed_throws() {
    RegisterRequest req = registerRequest();
    when(userRepository.existsByEmail(anyString())).thenReturn(false);
    when(pendingRepository.findByEmail(anyString())).thenReturn(Optional.empty());
    when(userRepository.existsByUsername(anyString())).thenReturn(false);
    when(pendingRepository.findByUsername(anyString())).thenReturn(Optional.empty());
    when(establishmentRepository.existsByDomainEmail("usherbrooke.ca")).thenReturn(false);

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
  }

  @Test
  void login_wrongPassword_throwsInvalidCredentials() {
    LoginRequest req = new LoginRequest();
    req.setEmail("karine.roussel@usherbrooke.ca");
    req.setPassword("wrong");
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(verifiedUser()));
    when(passwordEncoder.matches("wrong" + PEPPER, "storedHash")).thenReturn(false);

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
    when(passwordEncoder.matches("Sup3rPass!" + PEPPER, "storedHash")).thenReturn(true);

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
    when(passwordEncoder.matches("wrong" + PEPPER, "storedHash")).thenReturn(false);

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
    when(userRepository.findByEmail(anyString())).thenReturn(Optional.of(u));
    when(passwordEncoder.matches("Sup3rPass!" + PEPPER, "storedHash")).thenReturn(true);

    assertThatThrownBy(() -> authService.login(req))
        .isInstanceOf(TooManyRequestsException.class);
    verify(emailService, never()).send2FACode(anyString(), anyString());
  }
}
