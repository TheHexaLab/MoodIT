package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.ChangeRoleRequest;
import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.RoleNames;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.RoleDto;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.RoleRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Pageable;

/**
 * Tests unitaires de {@link RoleService} (le chemin BD de changeGlobalRole est déjà couvert par
 * {@code RoleServiceGlobalRoleTest}) : filtres de portée, candidats paginés, rôles de programme,
 * audit et échos temps réel.
 */
@ExtendWith(MockitoExtension.class)
class RoleServiceTest {

  @Mock private RoleRepository roleRepository;
  @Mock private UserProgramRoleRepository userProgramRoleRepository;
  @Mock private UserRepository userRepository;
  @Mock private ProgramRepository programRepository;
  @Mock private UserService userService;
  @Mock private RealtimeEventPublisher realtimePublisher;
  @Mock private AuditLogService auditLogService;

  @InjectMocks private RoleService roleService;

  private static final Role TEACHER = role(1, RoleNames.TEACHER, true, false);
  private static final Role ADMIN = role(2, RoleNames.ADMIN, true, true);
  private static final Role GUARDIAN = role(3, RoleNames.GUARDIAN, false, true);

  private static Role role(int id, String name, boolean program, boolean global) {
    Role r = new Role();
    r.setId(id);
    r.setName(name);
    r.setProgramAssignable(program);
    r.setGlobalAssignable(global);
    return r;
  }

  private static User user(int id, String username, Role... roles) {
    return User.builder().id(id).username(username).roles(new ArrayList<>(List.of(roles))).build();
  }

  private static ChangeRoleRequest req(String type, Integer roleId, Integer userId, Integer programId) {
    ChangeRoleRequest r = new ChangeRoleRequest();
    r.setType(type);
    r.setRoleId(roleId);
    r.setUserId(userId);
    r.setProgramId(programId);
    return r;
  }

  @Nested
  class Lectures {

    @Test
    @DisplayName("findAll(scope) filtre par portée : program, global, sinon tous")
    void findAll_filtre_par_portee() {
      when(roleRepository.findAll()).thenReturn(List.of(TEACHER, ADMIN, GUARDIAN));

      assertThat(roleService.findAll("program")).extracting(RoleDTO::getId).containsExactly(1, 2);
      assertThat(roleService.findAll("global")).extracting(RoleDTO::getId).containsExactly(2, 3);
      assertThat(roleService.findAll("autre")).extracting(RoleDTO::getId).containsExactly(1, 2, 3);
      assertThat(roleService.findAll()).extracting(RoleDTO::getName)
          .containsExactly(RoleNames.TEACHER, RoleNames.ADMIN, RoleNames.GUARDIAN);
    }

    @Test
    @DisplayName("getUsersWithGlobalRoles mappe les utilisateurs via UserService")
    void getUsersWithGlobalRoles_mappe() {
      User bob = user(1, "bob", ADMIN);
      UserDTO bobDto = UserDTO.builder().id(1).username("bob").build();
      when(userRepository.findUsersWithGlobalRole()).thenReturn(List.of(bob));
      when(userService.toUserDTO(bob)).thenReturn(bobDto);

      assertThat(roleService.getUsersWithGlobalRoles()).containsExactly(bobDto);
    }

    @Test
    @DisplayName("getGlobalRoleCandidates normalise la recherche (trim + minuscules) et borne page/taille")
    void getGlobalRoleCandidates_normalise() {
      when(userRepository.findGlobalRoleCandidates(any(), any(), any())).thenReturn(List.of());

      roleService.getGlobalRoleCandidates(2, "  BoB ", -3, 0);
      roleService.getGlobalRoleCandidates(2, null, 4, 500);
      roleService.getGlobalRoleCandidates(2, "x", 1, 25);

      ArgumentCaptor<String> q = ArgumentCaptor.forClass(String.class);
      ArgumentCaptor<Pageable> page = ArgumentCaptor.forClass(Pageable.class);
      verify(userRepository, org.mockito.Mockito.times(3))
          .findGlobalRoleCandidates(org.mockito.ArgumentMatchers.eq(2), q.capture(), page.capture());
      assertThat(q.getAllValues()).containsExactly("bob", "", "x");
      assertThat(page.getAllValues()).extracting(Pageable::getPageNumber).containsExactly(0, 4, 1);
      assertThat(page.getAllValues()).extracting(Pageable::getPageSize).containsExactly(10, 50, 25);
    }

    @Test
    @DisplayName("getGlobalRoleCandidates renvoie les candidats mappés par UserService, dans l'ordre")
    void getGlobalRoleCandidates_mappe_les_candidats() {
      User bob = user(1, "bob");
      User zoe = user(2, "zoe");
      UserDTO bobDto = UserDTO.builder().id(1).build();
      UserDTO zoeDto = UserDTO.builder().id(2).build();
      when(userRepository.findGlobalRoleCandidates(any(), any(), any())).thenReturn(List.of(bob, zoe));
      when(userService.toUserDTO(bob)).thenReturn(bobDto);
      when(userService.toUserDTO(zoe)).thenReturn(zoeDto);

      assertThat(roleService.getGlobalRoleCandidates(2, null, 0, 10)).containsExactly(bobDto, zoeDto);
    }
  }

  @Nested
  class ChangeGlobalRole {

    @Test
    @DisplayName("assign : ajoute le rôle, journalise ROLE_ASSIGN et émet globalRolesChanged + adminRolesChanged")
    void assign_ajoute_journalise_et_emet() {
      User bob = user(7, "bob", GUARDIAN);
      when(userRepository.findById(7)).thenReturn(Optional.of(bob));
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      when(userRepository.findUsersWithGlobalRole()).thenReturn(List.of(bob));
      UserDTO bobDto = UserDTO.builder().id(7).build();
      when(userService.toUserDTO(bob)).thenReturn(bobDto);

      roleService.changeGlobalRole(req("assign", 2, 7, null));

      assertThat(bob.getRoles()).containsExactly(GUARDIAN, ADMIN);
      verify(userRepository).save(bob);
      verify(auditLogService).record("ROLE_ASSIGN", "ROLE", 2,
          "Rôle « Administrateur » attribué (global) à l'utilisateur bob");
      verify(realtimePublisher).globalRolesChanged(7L,
          List.of(new RoleDto(3, RoleNames.GUARDIAN), new RoleDto(2, RoleNames.ADMIN)));
      verify(realtimePublisher).adminRolesChanged(List.of(bobDto));
    }

    @Test
    @DisplayName("unassign : retire le rôle et journalise ROLE_REVOKE (sans username → « #id »)")
    void unassign_retire_et_journalise() {
      User anon = user(7, null, ADMIN);
      when(userRepository.findById(7)).thenReturn(Optional.of(anon));
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      when(userRepository.findUsersWithGlobalRole()).thenReturn(List.of());

      roleService.changeGlobalRole(req("unassign", 2, 7, null));

      assertThat(anon.getRoles()).isEmpty();
      verify(userRepository).save(anon);
      verify(auditLogService).record("ROLE_REVOKE", "ROLE", 2,
          "Rôle « Administrateur » retiré (global) à l'utilisateur #7");
      verify(realtimePublisher).globalRolesChanged(7L, List.of());
      verify(realtimePublisher).adminRolesChanged(List.of());
    }

    @Test
    @DisplayName("unassign ne retire QUE le rôle visé : les autres rôles globaux restent")
    void unassign_garde_les_autres_roles() {
      User bob = user(7, "bob", ADMIN, GUARDIAN);
      when(userRepository.findById(7)).thenReturn(Optional.of(bob));
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      when(userRepository.findUsersWithGlobalRole()).thenReturn(List.of());

      roleService.changeGlobalRole(req("unassign", 2, 7, null));

      assertThat(bob.getRoles()).containsExactly(GUARDIAN);
      verify(userRepository).save(bob);
    }

    @Test
    @DisplayName("Idempotent : assign d'un rôle déjà présent / unassign d'un rôle absent → pas de sauvegarde")
    void idempotent_sans_sauvegarde() {
      User bob = user(7, "bob", ADMIN);
      when(userRepository.findById(7)).thenReturn(Optional.of(bob));
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      when(roleRepository.findById(3)).thenReturn(Optional.of(GUARDIAN));

      roleService.changeGlobalRole(req("assign", 2, 7, null));
      roleService.changeGlobalRole(req("unassign", 3, 7, null));

      assertThat(bob.getRoles()).containsExactly(ADMIN);
      verify(userRepository, never()).save(any());
    }

    @Test
    @DisplayName("Requête invalide : champs manquants, rôle introuvable, non global, type inconnu → IllegalArgumentException")
    void requetes_invalides() {
      assertThatThrownBy(() -> roleService.changeGlobalRole(req("assign", null, 7, null)))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> roleService.changeGlobalRole(req("assign", 2, null, null)))
          .isInstanceOf(IllegalArgumentException.class);

      User bob = user(7, "bob");
      when(userRepository.findById(7)).thenReturn(Optional.of(bob));
      when(roleRepository.findById(9)).thenReturn(Optional.empty());
      when(roleRepository.findById(1)).thenReturn(Optional.of(TEACHER));
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      assertThatThrownBy(() -> roleService.changeGlobalRole(req("assign", 9, 7, null)))
          .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("introuvable");
      assertThatThrownBy(() -> roleService.changeGlobalRole(req("assign", 1, 7, null)))
          .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("globalement");
      assertThatThrownBy(() -> roleService.changeGlobalRole(req("toggle", 2, 7, null)))
          .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("toggle");

      verifyNoInteractions(auditLogService, realtimePublisher);
    }

    @Test
    @DisplayName("Utilisateur inconnu → UserNotFoundException")
    void utilisateur_inconnu() {
      when(userRepository.findById(7)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> roleService.changeGlobalRole(req("assign", 2, 7, null)))
          .isInstanceOf(UserNotFoundException.class);
    }
  }

  @Nested
  class ChangeRole {

    private void stubAuditLookups() {
      when(roleRepository.findById(2)).thenReturn(Optional.of(ADMIN));
      when(userRepository.findById(7)).thenReturn(Optional.of(user(7, "bob")));
      when(programRepository.findById(10))
          .thenReturn(Optional.of(Program.builder().id(10).name("Informatique").build()));
      when(roleRepository.findAll()).thenReturn(List.of(TEACHER, ADMIN, GUARDIAN));
    }

    @Test
    @DisplayName("assign : crée le lien User_Program_Role, journalise et émet le rôle le plus élevé restant")
    void assign_cree_le_lien() {
      stubAuditLookups();
      when(userProgramRoleRepository.existsByProgramIdAndUserIdAndRoleId(10, 7, 2)).thenReturn(false);
      when(userProgramRoleRepository.findByProgramIdAndUserId(10, 7))
          .thenReturn(List.of(new UserProgramRole(10, 7, 1), new UserProgramRole(10, 7, 2)));

      roleService.changeRole(req("assign", 2, 7, 10));

      verify(userProgramRoleRepository).save(new UserProgramRole(10, 7, 2));
      verify(auditLogService).record("ROLE_ASSIGN", "ROLE", 2,
          "Rôle « Administrateur » attribué à l'utilisateur bob dans le programme « Informatique »",
          "Programme : Informatique");
      verify(realtimePublisher).programRoleChanged(7L, 10L, RoleNames.ADMIN);
    }

    @Test
    @DisplayName("Dans une transaction, programRoleChanged n'est émis qu'APRÈS le commit")
    void echo_differe_apres_commit() {
      stubAuditLookups();
      when(userProgramRoleRepository.findByProgramIdAndUserId(10, 7)).thenReturn(List.of());
      org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
      try {
        roleService.changeRole(req("unassign", 2, 7, 10));
        verifyNoInteractions(realtimePublisher);

        org.springframework.transaction.support.TransactionSynchronizationManager.getSynchronizations()
            .forEach(org.springframework.transaction.support.TransactionSynchronization::afterCommit);
        verify(realtimePublisher).programRoleChanged(7L, 10L, null);
      } finally {
        org.springframework.transaction.support.TransactionSynchronizationManager.clearSynchronization();
      }
    }

    @Test
    @DisplayName("assign d'un lien existant : pas de doublon ; Enseignant seul → rôle Enseignant émis")
    void assign_existant_sans_doublon() {
      stubAuditLookups();
      when(userProgramRoleRepository.existsByProgramIdAndUserIdAndRoleId(10, 7, 2)).thenReturn(true);
      when(userProgramRoleRepository.findByProgramIdAndUserId(10, 7))
          .thenReturn(List.of(new UserProgramRole(10, 7, 1)));

      roleService.changeRole(req("assign", 2, 7, 10));

      verify(userProgramRoleRepository, never()).save(any());
      verify(realtimePublisher).programRoleChanged(7L, 10L, RoleNames.TEACHER);
    }

    @Test
    @DisplayName("unassign : supprime le lien ; plus aucun rôle → null émis ; libellés de repli « #id »")
    void unassign_supprime_et_repli() {
      when(roleRepository.findById(2)).thenReturn(Optional.empty());
      when(userRepository.findById(7)).thenReturn(Optional.empty());
      when(programRepository.findById(10)).thenReturn(Optional.empty());
      when(roleRepository.findAll()).thenReturn(List.of(TEACHER, ADMIN));
      when(userProgramRoleRepository.findByProgramIdAndUserId(10, 7)).thenReturn(List.of());

      roleService.changeRole(req("unassign", 2, 7, 10));

      verify(userProgramRoleRepository).deleteByProgramIdAndUserIdAndRoleId(10, 7, 2);
      verify(auditLogService).record("ROLE_REVOKE", "ROLE", 2,
          "Rôle « #2 » retiré à l'utilisateur #7 dans le programme « #10 »", "Programme : #10");
      verify(realtimePublisher).programRoleChanged(7L, 10L, null);
    }

    @Test
    @DisplayName("Champs manquants ou type inconnu → IllegalArgumentException, aucune écriture")
    void requetes_invalides() {
      assertThatThrownBy(() -> roleService.changeRole(req("assign", 2, 7, null)))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> roleService.changeRole(req("assign", 2, null, 10)))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> roleService.changeRole(req("assign", null, 7, 10)))
          .isInstanceOf(IllegalArgumentException.class);
      assertThatThrownBy(() -> roleService.changeRole(req("toggle", 2, 7, 10)))
          .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("toggle");

      verifyNoInteractions(userProgramRoleRepository, auditLogService);
      verify(realtimePublisher, never()).programRoleChanged(anyLong(), anyLong(), any());
    }
  }
}
