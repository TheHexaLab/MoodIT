// Point de decision pour les requetes REST (consulte par le gateway, JwtAuthFilter).
//
// Moteur de regles : une regle = (methode, motif de route avec {variables}, predicat).
// La 1re regle qui matche tranche. Aucune regle ne matche => acces autorise
// (default-allow) : on ne restreint QUE les routes explicitement listees ; l'identite
// est deja garantie par le gateway (JWT) + l'auth-service.
//
// Granularite : grossiere (role) ET fine d'appartenance (via MembershipService), car la
// logique d'appartenance vit deja ici (objectif : un maximum de logique centralisee).
//
// REGISTRE A COMPLETER une par une, au fur et a mesure que les contrôleurs REST du core
// figent leurs chemins (source des actions : frontend/src/pages/Dashboard/dashboardApi.ts).

package com.moodit.permission_service.service;

import com.moodit.permission_service.model.Role;
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.UserRepository;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.AntPathMatcher;

@Service
public class PermissionService {

  private final UserRepository userRepository;
  private final MembershipService membershipService;
  private final AntPathMatcher matcher = new AntPathMatcher();
  private final List<Rule> rules;

  public PermissionService(UserRepository userRepository, MembershipService membershipService) {
    this.userRepository = userRepository;
    this.membershipService = membershipService;
    this.rules = buildRules();
  }

  // Une regle : si (methode + motif) matche, `allow` tranche a partir du user et des
  // variables de chemin extraites (ex: {forumId}).
  private record Rule(String method, String pattern, BiPredicate<User, Map<String, String>> allow) {}

  private List<Rule> buildRules() {
    return List.of(
        // ── Exemple FIN (appartenance) ───────────────────────────────────────────
        // Ecrire un post dans un forum/channel : il faut voir le forum (abonne au
        // programme du cours OU inscrit au cours).
        new Rule(
            "POST",
            "/api/forums/{forumId}/posts",
            (user, vars) ->
                membershipService.canAccessForum(user.getId(), Long.parseLong(vars.get("forumId")))),

        // ── Exemple GROSSIER (role) ──────────────────────────────────────────────
        // Gerer les roles d'un programme : reserve aux Administrateurs.
        new Rule(
            "POST", "/api/programs/{programId}/roles", (user, vars) -> hasRole(user, "Administrateur"))

        // ── TODO : a brancher une par une depuis dashboardApi.ts ────────────────────
        //  sendMessage   POST   /api/channels/{channelId}/messages  -> canAccessForum (channel == Forum)
        //  votePost      POST   /api/posts/{postId}/votes           -> canAccessForum du post
        //  createCourse  POST   /api/courses                        -> Enseignant / Administrateur
        //  changeRole    POST   /api/programs/{programId}/roles     -> Administrateur (deja ci-dessus)
        //  editPost      PATCH  /api/posts/{postId}                 -> auteur du post OU role eleve
        //  deletePost    DELETE /api/posts/{postId}                 -> auteur du post OU role eleve
        );
  }

  @Transactional(readOnly = true)
  public boolean isAllowed(String email, String path, String method) {
    if (email == null || email.isBlank() || path == null || method == null) {
      return false;
    }
    User user = userRepository.findByEmail(email).orElse(null);
    if (user == null) {
      return false; // identite inconnue : fail-closed.
    }

    for (Rule rule : rules) {
      if (method.equalsIgnoreCase(rule.method()) && matcher.match(rule.pattern(), path)) {
        Map<String, String> vars = matcher.extractUriTemplateVariables(rule.pattern(), path);
        try {
          return rule.allow().test(user, vars);
        } catch (Exception e) {
          return false; // variable de chemin invalide (ex: id non numerique) : refus.
        }
      }
    }
    return true; // aucune regle ne restreint cette route.
  }

  private static boolean hasRole(User user, String roleName) {
    Set<String> roles = user.getRoles().stream().map(Role::getName).collect(Collectors.toSet());
    return roles.contains(roleName);
  }
}
