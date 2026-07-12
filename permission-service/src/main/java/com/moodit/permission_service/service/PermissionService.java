// Point de decision (PDP) pour les requetes REST (consulte par le gateway, JwtAuthFilter).
//
// Moteur de regles : une regle = (methode, motif de route avec {variables}, predicat).
// La 1re regle qui matche tranche. Aucune regle ne matche => acces autorise
// (default-allow) : on ne restreint QUE les routes explicitement listees ; l'identite
// est deja garantie par le gateway (JWT) + l'auth-service.
//
// ⚠️ HYPOTHESE DE CONFIANCE (IMPORTANTE) : depuis la centralisation de l'autorisation ici,
// les services aval (core, mcp) ne re-verifient PLUS les roles ; ils font confiance au header
// X-User-Email injecte par le gateway. La securite repose donc ENTIEREMENT sur le fait que le
// gateway est l'UNIQUE porte d'entree : les services ne doivent PAS etre joignables directement
// (isolation reseau / NetworkPolicy — seul le gateway les atteint). Un service expose hors
// gateway serait sans controle d'acces. Les appels service-a-service internes passent, eux, par
// le header partage X-Internal-Token (endpoints /internal/**), hors de ce moteur.
//
// NB (403 vs 404) : le default-allow-sur-absence-de-regle implique qu'une regle qui refuse
// renvoie un 403 AVANT que le service n'ait pu constater une eventuelle absence de ressource
// (404). Un non-gestionnaire recoit donc 403 meme pour une ressource inexistante (on ne divulgue
// pas son existence), la ou un admin global atteint le service et obtient le 404. Asymetrie
// assumee (pas de fuite d'existence cote non-autorise).
//
// Les ids de ressource peuvent etre dans l'URL (variables de path) OU dans le body
// JSON (convention REST de l'equipe : ex. forumId dans PostCreateInForumDTO). Le
// gateway transmet donc le body brut ; on en extrait le champ voulu de facon
// GENERIQUE (lecture par nom, pas de classe DTO partagee avec core).
//
// REGISTRE A COMPLETER une par une, au fil des contrôleurs REST du core
// (frontend/src/pages/Dashboard/dashboardApi.ts pour les actions).

package com.moodit.permission_service.service;

import com.moodit.permission_service.model.Role;
import com.moodit.permission_service.model.RoleNames;
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.UserRepository;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.util.AntPathMatcher;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@Service
public class PermissionService {

  private final UserRepository userRepository;
  private final MembershipService membershipService;
  private final ObjectMapper objectMapper;
  private final AntPathMatcher matcher = new AntPathMatcher();
  private final List<Rule> rules;

  public PermissionService (
      UserRepository userRepository,
      MembershipService membershipService,
      ObjectMapper objectMapper) {
    this.userRepository = userRepository;
    this.membershipService = membershipService;
    this.objectMapper = objectMapper;
    this.rules = buildRules();
  }

  // Decision pour une route : a partir du user, des variables de path et du body JSON
  // (un noeud "missing" si la requete n'a pas de corps).
  @FunctionalInterface
  private interface AccessCheck {
    boolean allow(User user, Map<String, String> pathVars, JsonNode body);
  }

  // Variante d'AccessCheck qui recoit EN PLUS les parametres de la query string (?a=1&b=2),
  // pour les routes dont l'autorisation depend d'un parametre de requete (ex. /roles?scope=...).
  // Le gateway transmet la query string brute ; on la parse en map avant l'appel.
  @FunctionalInterface
  private interface QueryAccessCheck {
    boolean allow(
        User user, Map<String, String> pathVars, JsonNode body, Map<String, String> query);
  }

  // Une regle porte toujours un QueryAccessCheck ; les regles « simples » (3 arguments) sont
  // adaptees par la fabrique rule(...) qui ignore la query.
  private record Rule(String method, String pattern, QueryAccessCheck check) {}

  // Prefixe commun a TOUTES les routes REST. Cote core, il est ajoute automatiquement aux
  // controleurs (WebConfig.configurePathMatch -> addPathPrefix("/api", ...)), donc le path
  // reel qui arrive ici commence toujours par "/api". On l'ajoute une seule fois via la
  // fabrique rule(...) pour ne pas avoir a le repeter (ni risquer de l'oublier) dans chaque
  // regle : on ecrit "/forums/posts", pas "/api/forums/posts".
  private static final String API_PREFIX = "/api";

  // Fabrique une regle avec le prefixe /api applique au motif. TOUJOURS passer par ici
  // plutot que `new Rule(...)` directement, pour garder les motifs sans "/api".
  private static Rule rule(String method, String path, AccessCheck check) {
    return new Rule(method, API_PREFIX + path, (user, vars, body, query) -> check.allow(user, vars, body));
  }

  // Variante pour une regle dont l'autorisation depend d'un parametre de query string
  // (le predicat recoit la map des parametres ?a=1&b=2). Ex. GET /roles?scope=global|program.
  private static Rule rule(String method, String path, QueryAccessCheck check) {
    return new Rule(method, API_PREFIX + path, check);
  }

  // Prefixe des routes du mcp-service. Contrairement au core, elles ne portent PAS "/api"
  // (gateway route[2] : Path=/mcp/**). On les enregistre donc avec leur propre fabrique
  // pour garder les motifs sans "/mcp" dans le registre (ex. "/courses/{id}/analyses").
  private static final String MCP_PREFIX = "/mcp";

  private static Rule mcpRule(String method, String path, AccessCheck check) {
    return new Rule(method, MCP_PREFIX + path, (user, vars, body, query) -> check.allow(user, vars, body));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  REGISTRE DES REGLES — c'est ICI qu'on ajoute une regle, route par route.
  // ═══════════════════════════════════════════════════════════════════════════════════
  //
  //  RECETTE pour ajouter une regle :
  //    1. Regarder le controleur core concerne (ForumController, ProgramController,
  //       QuizController...) : relever la METHODE HTTP et le CHEMIN exact.
  //    2. Reperer ou est l'id de la ressource a proteger :
  //         - dans le CHEMIN     -> utiliser un motif {var} et le lire via `vars`
  //                                 (ex. "/quizzes/{quizId}" -> vars.get("quizId")).
  //         - dans le BODY JSON  -> le lire via `longField(body, "forumId")`.
  //           (convention de l'equipe : les POST de creation mettent l'id parent dans le
  //            body, ex. forumId dans PostCreateInForumDTO. Le gateway nous transmet le body.)
  //    3. Choisir le predicat d'autorisation :
  //         - APPARTENANCE (fin) : membershipService.canAccessForum / canAccessCourse /
  //           canAccessQuiz (delegue au MembershipRepository, SQL sur init.sql).
  //         - ROLE (grossier)    : hasRole(user, RoleNames.ADMIN).
  //    4. Ajouter `rule(methode, motif, (user, vars, body) -> <predicat>)` a la liste.
  //       ⚠️ Ecrire le motif SANS "/api" : la fabrique rule(...) l'ajoute automatiquement
  //          (ex. "/forums/posts", pas "/api/forums/posts").
  //
  //  RAPPELS sur le moteur (voir aussi l'en-tete de la classe) :
  //    - La 1re regle qui matche (methode + motif) tranche ; l'ordre compte.
  //    - AUCUNE regle ne matche => acces AUTORISE (default-allow). On ne liste donc QUE
  //      les routes a restreindre ; l'identite est deja garantie par le gateway (JWT).
  //    - Un predicat qui renvoie false => 403 cote gateway. Toute exception => refus.
  //    - Toujours valider que l'id est > 0 avant d'interroger la BD (voir exemples).
  //
  //  CONVENTIONS de placement de l'id selon le verbe :
  //    - POST creation   -> id parent dans le BODY   (canAccess...(body.xxxId))
  //    - GET / PUT / DELETE / sous-ressource -> id dans le PATH (vars.get("xxxId"))
  // ═══════════════════════════════════════════════════════════════════════════════════
  private List<Rule> buildRules() {
    return List.of(
            // ── Establishment ───────────────────────────────────────────────────────────
            /* Lister les établissements dans lesquels l'usager peut en crééer un programme
            * FetchEstablishmentsForCreate*/
            rule(
                    "GET",
                    "/users/{userId}/programs/{programId}/enrollments",
                    (user, vars, body) -> verifyUserId(user, vars)
            ),

            // ── Program ─────────────────────────────────────────────────────────────────
            //Afficher tous les users abonnés à un programme
            //FetchProgramsRoles, Frontend
            rule(
                    "GET",
                    "/programs/{programId}/users",
                    (user, vars, body) -> canViewProgramUsers(user, vars)),
            //La liste des roles et la liste des membres avec le role de chacun
            //FetchProgram, Frontend
            rule(
                    "GET",
                    "/users/{userId}/programs",
                    (user, vars, body) -> verifyUserId(user, vars)
            ),

            // ── Establishment (GESTION) ───────────────────────────────────────────────────
            // Créer / modifier / supprimer un ÉTABLISSEMENT : réservé au Gardien (gestionnaire des
            // établissements). Les LECTURES (GET /establishments, .../programs, .../manageable-programs)
            // restent ouvertes : elles alimentent aussi les flux création/adhésion (non-gardien).
            rule("POST", "/establishments", (user, vars, body) -> hasRole(user, RoleNames.GUARDIAN)),
            rule(
                    "PATCH",
                    "/establishments/{establishmentId}",
                    (user, vars, body) -> hasRole(user, RoleNames.GUARDIAN)),
            rule(
                    "DELETE",
                    "/establishments/{establishmentId}",
                    (user, vars, body) -> hasRole(user, RoleNames.GUARDIAN)),

            // Créer un PROGRAMME dans un établissement : action d'administration plateforme,
            // réservée à l'Administrateur/Gardien GLOBAL (pas de rôle « admin d'établissement »
            // dans le modèle actuel — cf. TODO). establishmentId est dans le body, mais le
            // prédicat est purement rôle-global donc on ne le lit pas ici.
            //createProgram, Frontend
            rule(
                    "POST",
                    "/establishments/programs",
                    (user, vars, body) ->
                        hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)),

            // ── Modifier un PROGRAMME (PATCH /programs/{programId}) ────────────────────────
            // Réservé à : Administrateur/Gardien GLOBAL (User_Role), OU Administrateur DU
            // programme (User_Program_Role) — PAS l'Enseignant. programId dans le PATH.
            rule(
                    "PATCH",
                    "/programs/{programId}",
                    (user, vars, body) -> canManageProgram(user, vars, "programId")),

            // ── Creer un cours dans des programmes (programIds dans le BODY) ──────────────
            // Administrateur/Gardien GLOBAL (user_role), OU Administrateur/Enseignant DANS
            // CHACUN des programmes vises (User_Program_Role). Aligne sur addCourseToPrograms
            // du core (gerer TOUS les programmes demandes, sinon 403).
            //createCourse, Frontend
            rule(
                    "POST",
                    "/programs/courses",
                    (user, vars, body) -> canCreateCourse(user, body)),

            // ── Course ──────────────────────────────────────────────────────────────────
            // NB : la route GET /users/{userId}/programs/{programId}/enrollments (cours de
            // l'utilisateur dans un programme) est déjà déclarée plus haut (section Establishment).
            // On ne la re-déclare PAS ici : first-match-wins → un doublon serait mort.

            // Modifier un COURS (titre / code / programmes) : gestion de contenu du cours =
            // Administrateur/Gardien GLOBAL, OU Administrateur/Enseignant DANS un programme
            // contenant le cours. courseId dans le PATH. Aligné sur updateProgram / quizzes.
            //updateCourse, Frontend
            rule(
                    "PATCH",
                    "/courses/{courseId}",
                    (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),

            rule(
                    "DELETE",
                    "/courses/{courseId}/users/{userId}",
                    (user, vars, body) -> verifyUserId(user, vars)),
            // ── Forum ───────────────────────────────────────────────────────────────────
            // Ecrire un post : il faut voir le forum. forumId dans PostCreateInForumDTO.
            rule(
                    "POST",
                    "/forums/posts",
                    (user, vars, body) -> {
                      long forumId = longField(body, "forumId");
                      return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
                    }),

            // Voter sur un post : meme contrainte (le forum du post). forumId dans VoteCreateInPostDTO.
            rule(
                    "POST",
                    "/forums/posts/votes",
                    (user, vars, body) -> {
                      long forumId = longField(body, "forumId");
                      return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
                    }),

            // Lire les sujets/messages d'un forum : etre abonne a un programme du cours du forum.
            // forumId dans le PATH. Couvre : sujets racines ('Thread') + reponses d'un post +
            // messages d'un canal ('Discussion').
            rule(
                    "GET",
                    "/forums/{forumId}/posts",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),
            rule(
                    "GET",
                    "/forums/{forumId}/posts/{postId}/replies",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),
            rule(
                    "GET",
                    "/forums/{forumId}/messages",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),

            // Envoyer un message dans un canal 'Discussion' : meme appartenance que poster
            // (le forum du message). forumId dans PostCreateInForumDTO (BODY).
            rule(
                    "POST",
                    "/forums/messages",
                    (user, vars, body) -> {
                      long forumId = longField(body, "forumId");
                      return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
                    }),

            // Editer / supprimer un post ou message : reserve a SON AUTEUR (Post.user_id). On
            // protege via le postId (PATH) ; le forumId du motif n'intervient pas dans la decision.
            rule(
                    "PATCH",
                    "/forums/{forumId}/posts/{postId}",
                    (user, vars, body) -> isPostAuthor(user, vars, "postId")),
            rule(
                    "DELETE",
                    "/forums/{forumId}/posts/{postId}",
                    (user, vars, body) -> isPostAuthor(user, vars, "postId")),

            // ── Course / Program : structure, inscription, abonnement ─────────────────────
            // Lister les forums d'un cours (canaux 'Discussion' + forums 'Thread', filtres par
            // ?typeId) : etre abonne a un programme du cours OU en gerer le contenu (meme regle
            // que la liste des quiz publies). courseId dans le PATH.
            rule(
                    "GET",
                    "/courses/{courseId}/forums",
                    (user, vars, body) -> {
                      long courseId = longVar(vars, "courseId");
                      return courseId > 0
                          && (membershipService.canAccessCourse(user.getId(), courseId)
                              || canManageCourseContent(user, vars, "courseId"));
                    }),

            // Modifier la structure d'un cours (canaux/forums : ajout/renommage/suppression/ordre) :
            // gestion de contenu du cours. courseId dans le PATH.
            rule(
                    "PATCH",
                    "/courses/{courseId}/sections",
                    (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),

            // S'inscrire a des cours d'un programme : uniquement POUR SOI (body.id == user), en
            // etant abonne au programme vise, ET chaque cours demande doit APPARTENIR a ce
            // programme (program_course). Sans ce dernier point, un abonne pourrait, via un
            // programId valide, s'inscrire a des cours d'un autre programme (id + courseIds +
            // programId dans UserCreateInCoursesDTO, BODY). courseIds vide = sync a zero (autorise).
            rule(
                    "POST",
                    "/courses/users",
                    (user, vars, body) -> {
                      if (!isSelfFromBody(user, body, "id")) {
                        return false;
                      }
                      long programId = longField(body, "programId");
                      if (programId <= 0
                          || !membershipService.isSubscribedToProgram(user.getId(), programId)) {
                        return false;
                      }
                      return longArrayField(body, "courseIds").stream()
                          .allMatch(cid -> membershipService.isCourseInProgram(cid, programId));
                    }),

            // Quitter un programme : uniquement SE retirer soi-meme (userId dans le PATH).
            rule(
                    "DELETE",
                    "/programs/{programId}/users/{userId}",
                    (user, vars, body) -> isSelfFromPath(user, vars, "userId")),

        // ── QUIZ ─────────────────────────────────────────────────────────────────
        // GESTION DE CONTENU (creer / editer / supprimer / reordonner un quiz, voir le detail
        // editeur) : reservee a qui gere le CONTENU du cours = Administrateur/Gardien GLOBAL,
        // OU Administrateur/Enseignant DANS un programme contenant le cours. Aligne sur
        // QuizService.requireCourseAccess du core (403 sinon).
            // Creer un quiz dans un cours (courseId dans le PATH).
            rule(
                "POST",
                "/courses/{courseId}/quizzes",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            // Reordonner les quiz d'un cours (courseId dans le PATH).
            rule(
                "PATCH",
                "/courses/{courseId}/quizzes/reorder",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            // Lister les quiz pour la GESTION (vue editeur : brouillons compris). Route DEDIEE
            // (distincte de GET /courses/{id}/quizzes, vue etudiant publiee) pour etre gatee ici :
            // la vue etudiant/editeur ne se distinguait que par un query param, invisible du path.
            rule(
                "GET",
                "/courses/{courseId}/quizzes/manage",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            // Lister les quiz PUBLIES d'un cours (vue etudiant) : etre abonne a un programme du
            // cours (meme appartenance que la lecture d'un quiz) OU gerer le contenu du cours
            // (Admin/Gardien global, ou Admin/Enseignant du programme) — un enseignant non abonne
            // doit garder acces a la liste publiee. Evite qu'un authentifie quelconque enumere les
            // quiz d'un cours ou il n'a rien a faire (sinon default-allow).
            rule(
                "GET",
                "/courses/{courseId}/quizzes",
                (user, vars, body) -> {
                  long courseId = longVar(vars, "courseId");
                  return courseId > 0
                      && (membershipService.canAccessCourse(user.getId(), courseId)
                          || canManageCourseContent(user, vars, "courseId"));
                }),
            // Detail EDITEUR d'un quiz (avec correction) : gestion de contenu (quizId dans le PATH).
            rule(
                "GET",
                "/quizzes/{quizId}/edit",
                (user, vars, body) -> canManageQuizContent(user, vars, "quizId")),
            rule(
                "PUT",
                "/quizzes/{quizId}",
                (user, vars, body) -> canManageQuizContent(user, vars, "quizId")),
            rule(
                "DELETE",
                "/quizzes/{quizId}",
                (user, vars, body) -> canManageQuizContent(user, vars, "quizId")),

        // Lire un quiz / soumettre / consulter ses tentatives (quizId dans le PATH) :
        // etre abonne a un programme du cours du quiz.
            rule("GET", "/quizzes/{quizId}", (user, vars, body) -> quizAccess(user, vars)),
            rule(
            "POST",
            "/quizzes/{quizId}/submissions",
            (user, vars, body) -> quizAccess(user, vars)),
            rule(
            "GET", "/quizzes/{quizId}/attempts", (user, vars, body) -> quizAccess(user, vars)),
            rule(
            "GET",
            "/quizzes/{quizId}/attempts/{attemptId}",
            (user, vars, body) -> quizAccess(user, vars)),

            // ── MCP (feedback de cours) ───────────────────────────────────────────────
            // GESTION DE CONTENU du cours : Administrateur/Gardien GLOBAL, OU
            // Administrateur/Enseignant DANS un programme contenant le cours. Aligne sur
            // l'ancien McpService.requireCourseAccess (desormais retire : permission-service
            // est l'unique autorite). ⚠️ Routes SANS "/api" -> fabrique mcpRule.
            //
            // courseId dans le PATH -> reutilise canManageCourseContent.
            mcpRule(
                "GET",
                "/courses/{courseId}/analyses",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            mcpRule(
                "POST",
                "/courses/{courseId}/analyses",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            mcpRule(
                "GET",
                "/courses/{courseId}/pending",
                (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),
            // id de l'ANALYSE dans le PATH -> resolution analyse -> cours cote SQL.
            mcpRule(
                "GET",
                "/analyses/{id}",
                (user, vars, body) -> canManageAnalysisContent(user, vars, "id")),

            // ── Roles (attribution / retrait) ─────────────────────────────────────────
            // Changer un role PROGRAMME (User_Program_Role) : Administrateur/Gardien GLOBAL,
            // OU Administrateur DANS le programme vise. programId dans le BODY (ChangeRoleRequest).
            rule(
                "POST",
                "/roles/change",
                (user, vars, body) -> {
                  if (hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)) {
                    return true;
                  }
                  long programId = longField(body, "programId");
                  return programId > 0
                      && membershipService.hasRoleInProgram(
                          user.getId(), programId, RoleNames.ADMIN);
                }),
            // Changer un role GLOBAL (User_Role) : reserve au Gardien (gere les administrateurs).
            rule(
                "POST",
                "/roles/global/change",
                (user, vars, body) -> {
                  // Modifier un role GLOBAL (type + roleId dans le body) :
                  //   RETRAIT (type=unassign) -> Gardien UNIQUEMENT (peu importe le role retire) ;
                  //   AJOUT   (type=assign)   -> selon le role CIBLE : Gardien pour assigner un
                  //     Gardien ; Gardien OU Admin pour assigner un Admin ;
                  //   type absent / inconnu, ou role non global -> refus (fail-closed).
                  String type = stringField(body, "type");
                  if ("unassign".equals(type)) {
                    return hasRole(user, RoleNames.GUARDIAN);
                  }
                  if (!"assign".equals(type)) {
                    return false;
                  }
                  long roleId = longField(body, "roleId");
                  if (roleId <= 0) {
                    return false;
                  }
                  String target = membershipService.roleName(roleId);
                  if (RoleNames.GUARDIAN.equals(target)) {
                    return hasRole(user, RoleNames.GUARDIAN);
                  }
                  if (RoleNames.ADMIN.equals(target)) {
                    return hasRole(user, RoleNames.GUARDIAN) || hasRole(user, RoleNames.ADMIN);
                  }
                  return false;
                }),
            // Lister les usagers a role GLOBAL (popup admins) : Gardien OU Admin (meme portee de
            // lecture que GET /roles?scope=global). Le core l'expose en GET (RoleController).
            rule(
                "GET",
                "/roles/global/users",
                (user, vars, body) ->
                    hasRole(user, RoleNames.GUARDIAN) || hasRole(user, RoleNames.ADMIN)),
            // Lister les roles attribuables — permissions DIFFERENTES selon ?scope (dans la QUERY,
            // transmise par le gateway) :
            //   scope=global  (popup admins plateforme) -> porteur d'un role GLOBAL (Admin/Gardien).
            //   scope=program (RoleEditorPopup)          -> Admin d'AU MOINS un programme, OU role
            //                                               global. Aligne sur POST /roles/change.
            //   scope absent / inconnu -> refus (fail-closed).
            rule(
                "GET",
                "/roles",
                (user, vars, body, query) ->
                    switch (query.getOrDefault("scope", "")) {
                      case "global" -> membershipService.hasGlobalRole(user.getId());
                      case "program" ->
                          membershipService.hasGlobalRole(user.getId())
                              || membershipService.hasRoleInAnyProgram(
                                  user.getId(), RoleNames.ADMIN);
                      default -> false;
                    }),
            // ═══════════════════════════════════════════════════════════════════════════
            //  AUDIT PERMISSIONS — trous comblés (routes sensibles avant en default-allow).
            //  Motifs disjoints (methode + nb de segments) des regles ci-dessus : l'ordre
            //  d'insertion ici est sans effet sur le first-match-wins.
            // ═══════════════════════════════════════════════════════════════════════════

            // Supprimer un PROGRAMME (destructif, cascade) : meme regle que le PATCH programme
            // (Admin/Gardien global OU Admin du programme). programId dans le PATH.
            rule(
                    "DELETE",
                    "/programs/{programId}",
                    (user, vars, body) -> canManageProgram(user, vars, "programId")),

            // Supprimer un COURS (destructif, cascade) : gestion de contenu du cours.
            rule(
                    "DELETE",
                    "/courses/{courseId}",
                    (user, vars, body) -> canManageCourseContent(user, vars, "courseId")),

            // Modifier le profil d'un usager (par id) : soi-meme (userId dans le PATH) OU
            // Admin/Gardien global. (L'edition de SON profil passe par /me, non gate ici.)
            rule(
                    "PATCH",
                    "/users/{userId}",
                    (user, vars, body) ->
                        isSelfFromPath(user, vars, "userId")
                            || hasRole(user, RoleNames.ADMIN)
                            || hasRole(user, RoleNames.GUARDIAN)),

            // Creer un forum/canal dans un cours : gestion de contenu. courseId dans le BODY (ForumDTO).
            rule(
                    "POST",
                    "/courses/forums",
                    (user, vars, body) ->
                        canManageCourseContentById(user, longField(body, "courseId"))),

            // Renommer / supprimer un forum : gestion de contenu du cours du forum (forumId PATH).
            rule(
                    "PATCH",
                    "/forums/{forumId}",
                    (user, vars, body) -> canManageForumContent(user, vars, "forumId")),
            rule(
                    "DELETE",
                    "/forums/{forumId}",
                    (user, vars, body) -> canManageForumContent(user, vars, "forumId")),

            // Lire un forum precis / son type / un post precis / un forum d'un cours : etre abonne
            // au programme du cours du forum (meme appartenance que lire les sujets). forumId PATH.
            rule(
                    "GET",
                    "/forums/{forumId}",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),
            rule(
                    "GET",
                    "/forums/{forumId}/f_type",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),
            rule(
                    "GET",
                    "/forums/{forumId}/posts/{postId}",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),
            rule(
                    "GET",
                    "/courses/{courseId}/forums/{forumId}",
                    (user, vars, body) -> canAccessForum(user, vars, "forumId")),

            // Candidats a un role GLOBAL (popup admins) : liste d'usagers -> Gardien OU Admin.
            rule(
                    "GET",
                    "/roles/global/candidates",
                    (user, vars, body) ->
                        hasRole(user, RoleNames.GUARDIAN) || hasRole(user, RoleNames.ADMIN)),

            // Candidats a un role dans un PROGRAMME : liste d'usagers du programme -> meme regle
            // que voir les membres (Admin/Gardien global OU Admin du programme). programId PATH.
            rule(
                    "GET",
                    "/programs/{programId}/role-candidates",
                    (user, vars, body) -> canViewProgramUsers(user, vars)),

            // Abonner un usager a des programmes (join) : uniquement POUR SOI (body.id == user).
            // L'abonnement au catalogue est self-service ; on empeche d'abonner autrui.
            rule(
                    "POST",
                    "/programs/users",
                    (user, vars, body) -> isSelfFromBody(user, body, "id")),

            // Lire des donnees d'un usager (hors /me) : soi-meme OU Admin/Gardien global.
            rule(
                    "GET",
                    "/users/{userId}",
                    (user, vars, body) ->
                        isSelfFromPath(user, vars, "userId")
                            || hasRole(user, RoleNames.ADMIN)
                            || hasRole(user, RoleNames.GUARDIAN)),
            // Ses inscriptions (cours) : soi-meme uniquement (aligne sur les autres /users/{id}/*).
            rule(
                    "GET",
                    "/users/{userId}/enrollments",
                    (user, vars, body) -> verifyUserId(user, vars)),
            // Recherche d'un usager par username : action de gestion -> Admin/Gardien global.
            rule(
                    "GET",
                    "/users/username/{username}",
                    (user, vars, body) ->
                        hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)),
            // Lister les usagers d'un role dans un programme : meme regle que voir les membres.
            rule(
                    "GET",
                    "/users/role/{role}/programs/{programId}",
                    (user, vars, body) -> canViewProgramUsers(user, vars)),

            // Consulter le JOURNAL D'AUDIT : reserve au Gardien.
            rule(
                "GET",
                "/audit-logs",
                (user, vars, body) -> hasRole(user, RoleNames.GUARDIAN))

        // ── EXEMPLE COMMENTE : a decommenter + adapter ────────
        //
        //  Cas : editer un post d'un forum.  Controleur core -> ForumController :
        //    @PatchMapping("/forums/{forumId}/posts/{postId}")   (le /api est ajoute par le core)
        //  L'id du forum est dans le PATH (pas dans le body) => on le lit via `vars`.
        //  Autorisation voulue : etre membre du forum (meme regle d'appartenance qu'un post).
        //
        //  Etapes appliquees (voir la RECETTE en haut de la methode) :
        //    1. methode = "PATCH", motif = "/forums/{forumId}/posts/{postId}"  (SANS /api)
        //    2. id dans le PATH -> longVar(vars, "forumId")
        //    3. predicat = appartenance -> membershipService.canAccessForum(...)
        //    4. on garde le meme style que les regles quiz ci-dessus.
        //
        //  rule(
        //      "PATCH",
        //      "/forums/{forumId}/posts/{postId}",
        //      (user, vars, body) -> {
        //        long forumId = longVar(vars, "forumId");        // id dans le PATH
        //        return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
        //      }),
        //
        //  Variante « role » (ex. supprimer un post reserve aux Administrateurs) :
        //  rule(
        //      "DELETE",
        //      "/forums/{forumId}/posts/{postId}",
        //      (user, vars, body) -> hasRole(user, RoleNames.ADMIN)),
        //
        //  Variante « id dans le BODY » (POST de creation, cf. regles forums plus haut) :
        //  rule(
        //      "POST",
        //      "/forums/comments",
        //      (user, vars, body) -> {
        //        long forumId = longField(body, "forumId");      // id dans le BODY
        //        return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
        //      }),
        //
        //  ⚠️ La derniere regle de la liste ne prend PAS de virgule finale — pense a
        //     ajouter la virgule sur la regle quiz au-dessus quand tu decommentes ici.
        );
  }

  // Surcharge sans query string (routes dont l'autorisation n'en depend pas). Delegue avec une
  // query nulle -> map vide cote predicat.
  public boolean isAllowed(String email, String path, String method, String body) {
    return isAllowed(email, path, method, body, null);
  }

  public boolean isAllowed(String email, String path, String method, String body, String query) {
    if (email == null || email.isBlank() || path == null || method == null) {
      return false;
    }

    // 1) Chercher une regle applicable AVANT toute requete BD / tout parsing.
    for (Rule rule : rules) {
      if (method.equalsIgnoreCase(rule.method()) && matcher.match(rule.pattern(), path)) {
        // 2) Une regle s'applique : on charge le user et on parse body/query seulement maintenant.
        User user = userRepository.findByEmail(email).orElse(null);
        if (user == null) {
          return false; // identite inconnue : fail-closed.
        }
        Map<String, String> vars = matcher.extractUriTemplateVariables(rule.pattern(), path);
        JsonNode bodyJson = parseBody(body);
        Map<String, String> queryParams = parseQuery(query);
        try {
          return rule.check().allow(user, vars, bodyJson, queryParams);
        } catch (Exception e) {
          return false; // donnee de path/body/query invalide : refus.
        }
      }
    }

    // 3) Aucune regle ne restreint cette route : approbation directe, ZERO requete BD.
    return true;
  }

  // Parse une query string brute ("a=1&b=2") en map parametre -> valeur (decodage %xx). Renvoie
  // une map vide si null/vide. Un parametre sans '=' -> valeur "". La 1re occurrence l'emporte.
  private static Map<String, String> parseQuery(String query) {
    if (query == null || query.isBlank()) {
      return Map.of();
    }
    Map<String, String> params = new HashMap<>();
    for (String pair : query.split("&")) {
      if (pair.isEmpty()) {
        continue;
      }
      int eq = pair.indexOf('=');
      String key = eq >= 0 ? pair.substring(0, eq) : pair;
      String value = eq >= 0 ? pair.substring(eq + 1) : "";
      params.putIfAbsent(
          URLDecoder.decode(key, StandardCharsets.UTF_8),
          URLDecoder.decode(value, StandardCharsets.UTF_8));
    }
    return params;
  }

  // Parse le body JSON ; renvoie un objet vide si absent/illisible (les .path(...)
  // restent surs et renvoient des valeurs par defaut).
  private JsonNode parseBody(String body) {
    if (body != null && !body.isBlank()) {
      try {
        return objectMapper.readTree(body);
      } catch (Exception e) {
        // body illisible -> noeud vide ci-dessous
      }
    }
    return objectMapper.createObjectNode();
  }

  // Lit un champ entier (long) du body JSON ; -1 si absent / non numerique.
  private static long longField(JsonNode body, String field) {
    JsonNode node = body.path(field);
    return node.canConvertToLong() ? node.longValue() : -1;
  }

  // Lit un champ CHAINE du body JSON ; "" si absent / non textuel.
  private static String stringField(JsonNode body, String field) {
    JsonNode node = body.path(field);
    return node.isString() ? node.stringValue() : "";
  }

  // Lit un champ TABLEAU d'entiers (long) du body JSON ; liste vide si absent / non tableau.
  // Les elements non numeriques sont ignores.
  private static List<Long> longArrayField(JsonNode body, String field) {
    JsonNode node = body.path(field);
    if (!node.isArray()) {
      return List.of();
    }
    List<Long> ids = new ArrayList<>();
    for (JsonNode element : node) {
      if (element.canConvertToLong()) {
        ids.add(element.longValue());
      }
    }
    return ids;
  }

  private boolean canViewProgramUsers(User user, Map<String, String> vars) {
    if (hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)) {
      return true;
    }
    long programId = longVar(vars, "programId");
    return programId > 0
            && membershipService.hasRoleInProgram(user.getId(), programId, RoleNames.ADMIN);
  }

  // ── Creer un cours dans des programmes (programIds dans le BODY) ────────────────────
  // Administrateur/Gardien GLOBAL (user_role) -> partout. Sinon, il faut etre Administrateur
  // ou Enseignant DANS CHACUN des programmes vises (User_Program_Role) : meme exigence que
  // addCourseToPrograms du core (gerer TOUS les programmes demandes, sinon 403).
  private boolean canCreateCourse(User user, JsonNode body) {
    if (hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)) {
      return true;
    }
    List<Long> programIds = longArrayField(body, "programIds");
    return !programIds.isEmpty() && programIds.stream().allMatch(pid -> managesProgram(user, pid));
  }

  // L'utilisateur est-il Administrateur ou Enseignant DANS ce programme (User_Program_Role) ?
  private boolean managesProgram(User user, long programId) {
    return programId > 0
        && (membershipService.hasRoleInProgram(user.getId(), programId, RoleNames.ADMIN)
            || membershipService.hasRoleInProgram(user.getId(), programId, RoleNames.TEACHER));
  }

  // ── Gestion d'un PROGRAMME (modifier / supprimer) ─────────────────────────────────────
  // Administrateur/Gardien GLOBAL (user_role) -> partout. Sinon, Administrateur DU programme
  // (User_Program_Role) — PAS l'Enseignant. programId lu dans une variable de PATH.
  private boolean canManageProgram(User user, Map<String, String> vars, String programVar) {
    if (hasRole(user, RoleNames.ADMIN) || hasRole(user, RoleNames.GUARDIAN)) {
      return true;
    }
    long programId = longVar(vars, programVar);
    return programId > 0
        && membershipService.hasRoleInProgram(user.getId(), programId, RoleNames.ADMIN);
  }

  // ── Gestion du CONTENU d'un cours (quiz, sections...) ─────────────────────────────────
  // Administrateur/Gardien GLOBAL (user_role) -> tous les cours. Sinon, Administrateur ou
  // Enseignant DANS un programme contenant le cours (User_Program_Role + program_course).
  // Aligne sur QuizService.requireCourseAccess du core. courseId lu dans une variable de PATH.
  private boolean canManageCourseContent(User user, Map<String, String> vars, String courseVar) {
    return canManageCourseContentById(user, longVar(vars, courseVar));
  }

  // Meme regle que canManageCourseContent, mais a partir d'un courseId deja resolu (ex. lu dans
  // le BODY : POST /courses/forums -> ForumDTO.courseId).
  private boolean canManageCourseContentById(User user, long courseId) {
    if (courseId <= 0) {
      return false;
    }
    return hasRole(user, RoleNames.ADMIN)
        || hasRole(user, RoleNames.GUARDIAN)
        || membershipService.hasRoleInCourse(user.getId(), courseId, RoleNames.ADMIN)
        || membershipService.hasRoleInCourse(user.getId(), courseId, RoleNames.TEACHER);
  }

  // Meme regle que canManageCourseContent, mais a partir de l'id d'un FORUM (le cours est resolu
  // cote SQL via Forum.course_id). Sert a gerer un forum (renommer / supprimer). forumId lu dans
  // une variable de PATH.
  private boolean canManageForumContent(User user, Map<String, String> vars, String forumVar) {
    long forumId = longVar(vars, forumVar);
    if (forumId <= 0) {
      return false;
    }
    return hasRole(user, RoleNames.ADMIN)
        || hasRole(user, RoleNames.GUARDIAN)
        || membershipService.hasRoleInForumCourse(user.getId(), forumId, RoleNames.ADMIN)
        || membershipService.hasRoleInForumCourse(user.getId(), forumId, RoleNames.TEACHER);
  }

  // Meme regle que canManageCourseContent, mais a partir de l'id d'un QUIZ (le cours est resolu
  // cote SQL via Quiz.course_id). quizId lu dans une variable de PATH.
  private boolean canManageQuizContent(User user, Map<String, String> vars, String quizVar) {
    long quizId = longVar(vars, quizVar);
    if (quizId <= 0) {
      return false;
    }
    return hasRole(user, RoleNames.ADMIN)
        || hasRole(user, RoleNames.GUARDIAN)
        || membershipService.hasRoleInQuizCourse(user.getId(), quizId, RoleNames.ADMIN)
        || membershipService.hasRoleInQuizCourse(user.getId(), quizId, RoleNames.TEACHER);
  }

  // Meme regle que canManageCourseContent, mais a partir de l'id d'une ANALYSE MCP (le cours
  // est resolu cote SQL via MCP_Response.course_id). id lu dans une variable de PATH.
  private boolean canManageAnalysisContent(User user, Map<String, String> vars, String analysisVar) {
    long analysisId = longVar(vars, analysisVar);
    if (analysisId <= 0) {
      return false;
    }
    return hasRole(user, RoleNames.ADMIN)
        || hasRole(user, RoleNames.GUARDIAN)
        || membershipService.hasRoleInAnalysisCourse(user.getId(), analysisId, RoleNames.ADMIN)
        || membershipService.hasRoleInAnalysisCourse(user.getId(), analysisId, RoleNames.TEACHER);
  }

  // Acces a un quiz (quizId dans les variables de path) : abonne a un programme du cours.
  private boolean quizAccess(User user, Map<String, String> vars) {
    long quizId = longVar(vars, "quizId");
    return quizId > 0 && membershipService.canAccessQuiz(user.getId(), quizId);
  }

  private boolean verifyUserId(User user, Map<String, String> vars) {
    long requestUserId  = longVar(vars, "userId");
    return requestUserId == user.getId();
  }

  // ── PREDICAT GENERIQUE : le cours fait partie du programme ────────────────────────
  // Verifie le lien structurel program_course (independant de l'utilisateur). Generique :
  // on passe le nom des variables de PATH ou se trouvent les ids.
  //
  // EXEMPLE dans buildRules() :
  //   rule("GET", "/programs/{programId}/courses/{courseId}",
  //       (user, vars, body) -> courseInProgram(vars, "courseId", "programId")),
  private boolean courseInProgram(Map<String, String> vars, String courseVar, String programVar) {
    long courseId = longVar(vars, courseVar);
    long programId = longVar(vars, programVar);
    return courseId > 0 && programId > 0
        && membershipService.isCourseInProgram(courseId, programId);
  }

  // ── PREDICAT GENERIQUE : le cours fait partie des cours de l'utilisateur ───────────
  // "Les cours d'un utilisateur" = inscription directe (Enrollment) de l'utilisateur
  // AUTHENTIFIE (identite issue du token, pas un id arbitraire de la requete). courseId
  // lu dans une variable de PATH.
  //
  // EXEMPLE dans buildRules() :
  //   rule("GET", "/users/{userId}/courses/{courseId}",
  //       (user, vars, body) -> userHasCourse(user, vars, "courseId")),
  private boolean userHasCourse(User user, Map<String, String> vars, String courseVar) {
    long courseId = longVar(vars, courseVar);
    return courseId > 0 && membershipService.isEnrolledInCourse(user.getId(), courseId);
  }

  // ── PREDICAT GENERIQUE : l'utilisateur est le createur du post ─────────────────────
  // Verifie que le post vise a bien ete cree par l'utilisateur AUTHENTIFIE (Post.user_id).
  // Sert aux actions reservees a l'auteur (editer / supprimer son propre post). postId lu
  // dans une variable de PATH.
  //
  // EXEMPLE dans buildRules() :
  //   rule("DELETE", "/forums/{forumId}/posts/{postId}",
  //       (user, vars, body) -> isPostAuthor(user, vars, "postId")),
  private boolean isPostAuthor(User user, Map<String, String> vars, String postVar) {
    long postId = longVar(vars, postVar);
    return postId > 0 && membershipService.isPostAuthor(user.getId(), postId);
  }

  // ── PREDICAT GENERIQUE : appartenance au forum (id de forum dans le PATH) ───────────
  // Le forum (canal 'Discussion' ou 'Thread') est-il accessible ? Regle : etre abonne a un
  // programme du cours du forum (canAccessForum). Variante « id dans le PATH » des regles
  // forum existantes (qui lisent forumId dans le BODY). Sert aux lectures ciblant un forum par
  // son id d'URL (sujets, reponses, messages).
  //
  // EXEMPLE dans buildRules() :
  //   rule("GET", "/forums/{forumId}/posts",
  //       (user, vars, body) -> canAccessForum(user, vars, "forumId")),
  private boolean canAccessForum(User user, Map<String, String> vars, String forumVar) {
    long forumId = longVar(vars, forumVar);
    return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
  }

  // ── PREDICAT GENERIQUE : le vote appartient a l'utilisateur ────────────────────────
  // Verifie que le vote vise appartient a l'utilisateur AUTHENTIFIE (Vote.user_id). Sert
  // aux actions reservees au votant (modifier / retirer son propre vote). voteId lu dans
  // une variable de PATH.
  //
  // EXEMPLE dans buildRules() :
  //   rule("DELETE", "/forums/posts/votes/{voteId}",
  //       (user, vars, body) -> isVoteOwner(user, vars, "voteId")),
  private boolean isVoteOwner(User user, Map<String, String> vars, String voteVar) {
    long voteId = longVar(vars, voteVar);
    return voteId > 0 && membershipService.isVoteOwner(user.getId(), voteId);
  }

  // ── PREDICAT GENERIQUE : "c'est l'user qui l'a cree" ──────────────────────────────
  // Verification de propriete generique, tous types de ressources confondus : l'utilisateur
  // AUTHENTIFIE est-il le createur de la ressource visee ? On passe le type (aiguille vers la
  // bonne table cote MembershipService, fail-closed) et le nom de la variable de PATH portant
  // l'id. Unifie les cas isPostAuthor / isVoteOwner sous un seul point d'appel.
  //
  // EXEMPLE dans buildRules() :
  //   rule("DELETE", "/forums/{forumId}/posts/{postId}",
  //       (user, vars, body) -> isCreator(user, vars, "post", "postId")),
  //   rule("DELETE", "/forums/posts/votes/{voteId}",
  //       (user, vars, body) -> isCreator(user, vars, "vote", "voteId")),
  private boolean isCreator(
      User user, Map<String, String> vars, String resourceType, String idVar) {
    long id = longVar(vars, idVar);
    return id > 0 && membershipService.isResourceOwner(user.getId(), resourceType, id);
  }

  // Lit une variable de path entiere (long) ; -1 si absente / non numerique.
  private static long longVar(Map<String, String> vars, String name) {
    try {
      return Long.parseLong(vars.get(name));
    } catch (NumberFormatException e) {
      return -1;
    }
  }

  // ── PREDICAT GENERIQUE : "c'est bien SON compte" ────────────────────────────────
  // S'assure que l'utilisateur authentifie (identite prouvee par le token, validee en
  // amont par le gateway + auth-service) est bien celui vise par la requete. Le JWT ne
  // porte que l'email ; on compare donc l'id du User charge par email a l'id de la requete.
  //
  // Deux variantes selon l'emplacement de l'id-utilisateur (cf. conventions du registre) :
  //   - id dans le PATH  (GET/PUT/PATCH/DELETE /users/{userId}) -> isSelfFromPath
  //   - id dans le BODY  (POST portant un userId dans le DTO)   -> isSelfFromBody
  //
  // Reutilise longVar / longField (qui renvoient -1 si l'id est absent / non numerique
  // -> refus propre, jamais d'egalite accidentelle).
  //
  // EXEMPLES d'utilisation dans buildRules() (a decommenter + adapter) :
  //   // id dans le PATH
  //   rule("PATCH", "/users/{userId}", (user, vars, body) -> isSelfFromPath(user, vars, "userId")),
  //   // id dans le BODY
  //   rule("POST", "/quelque/route", (user, vars, body) -> isSelfFromBody(user, body, "userId")),
  private static boolean isSelfFromPath(User user, Map<String, String> vars, String varName) {
    return longVar(vars, varName) == user.getId();
  }

  private static boolean isSelfFromBody(User user, JsonNode body, String field) {
    return longField(body, field) == user.getId();
  }

  private static boolean hasRole(User user, String roleName) {
    Set<String> roles = user.getRoles().stream().map(Role::getName).collect(Collectors.toSet());
    return roles.contains(roleName);
  }

  // ── PREDICAT GENERIQUE : role SUR UN COURS (ex. "prof du cours") ───────────────────
  // Verifie que l'utilisateur AUTHENTIFIE possede le role nomme sur le cours vise : role
  // scope-programme (User_Program_Role) ET cours rattache a ce programme (program_course).
  // Avec roleName = RoleNames.TEACHER -> "est-ce le prof du cours ?". courseId lu dans une
  // variable de PATH.
  //
  // EXEMPLE dans buildRules() :
  //   rule("PUT", "/courses/{courseId}",
  //       (user, vars, body) -> hasRoleInCourse(user, vars, RoleNames.TEACHER, "courseId")),
  private boolean hasRoleInCourse(
      User user, Map<String, String> vars, String roleName, String courseVar) {
    long courseId = longVar(vars, courseVar);
    return courseId > 0 && membershipService.hasRoleInCourse(user.getId(), courseId, roleName);
  }
}
