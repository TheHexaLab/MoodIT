package com.moodit.core_service.repository;

import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.model.UserProgramRoleId;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserProgramRoleRepository
    extends JpaRepository<UserProgramRole, UserProgramRoleId> {

  /** Toutes les assignations (user ↔ role) d'un programme. */
  List<UserProgramRole> findByProgramId(Integer programId);

  /** Rôles d'un utilisateur DANS un programme. */
  List<UserProgramRole> findByProgramIdAndUserId(Integer programId, Integer userId);

  /** Toutes les assignations d'un utilisateur (tous programmes confondus). */
  List<UserProgramRole> findByUserId(Integer userId);

  boolean existsByProgramIdAndUserIdAndRoleId(Integer programId, Integer userId, Integer roleId);

  void deleteByProgramIdAndUserIdAndRoleId(Integer programId, Integer userId, Integer roleId);

  /** Retire TOUS les rôles d'un utilisateur dans un programme (quand il quitte le programme). */
  void deleteByProgramIdAndUserId(Integer programId, Integer userId);
}
