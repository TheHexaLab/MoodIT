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

  private List<Rule> buildRules() {
    return List.of(
        // ── FIN (appartenance), id dans le BODY ──────────────────────────────────
        // Ecrire un post : il faut voir le forum. forumId dans PostCreateInForumDTO.
        new Rule(
            "POST",
            "/api/forums/posts",
            (user, vars, body) -> {
              long forumId = longField(body, "forumId");
              return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
            }),

        // Voter sur un post : meme contrainte (le forum du post). forumId dans VoteCreateInPostDTO.
        new Rule(
            "POST",
            "/api/forums/posts/votes",
            (user, vars, body) -> {
              long forumId = longField(body, "forumId");
              return forumId > 0 && membershipService.canAccessForum(user.getId(), forumId);
            }),

        // ── GROSSIER (role), aucun id de ressource ───────────────────────────────
        // Creer un cours dans des programmes : reserve aux Administrateurs.
        new Rule(
            "POST", "/api/programs/courses", (user, vars, body) -> hasRole(user, "Administrateur")),

        // ── QUIZ ─────────────────────────────────────────────────────────────────
        // Editer / supprimer un quiz : reserve aux Administrateurs. Regle grossiere ;
        // TODO affiner en role enseignant scope-programme (User_Program_Role) une fois
        // la resolution quiz -> programme disponible.
        new Rule(
            "PUT", "/api/quizzes/{quizId}", (user, vars, body) -> hasRole(user, "Administrateur")),
        new Rule(
            "DELETE", "/api/quizzes/{quizId}", (user, vars, body) -> hasRole(user, "Administrateur")),

        // Lire un quiz / soumettre / consulter ses tentatives (quizId dans le PATH) :
        // etre abonne a un programme du cours du quiz.
        new Rule("GET", "/api/quizzes/{quizId}", (user, vars, body) -> quizAccess(user, vars)),
        new Rule(
            "POST",
            "/api/quizzes/{quizId}/submissions",
            (user, vars, body) -> quizAccess(user, vars)),
        new Rule(
            "GET", "/api/quizzes/{quizId}/attempts", (user, vars, body) -> quizAccess(user, vars)),
        new Rule(
            "GET",
            "/api/quizzes/{quizId}/attempts/{attemptId}",
            (user, vars, body) -> quizAccess(user, vars))

        // ── TODO : a completer (ids dans le PATH pour edit/delete) ───────────────
        //  editPost   PATCH  /api/forums/{forumId}/posts/{postId}  -> canAccessForum(vars.forumId)
        //  deletePost DELETE /api/forums/{forumId}/posts/{postId}  -> canAccessForum(vars.forumId) OU role
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

  // Lit une variable de path entiere (long) ; -1 si absente / non numerique.
  private static long longVar(Map<String, String> vars, String name) {
    try {
      return Long.parseLong(vars.get(name));
    } catch (NumberFormatException e) {
      return -1;
    }
  }

  private static boolean hasRole(User user, String roleName) {
    Set<String> roles = user.getRoles().stream().map(Role::getName).collect(Collectors.toSet());
    return roles.contains(roleName);
  }
}
