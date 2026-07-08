package com.moodit.core_service.dto;

import lombok.Data;

/**
 * Corps de POST /roles/change : assigner ou retirer un rôle à un utilisateur DANS un
 * programme (INSERT/DELETE dans User_Program_Role). Reflète l'union `RoleChange` du front,
 * + le `programId` (les rôles sont scopés au programme, pas globaux).
 */
@Data
public class ChangeRoleRequest {
  /** "assign" ou "unassign". */
  private String type;
  private Integer roleId;
  private Integer userId;
  private Integer programId;
}
