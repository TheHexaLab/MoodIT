package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.MembershipRepository;
import com.moodit.permission_service.repository.UserRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Autorisation des rooms WebSocket (MembershipService.canJoin), par scope. Couvre notamment
 * `adminRoles` (rôle global requis) et `establishment` (ouvert), ajoutés pour combler le trou où
 * l'authorizer distant refusait ces rooms. Repositories mockés.
 */
@ExtendWith(MockitoExtension.class)
class MembershipServiceTest {

  @Mock private UserRepository userRepository;
  @Mock private MembershipRepository membershipRepository;

  @InjectMocks private MembershipService service;

  private static final String EMAIL = "u@test";

  private void loggedIn(int id) {
    User u = new User();
    u.setId(id);
    u.setEmail(EMAIL);
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
  }

  @Test
  void userRoom_ownId_allowed() {
    loggedIn(5);
    assertThat(service.canJoin(EMAIL, "user", 5)).isTrue();
  }

  @Test
  void userRoom_otherId_denied() {
    loggedIn(5);
    assertThat(service.canJoin(EMAIL, "user", 9)).isFalse();
  }

  @Test
  void adminRoles_withGlobalRole_allowed() {
    loggedIn(5);
    when(membershipRepository.hasGlobalRole(5)).thenReturn(true);
    assertThat(service.canJoin(EMAIL, "adminRoles", 0)).isTrue();
  }

  @Test
  void adminRoles_withoutGlobalRole_denied() {
    loggedIn(5);
    when(membershipRepository.hasGlobalRole(5)).thenReturn(false);
    assertThat(service.canJoin(EMAIL, "adminRoles", 0)).isFalse();
  }

  @Test
  void establishment_anyAuthenticated_allowed() {
    loggedIn(5);
    assertThat(service.canJoin(EMAIL, "establishment", 0)).isTrue();
  }

  @Test
  void mcpRoom_subscribed_allowed() {
    loggedIn(5);
    when(membershipRepository.canSeeCourseViaProgram(5, 3)).thenReturn(true);
    assertThat(service.canJoin(EMAIL, "mcp", 3)).isTrue();
  }

  @Test
  void unknownScope_denied() {
    loggedIn(5);
    assertThat(service.canJoin(EMAIL, "bogus", 1)).isFalse();
  }

  @Test
  void unknownUser_denied() {
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    assertThat(service.canJoin(EMAIL, "user", 5)).isFalse();
  }

  @Test
  void channelRoom_subscribed_allowed() {
    loggedIn(5);
    when(membershipRepository.canSeeForumViaProgram(5, 7)).thenReturn(true);
    assertThat(service.canJoin(EMAIL, "channel", 7)).isTrue();
  }

  @Test
  void forumRoom_notSubscribed_denied() {
    loggedIn(5);
    when(membershipRepository.canSeeForumViaProgram(5, 7)).thenReturn(false);
    assertThat(service.canJoin(EMAIL, "forum", 7)).isFalse();
  }

  @Test
  void programRoom_subscribed_allowed() {
    loggedIn(5);
    when(membershipRepository.isSubscribedToProgram(5, 3)).thenReturn(true);
    assertThat(service.canJoin(EMAIL, "program", 3)).isTrue();
  }

  // ── Wrappers ajoutés (délégation directe au repository) ──────────────────────────────

  @Test
  void isSubscribedToProgram_delegatesTrue() {
    when(membershipRepository.isSubscribedToProgram(5, 3)).thenReturn(true);
    assertThat(service.isSubscribedToProgram(5, 3)).isTrue();
  }

  @Test
  void isSubscribedToProgram_delegatesFalse() {
    when(membershipRepository.isSubscribedToProgram(5, 3)).thenReturn(false);
    assertThat(service.isSubscribedToProgram(5, 3)).isFalse();
  }

  @Test
  void hasRoleInAnyProgram_delegatesTrue() {
    when(membershipRepository.hasRoleInAnyProgram(5, "Administrateur")).thenReturn(true);
    assertThat(service.hasRoleInAnyProgram(5, "Administrateur")).isTrue();
  }

  @Test
  void hasRoleInAnyProgram_delegatesFalse() {
    when(membershipRepository.hasRoleInAnyProgram(5, "Administrateur")).thenReturn(false);
    assertThat(service.hasRoleInAnyProgram(5, "Administrateur")).isFalse();
  }

  @Test
  void roleName_delegatesName() {
    when(membershipRepository.findRoleNameById(2)).thenReturn("Administrateur");
    assertThat(service.roleName(2)).isEqualTo("Administrateur");
  }

  @Test
  void courseProgramIds_convertitChaqueIdEnLong() {
    // La requête native renvoie des Number (Integer/Long/BigInteger selon le pilote) : chaque
    // id est ramené en long, dans l'ordre, pour le calcul des programmes ajoutés ou retirés.
    when(membershipRepository.findProgramIdsByCourse(7))
        .thenReturn(java.util.List.of(3, 4L, java.math.BigInteger.valueOf(8)));
    assertThat(service.courseProgramIds(7)).containsExactly(3L, 4L, 8L);
  }

  @Test
  void roleName_unknownId_null() {
    when(membershipRepository.findRoleNameById(99)).thenReturn(null);
    assertThat(service.roleName(99)).isNull();
  }

  @Test
  void hasRoleInForumCourse_delegatesTrue() {
    when(membershipRepository.hasRoleInForumCourse(5, 9, "Enseignant")).thenReturn(true);
    assertThat(service.hasRoleInForumCourse(5, 9, "Enseignant")).isTrue();
  }

  @Test
  void hasRoleInForumCourse_delegatesFalse() {
    when(membershipRepository.hasRoleInForumCourse(5, 9, "Enseignant")).thenReturn(false);
    assertThat(service.hasRoleInForumCourse(5, 9, "Enseignant")).isFalse();
  }

  // ── Délégations restantes (#90) : chaque prédicat renvoie EXACTEMENT la réponse du repository ──

  @Test
  void canAccessQuiz_delegatesTrueAndFalse() {
    when(membershipRepository.canSeeQuizViaProgram(5, 12)).thenReturn(true);
    when(membershipRepository.canSeeQuizViaProgram(5, 13)).thenReturn(false);
    assertThat(service.canAccessQuiz(5, 12)).isTrue();
    assertThat(service.canAccessQuiz(5, 13)).isFalse();
  }

  @Test
  void canAccessCourse_delegatesFalse() {
    when(membershipRepository.canSeeCourseViaProgram(5, 3)).thenReturn(false);
    assertThat(service.canAccessCourse(5, 3)).isFalse();
  }

  @Test
  void canAccessForum_delegatesTrue() {
    when(membershipRepository.canSeeForumViaProgram(5, 9)).thenReturn(true);
    assertThat(service.canAccessForum(5, 9)).isTrue();
  }

  @Test
  void isCourseInProgram_delegatesTrueAndFalse() {
    when(membershipRepository.isCourseInProgram(10, 3)).thenReturn(true);
    when(membershipRepository.isCourseInProgram(99, 3)).thenReturn(false);
    assertThat(service.isCourseInProgram(10, 3)).isTrue();
    assertThat(service.isCourseInProgram(99, 3)).isFalse();
  }

  @Test
  void isEnrolledInCourse_delegatesTrueAndFalse() {
    when(membershipRepository.isEnrolledInCourse(5, 1)).thenReturn(true);
    when(membershipRepository.isEnrolledInCourse(5, 2)).thenReturn(false);
    assertThat(service.isEnrolledInCourse(5, 1)).isTrue();
    assertThat(service.isEnrolledInCourse(5, 2)).isFalse();
  }

  @Test
  void isPostAuthor_delegatesTrueAndFalse() {
    when(membershipRepository.isPostAuthor(5, 40)).thenReturn(true);
    when(membershipRepository.isPostAuthor(5, 41)).thenReturn(false);
    assertThat(service.isPostAuthor(5, 40)).isTrue();
    assertThat(service.isPostAuthor(5, 41)).isFalse();
  }

  @Test
  void isVoteOwner_delegatesTrueAndFalse() {
    when(membershipRepository.isVoteOwner(5, 70)).thenReturn(true);
    when(membershipRepository.isVoteOwner(5, 71)).thenReturn(false);
    assertThat(service.isVoteOwner(5, 70)).isTrue();
    assertThat(service.isVoteOwner(5, 71)).isFalse();
  }

  @Test
  void hasRoleInProgram_delegatesTrueAndFalse() {
    when(membershipRepository.hasRoleInProgram(5, 7, "Administrateur")).thenReturn(true);
    when(membershipRepository.hasRoleInProgram(5, 7, "Enseignant")).thenReturn(false);
    assertThat(service.hasRoleInProgram(5, 7, "Administrateur")).isTrue();
    assertThat(service.hasRoleInProgram(5, 7, "Enseignant")).isFalse();
  }

  @Test
  void hasRoleInCourse_delegatesTrueAndFalse() {
    when(membershipRepository.hasRoleInCourse(5, 1, "Enseignant")).thenReturn(true);
    when(membershipRepository.hasRoleInCourse(5, 2, "Enseignant")).thenReturn(false);
    assertThat(service.hasRoleInCourse(5, 1, "Enseignant")).isTrue();
    assertThat(service.hasRoleInCourse(5, 2, "Enseignant")).isFalse();
  }

  @Test
  void hasRoleInQuizCourse_delegatesTrueAndFalse() {
    when(membershipRepository.hasRoleInQuizCourse(5, 12, "Enseignant")).thenReturn(true);
    when(membershipRepository.hasRoleInQuizCourse(5, 12, "Administrateur")).thenReturn(false);
    assertThat(service.hasRoleInQuizCourse(5, 12, "Enseignant")).isTrue();
    assertThat(service.hasRoleInQuizCourse(5, 12, "Administrateur")).isFalse();
  }

  @Test
  void hasRoleInAnalysisCourse_delegatesTrueAndFalse() {
    when(membershipRepository.hasRoleInAnalysisCourse(5, 4, "Enseignant")).thenReturn(true);
    when(membershipRepository.hasRoleInAnalysisCourse(5, 4, "Administrateur")).thenReturn(false);
    assertThat(service.hasRoleInAnalysisCourse(5, 4, "Enseignant")).isTrue();
    assertThat(service.hasRoleInAnalysisCourse(5, 4, "Administrateur")).isFalse();
  }

  @Test
  void hasGlobalRole_delegatesTrueAndFalse() {
    when(membershipRepository.hasGlobalRole(5)).thenReturn(true);
    when(membershipRepository.hasGlobalRole(6)).thenReturn(false);
    assertThat(service.hasGlobalRole(5)).isTrue();
    assertThat(service.hasGlobalRole(6)).isFalse();
  }

  // ── isResourceOwner : aiguillage par type, fail-closed ─────────────────────────────

  @Test
  void isResourceOwner_post_routedToPostAuthor() {
    when(membershipRepository.isPostAuthor(5, 40)).thenReturn(true);
    assertThat(service.isResourceOwner(5, "post", 40)).isTrue();
  }

  @Test
  void isResourceOwner_postNotAuthor_denied() {
    when(membershipRepository.isPostAuthor(5, 40)).thenReturn(false);
    assertThat(service.isResourceOwner(5, "post", 40)).isFalse();
  }

  @Test
  void isResourceOwner_vote_routedToVoteOwner() {
    when(membershipRepository.isVoteOwner(5, 70)).thenReturn(true);
    assertThat(service.isResourceOwner(5, "vote", 70)).isTrue();
  }

  @Test
  void isResourceOwner_unknownTypeOrWrongCase_deniedWithoutQuery() {
    // Type inconnu ou casse différente : refus SANS requête (fail-closed).
    assertThat(service.isResourceOwner(5, "quiz", 1)).isFalse();
    assertThat(service.isResourceOwner(5, "Post", 40)).isFalse();
    verifyNoInteractions(membershipRepository);
  }

  // ── canJoin : identité absente / vide, rooms restantes ─────────────────────────────

  @Test
  void canJoin_blankOrNullEmail_deniedWithoutQuery() {
    assertThat(service.canJoin("  ", "establishment", 0)).isFalse();
    assertThat(service.canJoin(null, "establishment", 0)).isFalse();
    verifyNoInteractions(userRepository, membershipRepository);
  }

  @Test
  void programRoom_notSubscribed_denied() {
    loggedIn(5);
    when(membershipRepository.isSubscribedToProgram(5, 3)).thenReturn(false);
    assertThat(service.canJoin(EMAIL, "program", 3)).isFalse();
  }

  @Test
  void mcpRoom_notSubscribed_denied() {
    loggedIn(5);
    when(membershipRepository.canSeeCourseViaProgram(5, 3)).thenReturn(false);
    assertThat(service.canJoin(EMAIL, "mcp", 3)).isFalse();
  }

  @Test
  void scopeWrongCase_denied() {
    // Le scope est sensible à la casse : "User" n'est pas "user".
    loggedIn(5);
    assertThat(service.canJoin(EMAIL, "User", 5)).isFalse();
  }

  @Test
  void unknownUser_establishment_denied() {
    // Même la room publique exige une identité connue.
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
    assertThat(service.canJoin(EMAIL, "establishment", 0)).isFalse();
    verifyNoInteractions(membershipRepository);
  }
}
