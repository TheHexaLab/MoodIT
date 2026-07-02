// Point de decision pour les requetes REST (consulte par le gateway, JwtAuthFilter).
//
// Moteur de regles : une regle = (methode, motif de route avec {variables}, predicat).
// La 1re regle qui matche tranche. Aucune regle ne matche => acces autorise
// (default-allow) : on ne restreint QUE les routes explicitement listees ; l'identite
// est deja garantie par le gateway (JWT) + l'auth-service.
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
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.UserRepository;
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

  public PermissionService(
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

  private record Rule(String method, String pattern, AccessCheck check) {}

  // Prefixe commun a TOUTES les routes REST. Cote core, il est ajoute automatiquement aux
  // controleurs (WebConfig.configurePathMatch -> addPathPrefix("/api", ...)), donc le path
  // reel qui arrive ici commence toujours par "/api". On l'ajoute une seule fois via la
  // fabrique rule(...) pour ne pas avoir a le repeter (ni risquer de l'oublier) dans chaque
  // regle : on ecrit "/forums/posts", pas "/api/forums/posts".
  private static final String API_PREFIX = "/api";

  // Fabrique une regle avec le prefixe /api applique au motif. TOUJOURS passer par ici
  // plutot que `new Rule(...)` directement, pour garder les motifs sans "/api".
  private static Rule rule(String method, String path, AccessCheck check) {
    return new Rule(method, API_PREFIX + path, check);
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
  //         - ROLE (grossier)    : hasRole(user, "Administrateur").
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
        // ── FIN (appartenance), id dans le BODY ──────────────────────────────────
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

        // ── GROSSIER (role), aucun id de ressource ───────────────────────────────
        // Creer un cours dans des programmes : reserve aux Administrateurs.
        rule("POST", "/programs/courses", (user, vars, body) -> hasRole(user, "Administrateur")),

        // ── QUIZ ─────────────────────────────────────────────────────────────────
        // Editer / supprimer un quiz : reserve aux Administrateurs. Regle grossiere ;
        // TODO affiner en role enseignant scope-programme (User_Program_Role) une fois
        // la resolution quiz -> programme disponible.
        rule("PUT", "/quizzes/{quizId}", (user, vars, body) -> hasRole(user, "Administrateur")),
        rule("DELETE", "/quizzes/{quizId}", (user, vars, body) -> hasRole(user, "Administrateur")),

        // Lire un quiz / soumettre / consulter ses tentatives (quizId dans le PATH) :
        // etre abonne a un programme du cours du quiz.
        rule("GET", "/quizzes/{quizId}", (user, vars, body) -> quizAccess(user, vars)),
        rule("POST", "/quizzes/{quizId}/submissions", (user, vars, body) -> quizAccess(user, vars)),
        rule("GET", "/quizzes/{quizId}/attempts", (user, vars, body) -> quizAccess(user, vars)),
        rule(
            "GET",
            "/quizzes/{quizId}/attempts/{attemptId}",
            (user, vars, body) -> quizAccess(user, vars))

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
        //      (user, vars, body) -> hasRole(user, "Administrateur")),
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

  public boolean isAllowed(String email, String path, String method, String body) {
    if (email == null || email.isBlank() || path == null || method == null) {
      return false;
    }

    // 1) Chercher une regle applicable AVANT toute requete BD / tout parsing.
    for (Rule rule : rules) {
      if (method.equalsIgnoreCase(rule.method()) && matcher.match(rule.pattern(), path)) {
        // 2) Une regle s'applique : on charge le user et on parse le body seulement maintenant.
        User user = userRepository.findByEmail(email).orElse(null);
        if (user == null) {
          return false; // identite inconnue : fail-closed.
        }
        Map<String, String> vars = matcher.extractUriTemplateVariables(rule.pattern(), path);
        JsonNode bodyJson = parseBody(body);
        try {
          return rule.check().allow(user, vars, bodyJson);
        } catch (Exception e) {
          return false; // donnee de path/body invalide : refus.
        }
      }
    }

    // 3) Aucune regle ne restreint cette route : approbation directe, ZERO requete BD.
    return true;
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

  // Acces a un quiz (quizId dans les variables de path) : abonne a un programme du cours.
  private boolean quizAccess(User user, Map<String, String> vars) {
    long quizId = longVar(vars, "quizId");
    return quizId > 0 && membershipService.canAccessQuiz(user.getId(), quizId);
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

  // ── PREDICAT GENERIQUE : role SCOPE A UN PROGRAMME ────────────────────────────────
  // Verifie que l'utilisateur AUTHENTIFIE possede le role nomme DANS le programme vise
  // (table User_Program_Role) — ex. "enseignant du programme {programId}". A distinguer
  // de hasRole, qui verifie un role GLOBAL (user_role). programId lu dans une variable
  // de PATH.
  //
  // EXEMPLE dans buildRules() :
  //   rule("POST", "/programs/{programId}/courses",
  //       (user, vars, body) -> hasRoleInProgram(user, vars, "Enseignant", "programId")),
  private boolean hasRoleInProgram(
      User user, Map<String, String> vars, String roleName, String programVar) {
    long programId = longVar(vars, programVar);
    return programId > 0 && membershipService.hasRoleInProgram(user.getId(), programId, roleName);
  }
}
