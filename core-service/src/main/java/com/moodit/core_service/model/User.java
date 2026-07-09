package com.moodit.core_service.model;

import jakarta.persistence.*;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.BatchSize;

import java.time.LocalDateTime;
import java.util.List;

// @BatchSize (niveau classe) : quand des User sont chargés comme association (ex. l'auteur
// @ManyToOne de chaque post d'une page), Hibernate les initialise PAR LOTS au lieu d'1/élément.
@Entity
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table(name = "user_")
@BatchSize(size = 50)
public class User {

  @Id
  @GeneratedValue(strategy = GenerationType.IDENTITY)
  private Integer id;

  @Column(nullable = false, unique = true, length = 64)
  private String username;

  @Column(name = "first_name", nullable = false)
  private String firstName;

  @Column(name = "last_name", nullable = false)
  private String lastName;

  @Column(nullable = false, unique = true, length = 256)
  private String email;

  @Column(columnDefinition = "TEXT")
  private String settings;

  @Column(name = "avatar_color", length = 9)
  private String avatarColor = "#0a5cc0";

  @Column(name = "active_token_hash", length = 256)
  private String activeTokenHash;

  @Column(name = "password_hash", nullable = false, length = 256)
  private String passwordHash;

  @Column(name = "created_at")
  private LocalDateTime createdAt;

  /*@Column(name = "verified_email")
  private Boolean verifiedEmail;*/

  // @BatchSize : les rôles d'une page d'utilisateurs (popup admins) chargés par lots au lieu
  // d'1 requête/utilisateur (N+1 de toUserDTO).
  @ManyToMany
  @JoinTable(
      name = "user_role",
      joinColumns = @JoinColumn(name = "user_id"),
      inverseJoinColumns = @JoinColumn(name = "role_id"))
  @BatchSize(size = 50)
  private List<Role> roles;

  @ManyToMany
  @JoinTable(
      name = "user_program",
      joinColumns = @JoinColumn(name = "user_id"),
      inverseJoinColumns = @JoinColumn(name = "program_id"))
  private List<Program> programs;

  @OneToMany(mappedBy = "user", cascade = CascadeType.ALL, orphanRemoval = true)
  private List<Enrollment> enrollments;
}
