package com.moodit.core_service.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.IdClass;
import jakarta.persistence.Table;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * Rôle d'un utilisateur DANS un programme (table User_Program_Role). Distinct de User_Role
 * (rôle GLOBAL app). Clé composite (program_id, user_id, role_id) : un même utilisateur peut
 * porter plusieurs rôles dans un programme.
 */
@Entity
@Table(name = "user_program_role")
@IdClass(UserProgramRoleId.class)
@Data
@NoArgsConstructor
@AllArgsConstructor
public class UserProgramRole {

  @Id
  @Column(name = "program_id")
  private Integer programId;

  @Id
  @Column(name = "user_id")
  private Integer userId;

  @Id
  @Column(name = "role_id")
  private Integer roleId;
}
