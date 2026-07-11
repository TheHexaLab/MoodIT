package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.permission_service.model.Role;
import com.moodit.permission_service.model.RoleNames;
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.UserRepository;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

/**
 * Moteur d'autorisation REST (PermissionService.isAllowed) : on vérifie allow/deny par règle,
 * le default-allow sur route non listée, et le fail-closed sur identité inconnue. Repositories /
 * MembershipService mockés ; ObjectMapper réel (pour parser le body des règles POST).
 */
@ExtendWith(MockitoExtension.class)
class PermissionServiceTest {

  @Mock private UserRepository userRepository;
  @Mock private MembershipService membershipService;

  private PermissionService service() {
    return new PermissionService(userRepository, membershipService, new ObjectMapper());
  }

  private static final String EMAIL = "u@test";

  private User user(int id, String... roleNames) {
    User u = new User();
    u.setId(id);
    u.setEmail(EMAIL);
    Set<Role> roles = new HashSet<>();
    for (String n : roleNames) {
      Role r = new Role();
      r.setName(n);
      roles.add(r);
    }
    u.setRoles(roles);
    return u;
  }

  private void loggedIn(User u) {
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
  }

  // ── Gestion de contenu quiz (GET /courses/{id}/quizzes/manage) ─────────────────────

  @Test
  void quizManage_globalAdmin_allowed() {
    loggedIn(user(5, RoleNames.ADMIN)); // rôle GLOBAL → court-circuite la BD
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes/manage", "GET", null)).isTrue();
  }

  @Test
  void quizManage_student_denied() {
    loggedIn(user(5)); // aucun rôle
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes/manage", "GET", null)).isFalse();
  }

  @Test
  void quizManage_programTeacher_allowed() {
    loggedIn(user(5));
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes/manage", "GET", null)).isTrue();
  }

  // ── Liste étudiant (GET /courses/{id}/quizzes) : appartenance requise ──────────────

  @Test
  void studentQuizList_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessCourse(5, 1)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes", "GET", null)).isTrue();
  }

  @Test
  void studentQuizList_notSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes", "GET", null)).isFalse();
  }

  // ── Changement de rôle PROGRAMME (POST /roles/change, programId dans le body) ───────

  @Test
  void rolesChange_programAdmin_allowed() {
    loggedIn(user(5));
    when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/roles/change", "POST", "{\"programId\":7}")).isTrue();
  }

  @Test
  void rolesChange_nonManager_denied() {
    loggedIn(user(5));
    when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/roles/change", "POST", "{\"programId\":7}")).isFalse();
  }

  // ── Changement de rôle GLOBAL (POST /roles/global/change) : Gardien uniquement ──────

  @Test
  void rolesGlobalChange_guardian_allowed() {
    loggedIn(user(5, RoleNames.GUARDIAN));
    assertThat(service().isAllowed(EMAIL, "/api/roles/global/change", "POST", "{}")).isTrue();
  }

  @Test
  void rolesGlobalChange_generalAdmin_denied() {
    loggedIn(user(5, RoleNames.ADMIN)); // admin général mais PAS gardien
    assertThat(service().isAllowed(EMAIL, "/api/roles/global/change", "POST", "{}")).isFalse();
  }

  // ── Régression du bug "Administration" : membres d'un programme (GET /programs/{id}/users) ──

  @Test
  void programUsers_programAdmin_allowed() {
    // Avant le fix, le prédicat testait le rôle "Administration" (inexistant) → un admin de
    // programme prenait un 403. On vérifie qu'il est bien autorisé désormais.
    loggedIn(user(5));
    when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/programs/3/users", "GET", null)).isTrue();
  }

  // ── Comportement du moteur ─────────────────────────────────────────────────────────

  @Test
  void noMatchingRule_defaultAllow_withoutLoadingUser() {
    // Aucune règle → autorisé SANS charger le user (zéro requête BD).
    assertThat(service().isAllowed(EMAIL, "/api/unlisted/route", "GET", null)).isTrue();
    verifyNoInteractions(userRepository);
  }

  @Test
  void matchedRule_unknownUser_denied() {
    // Route restreinte + identité introuvable → refus (fail-closed).
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes/manage", "GET", null)).isFalse();
  }

  @Test
  void nullEmailOrPath_denied() {
    // Garde d'entrée : on ne cherche même pas de règle.
    lenient().when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(user(5)));
    PermissionService s = service();
    assertThat(s.isAllowed(null, "/api/courses/1/quizzes/manage", "GET", null)).isFalse();
    assertThat(s.isAllowed(EMAIL, null, "GET", null)).isFalse();
  }
}
