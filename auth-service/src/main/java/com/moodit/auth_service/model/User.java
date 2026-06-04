// Ce fichier permet de définir la table user en BD comme un objet en Java avec Spring Boot

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
@Table(name = "user_")
public class User {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  @Column(nullable = false, unique = true, length = 64)
  private String username;

  @Column(name = "first_name", nullable = false, length = 128)
  private String firstName;

  @Column(name = "last_name", nullable = false, length = 128)
  private String lastName;

  @Column(nullable = false, unique = true, length = 256)
  private String email;

  @Column(name = "verified_email", nullable = false)
  private Boolean verifiedEmail = false;

  @Column(name = "password_hash", nullable = false, length = 256)
  private String passwordHash;

  @Column(name = "active_token_hash", length = 256)
  private String activeTokenHash;

  @Column(name = "avatar_color", nullable = false, length = 9)
  private String avatarColor = "#0a5cc0";

  @Column(columnDefinition = "TEXT")
  private String settings;

  @Column(name = "created_at", nullable = false, updatable = false)
  private LocalDateTime createdAt = LocalDateTime.now();
}
