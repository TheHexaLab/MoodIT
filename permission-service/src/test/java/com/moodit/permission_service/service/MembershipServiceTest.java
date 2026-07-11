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
}
