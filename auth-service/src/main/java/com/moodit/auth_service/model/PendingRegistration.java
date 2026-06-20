// Inscription en attente de vérification d'email : tant que le code n'est pas
// confirmé, les données restent ici et n'entrent jamais dans la table user_.

package com.moodit.auth_service.model;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.AllArgsConstructor;

import java.time.LocalDateTime;

@Data
@NoArgsConstructor
@AllArgsConstructor
@Entity
@Table(name = "pending_registration")
public class PendingRegistration {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  // unique = true : documentaire (schéma géré par init.sql, ddl-auto=none). La contrainte
  // réelle est dans init.sql et protège contre une course concurrente entre deux inscriptions.
  @Column(nullable = false, unique = true, length = 64)
  private String username;

  @Column(name = "first_name", nullable = false, length = 128)
  private String firstName;

  @Column(name = "last_name", nullable = false, length = 128)
  private String lastName;

  @Column(nullable = false, unique = true, length = 256)
  private String email;

  @Column(name = "password_hash", nullable = false, length = 256)
  private String passwordHash;

  @Column(name = "verification_code", length = 6)
  private String verificationCode;

  @Column(name = "verification_code_expires_at")
  private LocalDateTime verificationCodeExpiresAt;

  @Column(name = "resend_count", nullable = false)
  private int resendCount = 0;

  @Column(name = "verification_attempts", nullable = false)
  private int verificationAttempts = 0;

  @Column(name = "last_code_sent_at")
  private LocalDateTime lastCodeSentAt;

  @Column(name = "created_at", nullable = false, updatable = false)
  private LocalDateTime createdAt = LocalDateTime.now();
}
