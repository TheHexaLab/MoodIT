package com.moodit.auth_service.service;

import com.moodit.auth_service.dto.AuthResponse;
import com.moodit.auth_service.dto.LoginRequest;
import com.moodit.auth_service.dto.RegisterRequest;
import com.moodit.auth_service.model.User;
import com.moodit.auth_service.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Value;
import com.moodit.auth_service.exception.EmailAlreadyUsedException;
import com.moodit.auth_service.exception.UsernameAlreadyUsedException;
import com.moodit.auth_service.exception.InvalidCredentialsException;
import java.time.LocalDateTime;
import java.util.Map;
import com.moodit.auth_service.exception.EmailNotVerifiedException;

@Service
@RequiredArgsConstructor
public class AuthService {

  private final UserRepository userRepository;
  private final JwtService jwtService;
  private final PasswordEncoder passwordEncoder;

  @Value("${app.security.pepper}")
  private String pepper;

  // Register

  public Map<String, String> register(RegisterRequest request) {

    if (userRepository.existsByEmail(request.getEmail())) {
      throw new EmailAlreadyUsedException();
    }
    if (userRepository.existsByUsername(request.getUsername())) {
      throw new UsernameAlreadyUsedException();
    }

    String domain = extractDomain(request.getEmail());
    // TODO: vérifier domain dans la table Establishment

    User user = new User();
    user.setUsername(request.getUsername());
    user.setFirstName(request.getFirstName());
    user.setLastName(request.getLastName());
    user.setEmail(request.getEmail());
    user.setPasswordHash(passwordEncoder.encode(request.getPassword() + pepper));
    user.setCreatedAt(LocalDateTime.now());
    user.setVerifiedEmail(false);

    userRepository.save(user);

    // TODO: envoyer email de vérification

    return Map.of("message", "Compte créé! Vérifiez votre email pour activer votre compte.");
  }

  // Login

  public AuthResponse login(LoginRequest request) {

    // Trouver le user
    User user =
        userRepository
            .findByEmail(request.getEmail())
            .orElseThrow(() -> new InvalidCredentialsException());
    // Vérifier si l'email est confirmé
    if (!user.isVerifiedEmail()) {
      throw new EmailNotVerifiedException();
    }
    // Vérifier le mot de passe
    if (!passwordEncoder.matches(request.getPassword() + pepper, user.getPasswordHash())) {
      throw new InvalidCredentialsException();
    }

    // Générer un nouveau JWT
    String token = jwtService.generateToken(request.getEmail());

    // Mettre à jour le token hashé en BD
    String hashedToken = jwtService.hashToken(token, request.getEmail());
    user.setActiveTokenHash(hashedToken);
    userRepository.save(user);

    return new AuthResponse(
        token, user.getUsername(), user.getEmail(), user.getFirstName(), user.getLastName());
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

  // Vérification manuelle pour le dev
  public Map<String, String> verifyDev(String username) {
    User user =
        userRepository
            .findByUsername(username)
            .orElseThrow(() -> new RuntimeException("Utilisateur non trouvé"));
    user.setVerifiedEmail(true);
    userRepository.save(user);
    return Map.of("message", "Email vérifié pour " + username);
  }

  // Méthodes privées

  private String extractDomain(String email) {
    return email.substring(email.indexOf('@') + 1);
  }
}
