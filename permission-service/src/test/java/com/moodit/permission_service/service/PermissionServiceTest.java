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
  void studentQuizList_notSubscribedButGlobalAdmin_allowed() {
    // Gestionnaire (admin global) NON abonné : garde l'accès à la liste publiée (garde-fou
    // canAccessCourse || canManageCourseContent).
    loggedIn(user(5, RoleNames.ADMIN));
    when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/quizzes", "GET", null)).isTrue();
  }

  @Test
  void studentQuizList_notSubscribedNorManager_denied() {
    loggedIn(user(5)); // ni abonné, ni gestionnaire
    when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
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

  // ── Liste des rôles attribuables (GET /roles?scope=...) : permission SELON le scope ─────
  // Le scope vient de la QUERY STRING (transmise par le gateway, 5e argument d'isAllowed).

  @Test
  void rolesList_scopeGlobal_globalRoleHolder_allowed() {
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(true); // Admin OU Gardien global
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=global")).isTrue();
  }

  @Test
  void rolesList_scopeGlobal_noGlobalRole_denied() {
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=global")).isFalse();
  }

  @Test
  void rolesList_scopeProgram_programAdmin_allowed() {
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(false);
    when(membershipService.hasRoleInAnyProgram(5, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=program")).isTrue();
  }

  @Test
  void rolesList_scopeProgram_globalRoleHolder_allowed() {
    loggedIn(user(5));
    // Rôle global : court-circuite le test « admin d'un programme » (|| paresseux).
    when(membershipService.hasGlobalRole(5)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=program")).isTrue();
  }

  @Test
  void rolesList_scopeProgram_neither_denied() {
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(false);
    when(membershipService.hasRoleInAnyProgram(5, RoleNames.ADMIN)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=program")).isFalse();
  }

  @Test
  void rolesList_unknownOrMissingScope_denied() {
    // Scope inconnu OU absent → refus (fail-closed), sans consulter aucun prédicat d'appartenance
    // (même un gardien est refusé : ce n'est pas une route valide sans scope reconnu).
    loggedIn(user(5, RoleNames.GUARDIAN));
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=banana")).isFalse();
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, null)).isFalse();
  }

  // ── Forums : appartenance (lecture) et propriété (édition/suppression) ──────────────

  @Test
  void forumThreads_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts", "GET", null)).isTrue();
  }

  @Test
  void forumThreads_notSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts", "GET", null)).isFalse();
  }

  @Test
  void forumReplies_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40/replies", "GET", null)).isTrue();
  }

  @Test
  void channelMessages_notSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/messages", "GET", null)).isFalse();
  }

  @Test
  void sendMessage_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/messages", "POST", "{\"forumId\":9}"))
        .isTrue();
  }

  @Test
  void editPost_author_allowed() {
    loggedIn(user(5));
    when(membershipService.isPostAuthor(5, 40)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40", "PATCH", "{}")).isTrue();
  }

  @Test
  void deletePost_nonAuthor_denied() {
    loggedIn(user(5));
    when(membershipService.isPostAuthor(5, 40)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40", "DELETE", null)).isFalse();
  }

  // ── Forums d'un cours (liste) + structure (sections) ────────────────────────────────

  @Test
  void courseForums_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessCourse(5, 1)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/forums", "GET", null)).isTrue();
  }

  @Test
  void courseForums_managerNotSubscribed_allowed() {
    loggedIn(user(5, RoleNames.ADMIN)); // gestionnaire global, non abonné
    when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/forums", "GET", null)).isTrue();
  }

  @Test
  void courseForums_neither_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/forums", "GET", null)).isFalse();
  }

  @Test
  void changeSection_programTeacher_allowed() {
    loggedIn(user(5));
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/sections", "PATCH", "{}")).isTrue();
  }

  @Test
  void changeSection_student_denied() {
    loggedIn(user(5));
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/sections", "PATCH", "{}")).isFalse();
  }

  // ── Inscription à des cours (self + abonné) & désabonnement d'un programme (self) ────

  @Test
  void joinCourses_selfSubscribedAndCoursesInProgram_allowed() {
    loggedIn(user(5));
    when(membershipService.isSubscribedToProgram(5, 3)).thenReturn(true);
    when(membershipService.isCourseInProgram(10, 3)).thenReturn(true);
    when(membershipService.isCourseInProgram(11, 3)).thenReturn(true);
    assertThat(
            service()
                .isAllowed(
                    EMAIL,
                    "/api/courses/users",
                    "POST",
                    "{\"id\":5,\"courseIds\":[10,11],\"programId\":3}"))
        .isTrue();
  }

  @Test
  void joinCourses_courseNotInProgram_denied() {
    loggedIn(user(5));
    when(membershipService.isSubscribedToProgram(5, 3)).thenReturn(true);
    when(membershipService.isCourseInProgram(10, 3)).thenReturn(true);
    when(membershipService.isCourseInProgram(99, 3)).thenReturn(false); // cours d'un autre programme
    assertThat(
            service()
                .isAllowed(
                    EMAIL,
                    "/api/courses/users",
                    "POST",
                    "{\"id\":5,\"courseIds\":[10,99],\"programId\":3}"))
        .isFalse();
  }

  @Test
  void joinCourses_emptyCourseIds_allowed() {
    // Sync à zéro cours (désinscription de tous ceux du programme) : autorisé si soi + abonné.
    loggedIn(user(5));
    when(membershipService.isSubscribedToProgram(5, 3)).thenReturn(true);
    assertThat(
            service()
                .isAllowed(
                    EMAIL,
                    "/api/courses/users",
                    "POST",
                    "{\"id\":5,\"courseIds\":[],\"programId\":3}"))
        .isTrue();
  }

  @Test
  void joinCourses_otherUser_denied() {
    loggedIn(user(5)); // connecté = 5, mais le body vise l'usager 9
    assertThat(
            service()
                .isAllowed(EMAIL, "/api/courses/users", "POST", "{\"id\":9,\"programId\":3}"))
        .isFalse();
  }

  @Test
  void joinCourses_selfButNotSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.isSubscribedToProgram(5, 3)).thenReturn(false);
    assertThat(
            service()
                .isAllowed(EMAIL, "/api/courses/users", "POST", "{\"id\":5,\"programId\":3}"))
        .isFalse();
  }

  @Test
  void leaveProgram_self_allowed() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/programs/3/users/5", "DELETE", null)).isTrue();
  }

  @Test
  void leaveProgram_otherUser_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/programs/3/users/9", "DELETE", null)).isFalse();
  }

  // ── Gestion des établissements : Gardien uniquement ─────────────────────────────────

  @Test
  void createEstablishment_guardian_allowed() {
    loggedIn(user(5, RoleNames.GUARDIAN));
    assertThat(service().isAllowed(EMAIL, "/api/establishments", "POST", "{}")).isTrue();
  }

  @Test
  void createEstablishment_generalAdmin_denied() {
    loggedIn(user(5, RoleNames.ADMIN)); // admin général ≠ gardien
    assertThat(service().isAllowed(EMAIL, "/api/establishments", "POST", "{}")).isFalse();
  }

  @Test
  void updateEstablishment_nonGuardian_denied() {
    loggedIn(user(5, RoleNames.ADMIN));
    assertThat(service().isAllowed(EMAIL, "/api/establishments/3", "PATCH", "{}")).isFalse();
  }

  @Test
  void deleteEstablishment_guardian_allowed() {
    loggedIn(user(5, RoleNames.GUARDIAN));
    assertThat(service().isAllowed(EMAIL, "/api/establishments/3", "DELETE", null)).isTrue();
  }

  @Test
  void listEstablishments_openToAnyAuthenticated() {
    // La LECTURE reste ouverte (default-allow) : aucun chargement de user requis.
    assertThat(service().isAllowed(EMAIL, "/api/establishments", "GET", null)).isTrue();
  }

  // ── Modifier un programme (PATCH /programs/{id}) : admin/gardien global OU admin du programme ──

  @Test
  void updateProgram_globalAdmin_allowed() {
    loggedIn(user(5, RoleNames.ADMIN));
    assertThat(service().isAllowed(EMAIL, "/api/programs/7", "PATCH", "{}")).isTrue();
  }

  @Test
  void updateProgram_programAdmin_allowed() {
    loggedIn(user(5));
    when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/programs/7", "PATCH", "{}")).isTrue();
  }

  @Test
  void updateProgram_programTeacher_denied() {
    // Enseignant du programme : PAS autorisé à modifier le programme.
    loggedIn(user(5));
    when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/programs/7", "PATCH", "{}")).isFalse();
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

  @Test
  void nullMethod_denied() {
    assertThat(service().isAllowed(EMAIL, "/api/roles", null, null, "scope=global")).isFalse();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  CAS LIMITES EXHAUSTIFS — validation des ids, court-circuits, parsing query, verbes.
  // ═══════════════════════════════════════════════════════════════════════════════════

  // ── /roles?scope : parsing query & fail-closed ─────────────────────────────────────

  @Test
  void rolesList_unknownUser_denied() {
    // Route restreinte + identité introuvable → refus, sans consulter les prédicats.
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "scope=global")).isFalse();
  }

  @Test
  void rolesList_scopeGlobal_extraQueryParams_allowed() {
    // Le parseur isole `scope` parmi d'autres paramètres (ordre indifférent).
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "foo=bar&scope=global&x=1"))
        .isTrue();
  }

  @Test
  void rolesList_scopeProgram_paramBeforeScope_programAdmin_allowed() {
    loggedIn(user(5));
    when(membershipService.hasGlobalRole(5)).thenReturn(false);
    when(membershipService.hasRoleInAnyProgram(5, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "x=1&scope=program")).isTrue();
  }

  @Test
  void rolesList_emptyQueryString_denied() {
    // Query vide (aucun scope) → refus, même pour un gardien.
    loggedIn(user(5, RoleNames.GUARDIAN));
    assertThat(service().isAllowed(EMAIL, "/api/roles", "GET", null, "")).isFalse();
  }

  @Test
  void rolesPost_noRule_defaultAllow() {
    // Seul GET /roles est gardé : un autre verbe ne matche aucune règle → default-allow.
    assertThat(service().isAllowed(EMAIL, "/api/roles", "POST", "{}", "scope=global")).isTrue();
    verifyNoInteractions(userRepository);
  }

  // ── Forums : lecture (appartenance) — variantes non couvertes + ids invalides ───────

  @Test
  void forumReplies_notSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40/replies", "GET", null)).isFalse();
  }

  @Test
  void channelMessages_subscribed_allowed() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/messages", "GET", null)).isTrue();
  }

  @Test
  void forumThreads_nonNumericForumId_denied() {
    // {forumId} matche « abc » mais longVar → -1 → refus sans requête d'appartenance.
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/forums/abc/posts", "GET", null)).isFalse();
  }

  @Test
  void forumPosts_wrongMethod_defaultAllow() {
    // PUT /forums/{id}/posts n'est gardé par aucune règle → default-allow (sans charger le user).
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts", "PUT", null)).isTrue();
    verifyNoInteractions(userRepository);
  }

  // ── Forums : envoi de message (forumId dans le body) ────────────────────────────────

  @Test
  void sendMessage_notSubscribed_denied() {
    loggedIn(user(5));
    when(membershipService.canAccessForum(5, 9)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/messages", "POST", "{\"forumId\":9}"))
        .isFalse();
  }

  @Test
  void sendMessage_missingForumId_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/forums/messages", "POST", "{}")).isFalse();
  }

  @Test
  void sendMessage_forumIdZero_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/forums/messages", "POST", "{\"forumId\":0}"))
        .isFalse();
  }

  // ── Forums : édition/suppression (auteur) — l'autre moitié des combinaisons ──────────

  @Test
  void deletePost_author_allowed() {
    loggedIn(user(5));
    when(membershipService.isPostAuthor(5, 40)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40", "DELETE", null)).isTrue();
  }

  @Test
  void editPost_nonAuthor_denied() {
    loggedIn(user(5));
    when(membershipService.isPostAuthor(5, 40)).thenReturn(false);
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/40", "PATCH", "{}")).isFalse();
  }

  @Test
  void editPost_nonNumericPostId_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/forums/9/posts/abc", "PATCH", "{}")).isFalse();
  }

  // ── Forums d'un cours + sections : rôles manquants et id invalide ───────────────────

  @Test
  void courseForums_invalidCourseId_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/courses/abc/forums", "GET", null)).isFalse();
  }

  @Test
  void changeSection_globalAdmin_allowed() {
    loggedIn(user(5, RoleNames.ADMIN)); // rôle global → court-circuite la BD
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/sections", "PATCH", "{}")).isTrue();
  }

  @Test
  void changeSection_programAdmin_allowed() {
    loggedIn(user(5));
    when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(true);
    assertThat(service().isAllowed(EMAIL, "/api/courses/1/sections", "PATCH", "{}")).isTrue();
  }

  @Test
  void changeSection_invalidCourseId_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/courses/abc/sections", "PATCH", "{}")).isFalse();
  }

  // ── joinCourses : ids manquants / nuls dans le body ─────────────────────────────────

  @Test
  void joinCourses_missingProgramId_denied() {
    loggedIn(user(5)); // body.id == soi, mais aucun programId
    assertThat(service().isAllowed(EMAIL, "/api/courses/users", "POST", "{\"id\":5}")).isFalse();
  }

  @Test
  void joinCourses_missingId_denied() {
    loggedIn(user(5)); // aucun id → n'est pas « soi » → refus avant tout appel d'appartenance
    assertThat(service().isAllowed(EMAIL, "/api/courses/users", "POST", "{\"programId\":3}"))
        .isFalse();
  }

  @Test
  void joinCourses_programIdZero_denied() {
    loggedIn(user(5));
    assertThat(
            service()
                .isAllowed(EMAIL, "/api/courses/users", "POST", "{\"id\":5,\"programId\":0}"))
        .isFalse();
  }

  // ── leaveProgram : userId non numérique ─────────────────────────────────────────────

  @Test
  void leaveProgram_nonNumericUserId_denied() {
    loggedIn(user(5));
    assertThat(service().isAllowed(EMAIL, "/api/programs/3/users/abc", "DELETE", null)).isFalse();
  }
}
