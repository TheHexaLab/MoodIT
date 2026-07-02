// Logique d'appartenance, partagee par les deux points de decision :
//   - can-join (rooms WebSocket : scope channel|forum|program|user)
//   - validate (regles REST, via PermissionService) pour la verif "voir le forum"
//
// Reprend la semantique de core DbRoomAuthorizer :
//   user    -> c'est SA propre room (id == son user_id)
//   program -> abonne au programme (User_Program)
//   channel/forum -> le forum est visible : abonne au programme du cours.
//   mcp     -> le cours est visible : abonne a un programme du cours.

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
      case "mcp" -> canAccessCourse(userId, id);

      // ── EXEMPLE COMMENTE (pour le collegue) : ajouter un nouveau scope de room ──
      //
      //  Cote core, le RoomAuthorizer appelle canJoin(email, scope, id) au `join` d'une
      //  room "scope:id" (ex. le front s'abonne a "quiz:42"). Pour autoriser un nouveau
      //  type de room, il suffit d'ajouter un `case` ici :
      //
      //    case "quiz" -> canAccessQuiz(userId, id);   // reutilise une verif existante
      //
      //  Si l'appartenance a verifier n'existe pas encore, on l'ajoute en 2 temps :
      //    1. une methode canAccessXxx(...) ci-dessous (transaction lecture seule) ;
      //    2. la requete SQL EXISTS correspondante dans MembershipRepository.
      //  Exemple d'une room "groupe de discussion" propre a un cours :
      //
      //    case "studygroup" -> membershipRepository.isMemberOfStudyGroup(userId, id);
      //
      //  ⚠️ Fail-closed : tout scope non reconnu tombe dans `default -> false` (join refuse).
      //     Le scope doit matcher EXACTEMENT la chaine envoyee par le core (sensible a la casse).

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

  /** Le cours (scope MCP) est-il visible ? Meme regle : etre abonne a un programme du cours. */
  @Transactional(readOnly = true)
  public boolean canAccessCourse(long userId, long courseId) {
    return membershipRepository.canSeeCourseViaProgram(userId, courseId);
  }

  /**
   * Le quiz est-il accessible (lecture / soumission REST) ? Meme regle d'appartenance :
   * etre abonne a un programme du cours auquel appartient le quiz.
   */
  @Transactional(readOnly = true)
  public boolean canAccessQuiz(long userId, long quizId) {
    return membershipRepository.canSeeQuizViaProgram(userId, quizId);
  }

  /**
   * Le cours fait-il (structurellement) partie du programme ? Lien de la table de jointure
   * program_course, independant de tout utilisateur.
   */
  @Transactional(readOnly = true)
  public boolean isCourseInProgram(long courseId, long programId) {
    return membershipRepository.isCourseInProgram(courseId, programId);
  }

  /**
   * Le cours fait-il partie des cours de l'utilisateur ? Regle : inscription directe au cours
   * (Enrollment). A distinguer de canAccessCourse, qui verifie l'acces via l'abonnement a un
   * programme du cours.
   */
  @Transactional(readOnly = true)
  public boolean isEnrolledInCourse(long userId, long courseId) {
    return membershipRepository.isEnrolledInCourse(userId, courseId);
  }

  /**
   * L'utilisateur est-il le createur (auteur) du post ? Regle : Post.user_id == userId.
   * Sert aux actions reservees a l'auteur (editer / supprimer son propre post).
   */
  @Transactional(readOnly = true)
  public boolean isPostAuthor(long userId, long postId) {
    return membershipRepository.isPostAuthor(userId, postId);
  }

  /**
   * Le vote appartient-il a l'utilisateur ? Regle : Vote.user_id == userId. Sert aux actions
   * reservees au votant (modifier / retirer son propre vote).
   */
  @Transactional(readOnly = true)
  public boolean isVoteOwner(long userId, long voteId) {
    return membershipRepository.isVoteOwner(userId, voteId);
  }

  /** Resout l'id interne a partir de l'email (subject du JWT), ou null si inconnu. */
  private Long resolveUserId(String email) {
    if (email == null || email.isBlank()) {
      return null;
    }
    return userRepository.findByEmail(email).map(User::getId).map(Integer::longValue).orElse(null);
  }
}
