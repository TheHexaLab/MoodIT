// Logique d'appartenance, partagee par les deux points de decision :
//   - can-join (rooms WebSocket : scope channel|forum|program|user)
//   - validate (regles REST, via PermissionService) pour la verif "voir le forum"
//
// Reprend la semantique de core DbRoomAuthorizer :
//   user    -> c'est SA propre room (id == son user_id)
//   program -> abonne au programme (User_Program)
//   channel/forum -> le forum est visible : abonne au programme du cours.

package com.moodit.permission_service.service;

import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.MembershipRepository;
import com.moodit.permission_service.repository.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class MembershipService {

  private final UserRepository userRepository;
  private final MembershipRepository membershipRepository;

  public MembershipService(
      UserRepository userRepository, MembershipRepository membershipRepository) {
    this.userRepository = userRepository;
    this.membershipRepository = membershipRepository;
  }

  /** Autorise (ou non) l'abonnement a une room WebSocket. */
  @Transactional(readOnly = true)
  public boolean canJoin(String email, String scope, long id) {
    Long userId = resolveUserId(email);
    if (userId == null) {
      return false;
    }
    return switch (scope) {
      case "user" -> id == userId;
      case "program" -> membershipRepository.isSubscribedToProgram(userId, id);
      case "channel", "forum" -> canAccessForum(userId, id);
      default -> false;
    };
  }

  /**
   * Le forum (channel ou thread) est-il accessible a l'utilisateur ?
   * Regle : etre abonne au programme du cours du forum. L'inscription directe au cours
   * (Enrollment) ne suffit PAS — un user doit faire partie d'un programme.
   */
  @Transactional(readOnly = true)
  public boolean canAccessForum(long userId, long forumId) {
    return membershipRepository.canSeeForumViaProgram(userId, forumId);
  }

  /** Resout l'id interne a partir de l'email (subject du JWT), ou null si inconnu. */
  private Long resolveUserId(String email) {
    if (email == null || email.isBlank()) {
      return null;
    }
    return userRepository.findByEmail(email).map(User::getId).map(Integer::longValue).orElse(null);
  }
}
