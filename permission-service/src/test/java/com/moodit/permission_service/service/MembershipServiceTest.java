package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;
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
  void roleName_unknownId_null() {
    when(membershipRepository.findRoleNameById(99)).thenReturn(null);
    assertThat(service.roleName(99)).isNull();
  }
}
