package com.moodit.auth_service.service;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Date;
import java.util.HexFormat;

@Service
public class JwtService {

  @Value("${app.jwt.secret}")
  private String jwtSecret;

  @Value("${app.jwt.expiration}")
  private long jwtExpiration;

  // ── Génération du token ───────────────────────────────────────────────

  public String generateToken(String email) {
    return Jwts.builder()
        .subject(email)
        .issuedAt(new Date())
        .expiration(new Date(System.currentTimeMillis() + jwtExpiration))
        .signWith(getSigningKey())
        .compact();
  }

  // ── Extraction de l'email depuis le token ─────────────────────────────

  public String extractEmail(String token) {
    return extractClaims(token).getSubject();
  }

  // ── Validation du token ───────────────────────────────────────────────

  public boolean isTokenValid(String token) {
    try {
      extractClaims(token);
      return true;
    } catch (Exception e) {
      return false;
    }
  }

  // ── Hash du token (2 à 5 fois selon l'email) ──────────────────────────

  public String hashToken(String token, String email) {
    int hashCount = getHashCount(email);
    String hashed = token;
    for (int i = 0; i < hashCount; i++) {
      hashed = sha256(hashed);
    }
    return hashed;
  }

  public int getHashCount(String email) {
    int sum = 0;
    for (char c : email.toCharArray()) {
      sum += c;
    }
    return (sum % 4) + 2; // toujours entre 2 et 5
  }

  // ── Méthodes privées ──────────────────────────────────────────────────

  private Claims extractClaims(String token) {
    return Jwts.parser().verifyWith(getSigningKey()).build().parseSignedClaims(token).getPayload();
  }

  private SecretKey getSigningKey() {
    return Keys.hmacShaKeyFor(jwtSecret.getBytes(StandardCharsets.UTF_8));
  }

  private String sha256(String input) {
    try {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
      return HexFormat.of().formatHex(hash);
    } catch (NoSuchAlgorithmException e) {
      throw new RuntimeException("SHA-256 non disponible", e);
    }
  }
}
