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

import com.moodit.permission_service.model.ForumAccess;
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.MembershipRepository;
import com.moodit.permission_service.repository.UserRepository;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
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
      // Catalogue d'établissements : room UNIQUE (id 0), données plateforme publiques
      // (nom/domaine/programmes) → tout utilisateur authentifié peut la rejoindre.
      case "establishment" -> true;
      // Gestion des administrateurs : room UNIQUE (id 0) diffusant la liste des porteurs
      // d'un rôle GLOBAL. Réservée à ceux qui peuvent ouvrir le popup = porteurs d'un rôle
      // global (Administrateur / Gardien) — sinon on divulguerait qui est admin.
      case "adminRoles" -> hasGlobalRole(userId);

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

  /** Le forum est-il le canal d'annonces de son cours ? Seul le personnel y publie. */
  @Transactional(readOnly = true)
  public boolean isAnnouncementForum(long forumId) {
    return membershipRepository.isAnnouncementForum(forumId);
  }

  /** Accès de l'utilisateur au forum et ce que son type implique, en une seule requête. */
  @Transactional(readOnly = true)
  public ForumAccess forumAccess(long userId, long forumId) {
    return ForumAccess.ofVisibleType(membershipRepository.visibleForumType(userId, forumId));
  }

  /** Le post est-il une annonce expirée (lisible seulement par le personnel du cours) ? */
  @Transactional(readOnly = true)
  public boolean isExpiredAnnouncement(long postId) {
    return membershipRepository.isExpiredAnnouncement(postId, LocalDateTime.now(ZoneOffset.UTC));
  }

  /**
   * L'utilisateur est-il ABONNE a ce programme (User_Program) ? Verification directe de
   * l'abonnement. Sert a autoriser l'inscription a des cours d'un programme (POST /courses/users) :
   * on ne s'inscrit qu'aux cours d'un programme rejoint.
   */
  @Transactional(readOnly = true)
  public boolean isSubscribedToProgram(long userId, long programId) {
    return membershipRepository.isSubscribedToProgram(userId, programId);
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

  /** Programmes auxquels le cours est actuellement rattaché. */
  @Transactional(readOnly = true)
  public java.util.List<Long> courseProgramIds(long courseId) {
    return membershipRepository.findProgramIdsByCourse(courseId).stream()
        .map(Number::longValue)
        .toList();
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
   * L'utilisateur est-il le createur (auteur) du post ? Regle : Post.user_id == userId.
   * Sert aux actions reservees a l'auteur (editer / supprimer son propre post).
   */
  @Transactional(readOnly = true)
  public boolean isPostAuthor(long userId, long postId) {
    return membershipRepository.isPostAuthor(userId, postId);
  }

  /**
   * L'utilisateur a-t-il le role (nomme) DANS ce programme ? Regle : ligne dans
   * User_Program_Role liant user + programme + role. A distinguer du role GLOBAL
   * (user_role) verifie par PermissionService.hasRole.
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInProgram(long userId, long programId, String roleName) {
    return membershipRepository.hasRoleInProgram(userId, programId, roleName);
  }

  /**
   * L'utilisateur porte-t-il le role (nomme) dans AU MOINS UN programme (User_Program_Role), sans
   * cibler un programme precis ? Ex. roleName = "Administrateur" -> "gere-t-il un programme
   * quelconque ?". Sert a gater la liste des roles attribuables en programme
   * (GET /api/roles?scope=program), qui ne porte pas d'id de programme.
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInAnyProgram(long userId, String roleName) {
    return membershipRepository.hasRoleInAnyProgram(userId, roleName);
  }

  /**
   * L'utilisateur a-t-il le role (nomme) SUR ce cours ? Combine le role scope-programme
   * (User_Program_Role) et l'appartenance du cours a ce programme (program_course). Avec
   * roleName = "Enseignant", repond a "est-ce le prof du cours ?".
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInCourse(long userId, long courseId, String roleName) {
    return membershipRepository.hasRoleInCourse(userId, courseId, roleName);
  }

  /**
   * L'utilisateur a-t-il le role (nomme) sur le COURS DU QUIZ ? Comme hasRoleInCourse mais a
   * partir de l'id du QUIZ (routes REST /api/quizzes/{quizId} de gestion de contenu) : la
   * resolution quiz -> cours se fait cote SQL. Avec roleName = "Enseignant" -> "est-il prof du
   * cours de ce quiz ?".
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInQuizCourse(long userId, long quizId, String roleName) {
    return membershipRepository.hasRoleInQuizCourse(userId, quizId, roleName);
  }

  /**
   * L'utilisateur a-t-il le role (nomme) sur le COURS DE CETTE ANALYSE MCP ? Comme
   * hasRoleInQuizCourse mais a partir de l'id d'une ligne MCP_Response (route REST
   * GET /mcp/analyses/{id}) : la resolution analyse -> cours se fait cote SQL. Avec
   * roleName = "Enseignant" -> "est-il prof du cours de cette analyse ?".
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInAnalysisCourse(long userId, long analysisId, String roleName) {
    return membershipRepository.hasRoleInAnalysisCourse(userId, analysisId, roleName);
  }

  /**
   * L'utilisateur porte-t-il au moins un rôle GLOBAL (User_Role → Role.global_assignable) ?
   * Autorise la room WebSocket "adminRoles" (liste des administrateurs). À distinguer d'un rôle
   * global NOMMÉ (hasRole côté PermissionService) : ici c'est « un quelconque rôle plateforme ».
   */
  @Transactional(readOnly = true)
  public boolean hasGlobalRole(long userId) {
    return membershipRepository.hasGlobalRole(userId);
  }

  /**
   * Nom (Role.name) du rôle d'id donné, ou null s'il n'existe pas. Sert à décider selon le rôle
   * CIBLÉ (ex. POST /roles/global/change : seul le Gardien peut assigner un Gardien, un Admin ne
   * peut assigner qu'un Admin). Le body ne transmet que `roleId` (numérique) : on résout le nom ici.
   */
  @Transactional(readOnly = true)
  public String roleName(long roleId) {
    return membershipRepository.findRoleNameById(roleId);
  }

  /**
   * L'utilisateur a-t-il le rôle (nommé) sur le COURS DU FORUM ? Résolution forum → cours via
   * Forum.course_id (comme hasRoleInQuizCourse pour un quiz). Sert à gérer un forum (renommer /
   * supprimer via /api/forums/{forumId}). Ex. roleName = "Enseignant" → "prof du cours du forum ?".
   */
  @Transactional(readOnly = true)
  public boolean hasRoleInForumCourse(long userId, long forumId, String roleName) {
    return membershipRepository.hasRoleInForumCourse(userId, forumId, roleName);
  }

  /** Resout l'id interne a partir de l'email (subject du JWT), ou null si inconnu. */
  private Long resolveUserId(String email) {
    if (email == null || email.isBlank()) {
      return null;
    }
    return userRepository.findByEmail(email).map(User::getId).map(Integer::longValue).orElse(null);
  }
}
