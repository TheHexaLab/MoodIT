package com.moodit.core_service.model;

import java.io.Serializable;
import java.util.Objects;

/** Clé composite de {@link UserProgramRole} (program_id, user_id, role_id). */
public class UserProgramRoleId implements Serializable {

  private Integer programId;
  private Integer userId;
  private Integer roleId;

  public UserProgramRoleId() {}

  public UserProgramRoleId(Integer programId, Integer userId, Integer roleId) {
    this.programId = programId;
    this.userId = userId;
    this.roleId = roleId;
  }

  @Override
  public boolean equals(Object o) {
    if (this == o) return true;
    if (!(o instanceof UserProgramRoleId that)) return false;
    return Objects.equals(programId, that.programId)
        && Objects.equals(userId, that.userId)
        && Objects.equals(roleId, that.roleId);
  }

  @Override
  public int hashCode() {
    return Objects.hash(programId, userId, roleId);
  }
}
