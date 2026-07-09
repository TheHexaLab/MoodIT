package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.RoleNames;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.RoleRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.data.jpa.test.autoconfigure.DataJpaTest;
import org.springframework.boot.jpa.test.autoconfigure.TestEntityManager;

/**
 * Chemin critique : attribution/retrait d'un rôle GLOBAL (RoleService.changeGlobalRole). Vérifie
 * l'ajout, l'IDEMPOTENCE (assign deux fois = un seul rôle), le retrait, et la garde d'intégrité
 * (un rôle non global_assignable est refusé). Le popup gère l'optimisme ; le service persiste.
 */
@DataJpaTest
class RoleServiceGlobalRoleTest {

  @Autowired private RoleRepository roleRepository;
  @Autowired private UserRepository userRepository;
  @Autowired private UserProgramRoleRepository userProgramRoleRepository;
  @Autowired private TestEntityManager em;

  private RoleService roleService;
  private Integer userId;
  private Integer adminRoleId; // global_assignable = true
  private Integer teacherRoleId; // global_assignable = false

  @BeforeEach
  void seed() {
    // changeGlobalRole n'utilise que roleRepository + userRepository ; userService et le publisher
    // sont mockés (non sollicités par ce chemin).
    roleService =
        new RoleService(
            roleRepository,
            userProgramRoleRepository,
            userRepository,
            mock(UserService.class),
            mock(RealtimeEventPublisher.class));

    adminRoleId = newRole(RoleNames.ADMIN, true, true).getId();
    teacherRoleId = newRole(RoleNames.TEACHER, true, false).getId();

    User u = new User();
    u.setUsername("bob");
    u.setFirstName("Bob");
    u.setLastName("Test");
    u.setEmail("bob@test.ca");
    u.setPasswordHash("hash");
    em.persist(u);
    userId = u.getId();

    em.flush();
    em.clear();
  }

  private Role newRole(String name, boolean programAssignable, boolean globalAssignable) {
    Role r = new Role();
    r.setName(name);
    r.setProgramAssignable(programAssignable);
    r.setGlobalAssignable(globalAssignable);
    em.persist(r);
    return r;
  }

  private long globalRoleCount() {
    em.flush();
    em.clear();
    return userRepository.findById(userId).orElseThrow().getRoles().size();
  }

  @Test
  void assign_ajouteLeRole() {
    roleService.changeGlobalRole(request("assign", adminRoleId));
    assertThat(globalRoleCount()).isEqualTo(1);
  }

  @Test
  void assign_estIdempotent() {
    roleService.changeGlobalRole(request("assign", adminRoleId));
    roleService.changeGlobalRole(request("assign", adminRoleId)); // 2e fois : pas de doublon
    assertThat(globalRoleCount()).isEqualTo(1);
  }

  @Test
  void unassign_retireLeRole() {
    roleService.changeGlobalRole(request("assign", adminRoleId));
    roleService.changeGlobalRole(request("unassign", adminRoleId));
    assertThat(globalRoleCount()).isZero();
  }

  @Test
  void unassign_roleAbsent_estUnNoOp() {
    roleService.changeGlobalRole(request("unassign", adminRoleId));
    assertThat(globalRoleCount()).isZero();
  }

  @Test
  void assign_roleNonGlobalAssignable_estRefuse() {
    assertThatThrownBy(() -> roleService.changeGlobalRole(request("assign", teacherRoleId)))
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(globalRoleCount()).isZero();
  }

  @Test
  void type_inconnu_estRefuse() {
    assertThatThrownBy(() -> roleService.changeGlobalRole(request("bogus", adminRoleId)))
        .isInstanceOf(IllegalArgumentException.class);
  }

  private ChangeRoleRequest request(String type, Integer roleId) {
    ChangeRoleRequest req = new ChangeRoleRequest();
    req.setType(type);
    req.setRoleId(roleId);
    req.setUserId(userId);
    return req;
  }
}
