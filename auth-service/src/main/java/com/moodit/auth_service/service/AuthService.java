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

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
public class AuthService {

  private final UserRepository userRepository;
  private final JwtService jwtService;
  private final PasswordEncoder passwordEncoder;

  @Value("${app.security.pepper}")
  private String pepper;

  // Register

  public AuthResponse register(RegisterRequest request) {

    // Vérifier si email ou username déjà pris
    if (userRepository.existsByEmail(request.getEmail())) {
      throw new RuntimeException("Email déjà utilisé");
    }
    if (userRepository.existsByUsername(request.getUsername())) {
      throw new RuntimeException("Nom d'utilisateur déjà pris");
    }

    // Vérifier le domaine email
    String domain = extractDomain(request.getEmail());
    // TODO: vérifier domain dans la table Establishment

    // Créer le user
    User user = new User();
    user.setUsername(request.getUsername());
    user.setFirstName(request.getFirstName());
    user.setLastName(request.getLastName());
    user.setEmail(request.getEmail());
    user.setPasswordHash(passwordEncoder.encode(request.getPassword() + pepper));
    user.setCreatedAt(LocalDateTime.now());

    // Générer le JWT
    String token = jwtService.generateToken(request.getEmail());

    // Hasher et stocker le token
    String hashedToken = jwtService.hashToken(token, request.getEmail());
    user.setActiveTokenHash(hashedToken);

    userRepository.save(user);

    return new AuthResponse(
        token, user.getUsername(), user.getEmail(), user.getFirstName(), user.getLastName());
  }

  // Login

  public AuthResponse login(LoginRequest request) {

    // Trouver le user
    User user =
        userRepository
            .findByEmail(request.getEmail())
            .orElseThrow(() -> new RuntimeException("Email ou mot de passe invalide"));

    // Vérifier le mot de passe
    if (!passwordEncoder.matches(request.getPassword() + pepper, user.getPasswordHash())) {
      throw new RuntimeException("Email ou mot de passe invalide");
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

  // Méthodes privées

  private String extractDomain(String email) {
    return email.substring(email.indexOf('@') + 1);
  }
}
