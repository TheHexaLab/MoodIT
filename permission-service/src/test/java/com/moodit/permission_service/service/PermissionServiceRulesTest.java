package com.moodit.permission_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.permission_service.model.ForumAccess;
import com.moodit.permission_service.model.Role;
import com.moodit.permission_service.model.RoleNames;
import com.moodit.permission_service.model.User;
import com.moodit.permission_service.repository.UserRepository;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import tools.jackson.databind.ObjectMapper;

/**
 * Complément de {@link PermissionServiceTest} (#90) : chaque règle du registre jusque-là jamais
 * exercée, testée pour chaque profil — Gardien, Administrateur global, Administrateur DE
 * programme, Enseignant, étudiant (aucun rôle), identité inconnue — plus les chemins du moteur
 * (exception de prédicat, parsing query/body, casse des verbes).
 *
 * <p>Conventions identiques à PermissionServiceTest : MembershipService et UserRepository mockés
 * (stubs stricts : un stub inutile fait échouer le test, ce qui verrouille aussi le court-circuit
 * des prédicats), ObjectMapper réel. Usager connecté = id 5 ; « autrui » = id 9.
 */
@ExtendWith(MockitoExtension.class)
class PermissionServiceRulesTest {

  @Mock private UserRepository userRepository;
  @Mock private MembershipService membershipService;

  private static final String EMAIL = "u@test";

  private PermissionService service() {
    return new PermissionService(userRepository, membershipService, new ObjectMapper());
  }

  private User user(int id, String... roleNames) {
    User u = new User();
    u.setId(id);
    u.setEmail(EMAIL);
    Set<Role> roles = new HashSet<>();
    for (String n : roleNames) {
      Role r = new Role();
      r.setName(n);
      roles.add(r);
    }
    u.setRoles(roles);
    return u;
  }

  private void loggedIn(User u) {
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(u));
  }

  private void unknownUser() {
    when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.empty());
  }

  private boolean allowed(String path, String method, String body) {
    return service().isAllowed(EMAIL, path, method, body);
  }

  private boolean allowed(String path, String method, String body, String query) {
    return service().isAllowed(EMAIL, path, method, body, query);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Routes « soi-même » (userId dans le PATH)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class RoutesSoiMeme {

    @Test
    void coursDUnProgramme_soiMeme_autorise() {
      loggedIn(user(5));
      assertThat(allowed("/api/users/5/programs/3/enrollments", "GET", null)).isTrue();
    }

    @Test
    void coursDUnProgramme_autrui_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/users/9/programs/3/enrollments", "GET", null)).isFalse();
    }

    @Test
    void coursDUnProgramme_autruiMemePourGardien_refuse() {
      // Règle « soi uniquement » : aucun rôle global ne l'ouvre.
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/users/9/programs/3/enrollments", "GET", null)).isFalse();
    }

    @Test
    void programmesDeLUsager_soiMeme_autorise() {
      loggedIn(user(5));
      assertThat(allowed("/api/users/5/programs", "GET", null)).isTrue();
    }

    @Test
    void programmesDeLUsager_autruiParAdmin_refuse() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/users/9/programs", "GET", null)).isFalse();
    }

    @Test
    void programmesDeLUsager_idNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/users/abc/programs", "GET", null)).isFalse();
    }

    @Test
    void quitterUnCours_soiMeme_autorise() {
      loggedIn(user(5));
      assertThat(allowed("/api/courses/1/users/5", "DELETE", null)).isTrue();
    }

    @Test
    void quitterUnCours_retirerAutrui_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/courses/1/users/9", "DELETE", null)).isFalse();
    }

    @Test
    void quitterUnCours_retirerAutruiParGardien_refuse() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/courses/1/users/9", "DELETE", null)).isFalse();
    }

    @Test
    void quitterUnCours_identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/api/courses/1/users/5", "DELETE", null)).isFalse();
    }

    @Test
    void modifierProfilParId_autruiParAdmin_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/users/9", "PATCH", "{}")).isTrue();
    }

    @Test
    void lireUsager_autruiParGardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/users/9", "GET", null)).isTrue();
    }

    @Test
    void rechercheParUsername_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/users/username/rosie", "GET", null)).isTrue();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Établissements et programmes (rôles globaux)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class EtablissementsEtProgrammes {

    @Test
    void creerEtablissement_etudiant_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/establishments", "POST", "{}")).isFalse();
    }

    @Test
    void modifierEtablissement_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/establishments/3", "PATCH", "{}")).isTrue();
    }

    @Test
    void supprimerEtablissement_adminGlobal_refuse() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/establishments/3", "DELETE", null)).isFalse();
    }

    @Test
    void creerProgramme_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/establishments/programs", "POST", "{\"establishmentId\":1}"))
          .isTrue();
    }

    @Test
    void creerProgramme_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/establishments/programs", "POST", "{\"establishmentId\":1}"))
          .isTrue();
    }

    @Test
    void creerProgramme_enseignantOuEtudiant_refuse() {
      // Aucun rôle global : refus sans consulter les rôles de programme.
      loggedIn(user(5, RoleNames.TEACHER));
      assertThat(allowed("/api/establishments/programs", "POST", "{\"establishmentId\":1}"))
          .isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void modifierProgramme_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/programs/7", "PATCH", "{}")).isTrue();
    }

    @Test
    void modifierProgramme_idNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/programs/abc", "PATCH", "{}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void supprimerProgramme_enseignant_refuse() {
      loggedIn(user(5, RoleNames.TEACHER));
      assertThat(allowed("/api/programs/7", "DELETE", null)).isFalse();
    }

    @Test
    void membresDuProgramme_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/programs/3/users", "GET", null)).isTrue();
    }

    @Test
    void membresDuProgramme_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/programs/3/users", "GET", null)).isTrue();
    }

    @Test
    void membresDuProgramme_enseignantDuProgramme_refuse() {
      // Seul l'Administrateur DU programme voit les membres, pas l'Enseignant.
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(false);
      assertThat(allowed("/api/programs/3/users", "GET", null)).isFalse();
    }

    @Test
    void membresDuProgramme_idNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/programs/abc/users", "GET", null)).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void usagersParRoleDansProgramme_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/users/role/1/programs/7", "GET", null)).isTrue();
    }

    @Test
    void candidatsRoleProgramme_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/programs/7/role-candidates", "GET", null)).isTrue();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Créer un cours dans des programmes (POST /programs/courses, programIds dans le BODY)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class CreerUnCours {

    private static final String PATH = "/api/programs/courses";

    @Test
    void adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed(PATH, "POST", "{\"programIds\":[3]}")).isTrue();
      verifyNoInteractions(membershipService);
    }

    @Test
    void gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed(PATH, "POST", "{\"programIds\":[3]}")).isTrue();
    }

    @Test
    void gereChacunDesProgrammes_autorise() {
      // Enseignant du programme 3, Administrateur du programme 4 : gère les DEUX → autorisé.
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.TEACHER)).thenReturn(true);
      when(membershipService.hasRoleInProgram(5, 4, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed(PATH, "POST", "{\"programIds\":[3,4]}")).isTrue();
    }

    @Test
    void idsEnChaines_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed(PATH, "POST", "{\"programIds\":[\"3\"]}")).isTrue();
    }

    @Test
    void unProgrammeNonGere_refuse() {
      // Gère le 3 mais pas le 8 : il faut gérer TOUS les programmes demandés.
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(true);
      when(membershipService.hasRoleInProgram(5, 8, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInProgram(5, 8, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed(PATH, "POST", "{\"programIds\":[3,8]}")).isFalse();
    }

    @Test
    void etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed(PATH, "POST", "{\"programIds\":[3]}")).isFalse();
    }

    @Test
    void listeVide_refuse() {
      // Liste vide : pas d'allMatch vacuement vrai, refus explicite.
      loggedIn(user(5));
      assertThat(allowed(PATH, "POST", "{\"programIds\":[]}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void champAbsent_refuse() {
      loggedIn(user(5));
      assertThat(allowed(PATH, "POST", "{}")).isFalse();
    }

    @Test
    void champNonTableau_refuse() {
      // "programIds":"3" (scalaire) → liste vide → refus.
      loggedIn(user(5));
      assertThat(allowed(PATH, "POST", "{\"programIds\":\"3\"}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void idNulDansLaListe_refuse() {
      loggedIn(user(5));
      assertThat(allowed(PATH, "POST", "{\"programIds\":[0]}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void bodyIllisible_refuse() {
      // JSON invalide → nœud vide → programIds absent → refus (pas d'exception).
      loggedIn(user(5));
      assertThat(allowed(PATH, "POST", "{pas du json")).isFalse();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Modifier un cours (PATCH /courses/{courseId}) + créer un quiz (gestion de contenu)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class GestionDeContenuDeCours {

    @Test
    void modifierCours_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/courses/1", "PATCH", "{\"title\":\"x\"}")).isTrue();
    }

    @Test
    void modifierCours_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/courses/1", "PATCH", "{\"title\":\"x\"}")).isTrue();
    }

    @Test
    void modifierCours_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/courses/1", "PATCH", "{\"title\":\"x\"}")).isTrue();
    }

    @Test
    void modifierCours_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/courses/1", "PATCH", "{\"title\":\"x\"}")).isTrue();
    }

    @Test
    void modifierCours_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/courses/1", "PATCH", "{\"title\":\"x\"}")).isFalse();
    }

    @Test
    void modifierCours_idNonNumerique_refuse() {
      loggedIn(user(5, RoleNames.ADMIN)); // même un admin : id invalide → refus avant les rôles
      assertThat(allowed("/api/courses/abc", "PATCH", "{}")).isFalse();
    }

    /**
     * FAILLE : la règle PATCH /courses/{courseId} ne regarde que le courseId du PATH, alors que
     * le core (CourseService.updateCourse) applique aussi {@code programIds} du BODY et remplace
     * les programmes du cours SANS autre contrôle. Un Enseignant du cours (programme 3) peut donc
     * rattacher son cours à un programme 99 où il n'a aucun rôle (le publier dans le catalogue
     * d'autrui) ou le retirer des programmes qu'il ne gère pas. POST /programs/courses exige, lui,
     * de gérer CHACUN des programmes visés (canCreateCourse). Comportement attendu : sans rôle
     * global, chaque programId du body doit être géré (Admin/Enseignant DU programme).
     */
    @Test
    void modifierCours_enseignantRattacheAUnProgrammeNonGere_refuse() {
      loggedIn(user(5));
      lenient().when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      lenient().when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      lenient().when(membershipService.hasRoleInProgram(5, 99, RoleNames.ADMIN)).thenReturn(false);
      lenient()
          .when(membershipService.hasRoleInProgram(5, 99, RoleNames.TEACHER))
          .thenReturn(false);
      assertThat(allowed("/api/courses/1", "PATCH", "{\"programIds\":[99]}")).isFalse();
    }

    @Test
    void creerQuiz_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/courses/1/quizzes", "POST", "{}")).isTrue();
    }

    @Test
    void creerQuiz_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/courses/1/quizzes", "POST", "{}")).isTrue();
    }

    @Test
    void creerQuiz_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/courses/1/quizzes", "POST", "{}")).isFalse();
    }

    @Test
    void supprimerCours_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/courses/1", "DELETE", null)).isTrue();
    }

    @Test
    void creerForum_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/courses/forums", "POST", "{\"courseId\":1}")).isTrue();
    }

    @Test
    void creerForum_courseIdEnChaine_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/courses/forums", "POST", "{\"courseId\":\"1\"}")).isTrue();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Forums : écriture (forumId dans le BODY) et gestion
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class Forums {

    @Test
    void publierPost_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.READ);
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":9}")).isTrue();
    }

    @Test
    void publierPost_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.NONE);
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":9}")).isFalse();
    }

    @Test
    void publierPost_nonAbonneMemeGardien_refuse() {
      // L'écriture dans un forum suit l'APPARTENANCE, pas le rôle global.
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.NONE);
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":9}")).isFalse();
    }

    @Test
    void publierPost_forumIdEnChaine_autorise() {
      loggedIn(user(5));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.READ);
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":\" 9 \"}")).isTrue();
    }

    @Test
    void publierPost_forumIdChaineNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":\"abc\"}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void publierPost_forumIdNegatif_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":-3}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void publierPost_sansBody_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/forums/posts", "POST", null)).isFalse();
    }

    @Test
    void publierPost_bodyIllisible_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/forums/posts", "POST", "{\"forumId\":")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void voter_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.READ);
      assertThat(allowed("/api/forums/posts/votes", "POST", "{\"forumId\":9,\"postId\":40}"))
          .isTrue();
    }

    @Test
    void voter_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.forumAccess(5, 9)).thenReturn(ForumAccess.NONE);
      assertThat(allowed("/api/forums/posts/votes", "POST", "{\"forumId\":9,\"postId\":40}"))
          .isFalse();
    }

    @Test
    void voter_sansForumId_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/forums/posts/votes", "POST", "{\"postId\":40}")).isFalse();
    }

    @Test
    void typeDuForum_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessForum(5, 9)).thenReturn(true);
      assertThat(allowed("/api/forums/9/f_type", "GET", null)).isTrue();
    }

    @Test
    void typeDuForum_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessForum(5, 9)).thenReturn(false);
      assertThat(allowed("/api/forums/9/f_type", "GET", null)).isFalse();
    }

    @Test
    void lirePostPrecis_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessForum(5, 9)).thenReturn(true);
      assertThat(allowed("/api/forums/9/posts/40", "GET", null)).isTrue();
    }

    @Test
    void forumDUnCours_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessForum(5, 9)).thenReturn(false);
      assertThat(allowed("/api/courses/1/forums/9", "GET", null)).isFalse();
    }

    @Test
    void renommerForum_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/forums/9", "PATCH", "{}")).isTrue();
    }

    @Test
    void renommerForum_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/forums/9", "PATCH", "{}")).isTrue();
    }

    @Test
    void renommerForum_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/forums/9", "PATCH", "{}")).isFalse();
    }

    @Test
    void renommerForum_idNonNumerique_refuse() {
      loggedIn(user(5, RoleNames.ADMIN)); // id invalide : refus AVANT le rôle global
      assertThat(allowed("/api/forums/abc", "PATCH", "{}")).isFalse();
    }

    @Test
    void supprimerForum_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/forums/9", "DELETE", null)).isTrue();
    }

    // ── Épingler un post (PATCH avec isPinned) : action de modération (#29) ──
    private static final String POST_PATH = "/api/forums/9/posts/40";

    @Test
    void editerPost_auteurSansEpinglage_autorise() {
      loggedIn(user(5));
      when(membershipService.isPostAuthor(5, 40)).thenReturn(true);
      assertThat(allowed(POST_PATH, "PATCH", "{\"content\":\"x\",\"isPinned\":null}")).isTrue();
    }

    @Test
    void epinglerPost_auteurEtudiant_refuse() {
      loggedIn(user(5));
      lenient().when(membershipService.isPostAuthor(5, 40)).thenReturn(true);
      assertThat(allowed(POST_PATH, "PATCH", "{\"isPinned\":true}")).isFalse();
      assertThat(allowed(POST_PATH, "PATCH", "{\"content\":\"x\",\"isPinned\":false}")).isFalse();
      // Valeur coercible par core (chaîne) : traitée comme une demande d'épinglage.
      assertThat(allowed(POST_PATH, "PATCH", "{\"isPinned\":\"true\"}")).isFalse();
    }

    @Test
    void epinglerPost_enseignantDuCours_nonAuteur_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInForumCourse(5, 9, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed(POST_PATH, "PATCH", "{\"isPinned\":true,\"title\":null}")).isTrue();
      verify(membershipService, never()).isPostAuthor(anyLong(), anyLong());
    }

    @Test
    void epinglerEtModifierPost_personnelNonAuteur_refuse() {
      // Le personnel épingle, mais ne réécrit pas le post d'autrui.
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.isPostAuthor(5, 40)).thenReturn(false);
      assertThat(allowed(POST_PATH, "PATCH", "{\"isPinned\":true,\"content\":\"x\"}")).isFalse();
    }

    @Test
    void epinglerEtModifierPost_personnelAuteur_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      when(membershipService.isPostAuthor(5, 40)).thenReturn(true);
      assertThat(allowed(POST_PATH, "PATCH", "{\"isPinned\":true,\"content\":\"x\"}")).isTrue();
    }

    @Test
    void supprimerPost_forumIdNonNumerique_nonAuteur_refuse() {
      // Pas l'auteur, pas de rôle global, forumId invalide → pas de modération possible.
      loggedIn(user(5));
      when(membershipService.isPostAuthor(5, 40)).thenReturn(false);
      assertThat(allowed("/api/forums/abc/posts/40", "DELETE", null)).isFalse();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Quiz : gestion (par quizId) et accès étudiant (appartenance)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class Quiz {

    @Test
    void detailEditeur_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isTrue();
      verifyNoInteractions(membershipService);
    }

    @Test
    void detailEditeur_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isTrue();
    }

    @Test
    void detailEditeur_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isTrue();
    }

    @Test
    void detailEditeur_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isTrue();
    }

    @Test
    void detailEditeur_etudiantAbonne_refuse() {
      // L'étudiant voit le quiz, mais JAMAIS la vue éditeur (avec la correction).
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isFalse();
    }

    @Test
    void detailEditeur_idNonNumerique_refuse() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/quizzes/abc/edit", "GET", null)).isFalse();
    }

    @Test
    void detailEditeur_identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/api/quizzes/12/edit", "GET", null)).isFalse();
    }

    @Test
    void modifierQuiz_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12", "PUT", "{}")).isTrue();
    }

    @Test
    void modifierQuiz_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "PUT", "{}")).isFalse();
    }

    @Test
    void supprimerQuiz_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12", "DELETE", null)).isTrue();
    }

    @Test
    void supprimerQuiz_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "DELETE", null)).isFalse();
    }

    @Test
    void lireQuiz_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isTrue();
    }

    @Test
    void lireQuiz_brouillon_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isFalse();
    }

    @Test
    void lireQuiz_brouillon_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isTrue();
    }

    @Test
    void lireQuiz_brouillon_gardienAbonne_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isTrue();
    }

    @Test
    void lireQuiz_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isFalse();
    }

    @Test
    void lireQuiz_adminGlobalNonAbonne_refuse() {
      // Décision ACTUELLE : la lecture étudiant d'un quiz suit l'appartenance seule (le rôle
      // global ne l'ouvre pas ; l'admin passe par /edit). Ce test casse si la règle change.
      loggedIn(user(5, RoleNames.ADMIN));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12", "GET", null)).isFalse();
    }

    @Test
    void lireQuiz_idNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/quizzes/abc", "GET", null)).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void soumettre_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12/submissions", "POST", "{}")).isTrue();
    }

    @Test
    void soumettre_brouillon_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      when(membershipService.isQuizPublished(12)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/submissions", "POST", "{}")).isFalse();
    }

    @Test
    void soumettre_brouillon_nonAbonne_refuseSansLireLaPublication() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/submissions", "POST", "{}")).isFalse();
      verify(membershipService, never()).isQuizPublished(12);
    }

    @Test
    void soumettre_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/submissions", "POST", "{}")).isFalse();
    }

    @Test
    void tentatives_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12/attempts", "GET", null)).isTrue();
    }

    @Test
    void tentatives_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/attempts", "GET", null)).isFalse();
    }

    @Test
    void tentativePrecise_abonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(true);
      assertThat(allowed("/api/quizzes/12/attempts/3", "GET", null)).isTrue();
    }

    @Test
    void tentativePrecise_nonAbonne_refuse() {
      loggedIn(user(5));
      when(membershipService.canAccessQuiz(5, 12)).thenReturn(false);
      assertThat(allowed("/api/quizzes/12/attempts/3", "GET", null)).isFalse();
    }

    @Test
    void listePubliee_enseignantNonAbonne_autorise() {
      loggedIn(user(5));
      when(membershipService.canAccessCourse(5, 1)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/api/courses/1/quizzes", "GET", null)).isTrue();
    }

    @Test
    void listePubliee_idNonNumerique_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/courses/abc/quizzes", "GET", null)).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void gestionQuiz_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/courses/1/quizzes/manage", "GET", null)).isTrue();
    }

    @Test
    void gestionQuiz_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/courses/1/quizzes/manage", "GET", null)).isTrue();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  MCP (préfixe /mcp, sans /api) : gestion de contenu du cours
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class Mcp {

    @Test
    void listerAnalyses_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/mcp/courses/1/analyses", "GET", null)).isTrue();
    }

    @Test
    void listerAnalyses_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/mcp/courses/1/analyses", "GET", null)).isTrue();
    }

    @Test
    void listerAnalyses_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/mcp/courses/1/analyses", "GET", null)).isFalse();
    }

    @Test
    void lancerAnalyse_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/mcp/courses/1/analyses", "POST", "{}")).isTrue();
    }

    @Test
    void lancerAnalyse_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/mcp/courses/1/analyses", "POST", "{}")).isTrue();
    }

    @Test
    void lancerAnalyse_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/mcp/courses/1/analyses", "POST", "{}")).isFalse();
    }

    @Test
    void lancerAnalyse_identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/mcp/courses/1/analyses", "POST", "{}")).isFalse();
    }

    @Test
    void analyseEnCours_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/mcp/courses/1/pending", "GET", null)).isTrue();
    }

    @Test
    void analyseEnCours_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/mcp/courses/1/pending", "GET", null)).isFalse();
    }

    @Test
    void analysePrecise_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/mcp/analyses/4", "GET", null)).isTrue();
      verifyNoInteractions(membershipService);
    }

    @Test
    void analysePrecise_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/mcp/analyses/4", "GET", null)).isTrue();
    }

    @Test
    void analysePrecise_adminDuProgramme_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInAnalysisCourse(5, 4, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/mcp/analyses/4", "GET", null)).isTrue();
    }

    @Test
    void analysePrecise_enseignantDuCours_autorise() {
      loggedIn(user(5));
      when(membershipService.hasRoleInAnalysisCourse(5, 4, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInAnalysisCourse(5, 4, RoleNames.TEACHER)).thenReturn(true);
      assertThat(allowed("/mcp/analyses/4", "GET", null)).isTrue();
    }

    @Test
    void analysePrecise_etudiant_refuse() {
      loggedIn(user(5));
      when(membershipService.hasRoleInAnalysisCourse(5, 4, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInAnalysisCourse(5, 4, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed("/mcp/analyses/4", "GET", null)).isFalse();
    }

    @Test
    void analysePrecise_idNonNumerique_refuse() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/mcp/analyses/abc", "GET", null)).isFalse();
    }

    @Test
    void verbeNonDeclare_defaultDeny() {
      // DELETE /mcp/courses/{id}/analyses n'a pas de règle : écriture → refus sans charger le user.
      assertThat(allowed("/mcp/courses/1/analyses", "DELETE", null)).isFalse();
      verifyNoInteractions(userRepository);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Rôles : changement programme / global, listes réservées
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class Roles {

    @Test
    void changerRoleProgramme_adminGlobal_autorise() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/roles/change", "POST", "{\"programId\":7}")).isTrue();
      verifyNoInteractions(membershipService);
    }

    @Test
    void changerRoleProgramme_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/roles/change", "POST", "{\"programId\":7}")).isTrue();
    }

    @Test
    void changerRoleProgramme_sansProgramId_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/roles/change", "POST", "{\"roleId\":2}")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void changerRoleProgramme_enseignantDuProgramme_refuse() {
      // Seul l'Administrateur DU programme gère les rôles, pas l'Enseignant.
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(false);
      assertThat(allowed("/api/roles/change", "POST", "{\"programId\":7}")).isFalse();
    }

    @Test
    void changerRoleProgramme_identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/api/roles/change", "POST", "{\"programId\":7}")).isFalse();
    }

    /**
     * FAILLE (intégrité, gravité moindre) : un Administrateur DE programme peut attribuer
     * n'importe quel roleId dans son programme, y compris le Gardien (Role.program_assignable =
     * FALSE dans init.sql). La règle ne résout jamais le rôle ciblé, et le core
     * (RoleService.changeRole) insère la ligne User_Program_Role sans vérifier program_assignable.
     * Aujourd'hui ce « Gardien de programme » n'ouvre aucune règle (le Gardien est testé sur
     * User_Role), mais toute future règle lisant les rôles de programme hériterait du trou.
     * Comportement attendu : refuser l'attribution d'un rôle non attribuable en programme.
     */
    @Test
    void changerRoleProgramme_adminDuProgrammeAttribueGardien_refuse() {
      loggedIn(user(5));
      lenient().when(membershipService.hasRoleInProgram(5, 7, RoleNames.ADMIN)).thenReturn(true);
      lenient().when(membershipService.roleName(1)).thenReturn(RoleNames.GUARDIAN);
      assertThat(
              allowed(
                  "/api/roles/change",
                  "POST",
                  "{\"type\":\"assign\",\"programId\":7,\"userId\":9,\"roleId\":1}"))
          .isFalse();
    }

    @Test
    void changerRoleGlobal_gardienAssigneRoleNonGlobal_refuse() {
      // Rôle cible ni Gardien ni Admin (ex. Enseignant) : refus, même pour un gardien.
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.roleName(3)).thenReturn(RoleNames.TEACHER);
      assertThat(
              allowed("/api/roles/global/change", "POST", "{\"type\":\"assign\",\"roleId\":3}"))
          .isFalse();
    }

    @Test
    void changerRoleGlobal_retraitParEtudiant_refuse() {
      loggedIn(user(5));
      assertThat(
              allowed("/api/roles/global/change", "POST", "{\"type\":\"unassign\",\"roleId\":2}"))
          .isFalse();
    }

    @Test
    void changerRoleGlobal_typeNonTextuel_refuse() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/roles/global/change", "POST", "{\"type\":1,\"roleId\":2}"))
          .isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void changerRoleGlobal_roleIdEnChaine_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      when(membershipService.roleName(1)).thenReturn(RoleNames.GUARDIAN);
      assertThat(
              allowed(
                  "/api/roles/global/change", "POST", "{\"type\":\"assign\",\"roleId\":\"1\"}"))
          .isTrue();
    }

    @Test
    void candidatsRoleGlobal_gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/roles/global/candidates", "GET", null)).isTrue();
    }

    @Test
    void candidatsRoleGlobal_adminDuProgramme_refuse() {
      // Un rôle de PROGRAMME ne suffit pas : le prédicat ne regarde que les rôles globaux.
      loggedIn(user(5));
      assertThat(allowed("/api/roles/global/candidates", "GET", null)).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void listeRoles_scopeEncodee_autorise() {
      // Décodage %xx de la query : "scope=%67lobal" == "scope=global".
      loggedIn(user(5));
      when(membershipService.hasGlobalRole(5)).thenReturn(true);
      assertThat(allowed("/api/roles", "GET", null, "scope=%67lobal")).isTrue();
    }

    @Test
    void listeRoles_paireVideIgnoree_autorise() {
      // "&&" produit des paires vides, ignorées par le parseur.
      loggedIn(user(5));
      when(membershipService.hasGlobalRole(5)).thenReturn(true);
      assertThat(allowed("/api/roles", "GET", null, "&&scope=global&")).isTrue();
    }

    @Test
    void listeRoles_parametreSansValeur_refuse() {
      // "scope" sans '=' → valeur "" → scope inconnu → refus.
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/roles", "GET", null, "scope")).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void listeRoles_premiereOccurrenceGagne_refuse() {
      // "scope=banana&scope=global" : la 1re occurrence l'emporte → scope inconnu → refus.
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/roles", "GET", null, "scope=banana&scope=global")).isFalse();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Journal d'audit : Gardien uniquement
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class JournalDAudit {

    @Test
    void gardien_autorise() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(allowed("/api/audit-logs", "GET", null, "action=ROLE_ASSIGN")).isTrue();
    }

    @Test
    void adminGlobal_refuse() {
      loggedIn(user(5, RoleNames.ADMIN));
      assertThat(allowed("/api/audit-logs", "GET", null)).isFalse();
    }

    @Test
    void enseignant_refuse() {
      loggedIn(user(5, RoleNames.TEACHER));
      assertThat(allowed("/api/audit-logs", "GET", null)).isFalse();
    }

    @Test
    void etudiant_refuse() {
      loggedIn(user(5));
      assertThat(allowed("/api/audit-logs", "GET", null)).isFalse();
    }

    @Test
    void identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/api/audit-logs", "GET", null)).isFalse();
    }

    @Test
    void verbeEnMinuscules_regleAppliquee_refuse() {
      // Le verbe est comparé sans casse : "get" déclenche bien la règle (pas de contournement).
      loggedIn(user(5));
      assertThat(allowed("/api/audit-logs", "get", null)).isFalse();
    }

    /**
     * FAILLE PROBABLE (contournement par encodage) : le gateway transmet getRequestURI(), donc le
     * chemin BRUT non décodé, et le moteur le compare tel quel (AntPathMatcher). Or Spring MVC
     * côté core décode les segments avant le routage : "/api/audit%2Dlogs" atteint le contrôleur
     * /api/audit-logs, alors qu'ici il ne matche AUCUNE règle → GET → default-ALLOW (avant #111). Le pare-feu
     * Spring Security du gateway rejette %2F, %25, %3B, %5C, %2E… mais pas %2D ni une lettre
     * encodée (%65). Toute règle GET restrictive (journal d'audit, /quizzes/{id}/edit avec la
     * correction, /users/{id}, analyses MCP…) serait contournable ; les écritures restent
     * protégées par le default-deny. À confirmer en e2e (curl à travers le gateway). Comportement
     * attendu : décoder/normaliser le chemin avant la recherche de règle.
     */
    @Test
    void cheminEncode_etudiant_refuse() {
      lenient().when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(user(5)));
      assertThat(allowed("/api/audit%2Dlogs", "GET", null)).isFalse();
    }

    @Test
    void cheminEncode_vueEditeurQuiz_etudiant_refuse() {
      lenient().when(userRepository.findByEmail(EMAIL)).thenReturn(Optional.of(user(5)));
      lenient()
          .when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.ADMIN))
          .thenReturn(false);
      lenient()
          .when(membershipService.hasRoleInQuizCourse(5, 12, RoleNames.TEACHER))
          .thenReturn(false);
      assertThat(allowed("/api/quizzes/12/%65dit", "GET", null)).isFalse();
    }

    @Test
    void cheminEncode_gardien_garde_son_acces() {
      // Le décodage ne doit pas casser l'accès légitime : le gardien lit le journal même encodé.
      lenient()
          .when(userRepository.findByEmail(EMAIL))
          .thenReturn(Optional.of(user(5, RoleNames.GUARDIAN)));
      assertThat(allowed("/api/audit%2Dlogs", "GET", null)).isTrue();
    }

    @Test
    void cheminDoublementEncode_refuse() {
      // %252D se décode en « %2D » : jamais légitime, refusé même pour une route sans règle.
      assertThat(allowed("/api/audit%252Dlogs", "GET", null)).isFalse();
      assertThat(allowed("/api/catalogue%2541", "GET", null)).isFalse();
    }

    @Test
    void cheminEncodageInvalide_refuse() {
      assertThat(allowed("/api/audit%ZZlogs", "GET", null)).isFalse();
      assertThat(allowed("/api/audit-logs%", "GET", null)).isFalse();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Moteur : robustesse (exception de prédicat, verbes, garde d'entrée)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class Moteur {

    @Test
    void exceptionDansLePredicat_refuse() {
      // Une panne BD (exception du MembershipService) ne doit JAMAIS se transformer en accès.
      loggedIn(user(5));
      when(membershipService.canAccessForum(5, 9)).thenThrow(new RuntimeException("BD down"));
      assertThat(allowed("/api/forums/9/posts", "GET", null)).isFalse();
    }

    @Test
    void exceptionDansLePredicatDEcriture_refuse() {
      loggedIn(user(5));
      when(membershipService.isPostAuthor(5, 40)).thenThrow(new IllegalStateException("boom"));
      assertThat(allowed("/api/forums/9/posts/40", "DELETE", null)).isFalse();
    }

    @Test
    void emailVide_refuse() {
      assertThat(service().isAllowed("  ", "/api/me", "PATCH", "{}")).isFalse();
      verifyNoInteractions(userRepository);
    }

    // Depuis #111, refus par défaut pour TOUTES les méthodes (aucune règle HEAD / OPTIONS).
    @Test
    void headSansRegle_defaultDeny() {
      assertThat(allowed("/api/anything", "HEAD", null)).isFalse();
      verifyNoInteractions(userRepository);
    }

    @Test
    void optionsSansRegle_defaultDeny() {
      assertThat(allowed("/api/anything", "options", null)).isFalse();
      verifyNoInteractions(userRepository);
    }

    @Test
    void deleteSansRegle_defaultDeny() {
      assertThat(allowed("/api/anything/1", "DELETE", null)).isFalse();
      verifyNoInteractions(userRepository);
    }

    @Test
    void patchSansRegle_defaultDeny() {
      assertThat(allowed("/api/me/password", "PATCH", "{}")).isFalse();
    }

    @Test
    void verbeInconnuSansRegle_defaultDeny() {
      assertThat(allowed("/api/anything", "TRACE", null)).isFalse();
    }

    @Test
    void verbeEnMinuscules_ecritureOuverte_autorise() {
      loggedIn(user(5));
      assertThat(allowed("/api/me", "patch", "{}")).isTrue();
    }

    @Test
    void execSousApi_pasDeRegle_defaultDeny() {
      // Les règles exec sont sous /exec, pas /api/exec : POST /api/exec/run → default-deny.
      assertThat(allowed("/api/exec/run", "POST", "{}")).isFalse();
      verifyNoInteractions(userRepository);
    }

    @Test
    void miseAJourSettings_identiteInconnue_refuse() {
      unknownUser();
      assertThat(allowed("/api/me/settings", "PUT", "{}")).isFalse();
    }

    @Test
    void registreDesRegles_contientLesPrefixes() {
      // Les fabriques rule/mcpRule/execRule posent le bon préfixe sur chaque motif.
      assertThat(service().ruleSignatures())
          .contains(
              "GET /api/audit-logs",
              "GET /mcp/analyses/{id}",
              "POST /exec/run",
              "PATCH /api/courses/{courseId}")
          .allSatisfy(
              sig ->
                  assertThat(sig)
                      .matches("^(GET|POST|PUT|PATCH|DELETE) /(api|mcp|exec)/.*"));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  Id nul (0) : jamais un identifiant valide (SERIAL commence à 1)
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * Chaque règle qui lit un id (PATH ou BODY) le valide avec {@code id > 0} AVANT toute requête
   * BD. Un id 0 doit donc être refusé SANS consulter les appartenances : si la borne devenait
   * {@code >= 0}, la règle interrogerait la BD (et accorderait l'accès si la ligne existait).
   */
  @Nested
  class IdNulRefuseSansRequeteBd {

    static Stream<Arguments> routesAvecIdNul() {
      return Stream.of(
          Arguments.of("/api/forums/posts", "POST", "{\"forumId\":0}"),
          Arguments.of("/api/forums/posts/votes", "POST", "{\"forumId\":0}"),
          Arguments.of("/api/forums/messages", "POST", "{\"forumId\":0}"),
          Arguments.of("/api/forums/0/posts", "GET", null),
          Arguments.of("/api/courses/0/forums", "GET", null),
          Arguments.of("/api/courses/0/quizzes", "GET", null),
          Arguments.of("/api/courses/0/sections", "PATCH", "{}"),
          Arguments.of("/api/courses/forums", "POST", "{\"courseId\":0}"),
          Arguments.of("/api/courses/users", "POST", "{\"id\":5,\"programId\":0,\"courseIds\":[]}"),
          Arguments.of("/api/roles/change", "POST", "{\"programId\":0}"),
          Arguments.of("/api/programs/0/users", "GET", null),
          Arguments.of("/api/programs/0", "PATCH", "{}"),
          Arguments.of("/api/forums/0", "PATCH", "{}"),
          Arguments.of("/api/quizzes/0", "PUT", "{}"),
          Arguments.of("/api/quizzes/0", "GET", null),
          Arguments.of("/mcp/analyses/0", "GET", null),
          Arguments.of("/api/forums/1/posts/0", "PATCH", "{}"),
          Arguments.of("/api/forums/0/posts/0", "DELETE", null));
    }

    @ParameterizedTest(name = "{1} {0}")
    @MethodSource("routesAvecIdNul")
    void etudiant_idNul_refuseSansConsulterLesAppartenances(
        String path, String method, String body) {
      loggedIn(user(5));
      assertThat(allowed(path, method, body)).isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void roleGlobal_attributionRoleIdNul_gardien_refuseSansResoudreLeRole() {
      loggedIn(user(5, RoleNames.GUARDIAN));
      assertThat(
              allowed("/api/roles/global/change", "POST", "{\"type\":\"assign\",\"roleId\":0}"))
          .isFalse();
      verifyNoInteractions(membershipService);
    }

    @Test
    void roleProgramme_roleIdNul_adminDuProgramme_decideAuSeulRoleDansLeProgramme() {
      // roleId absent ou non positif : pas de résolution du rôle cible (le core rejettera la
      // requête) ; la décision repose sur le rôle Administrateur DANS le programme visé.
      loggedIn(user(5));
      when(membershipService.hasRoleInProgram(5, 3, RoleNames.ADMIN)).thenReturn(true);
      assertThat(allowed("/api/roles/change", "POST", "{\"programId\":3,\"roleId\":0}")).isTrue();
      verify(membershipService, never()).roleName(anyLong());
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  //  PATCH /courses/{courseId} : changement des programmes du cours (body.programIds)
  // ═══════════════════════════════════════════════════════════════════════════════════

  @Nested
  class ChangementDesProgrammesDuCours {

    private static final String PATH = "/api/courses/1";

    private void enseignantDuCours() {
      loggedIn(user(5));
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInCourse(5, 1, RoleNames.TEACHER)).thenReturn(true);
    }

    @ParameterizedTest
    @ValueSource(strings = {RoleNames.ADMIN, RoleNames.GUARDIAN})
    void roleGlobal_changeLesProgrammes_autoriseSansLireLesProgrammesActuels(String role) {
      loggedIn(user(5, role));
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":[3,99]}")).isTrue();
      verify(membershipService, never()).courseProgramIds(anyLong());
    }

    @Test
    void enseignant_ajouteUnProgrammeQuIlGere_autorise() {
      enseignantDuCours();
      when(membershipService.courseProgramIds(1)).thenReturn(List.of(3L));
      when(membershipService.hasRoleInProgram(5, 4, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInProgram(5, 4, RoleNames.TEACHER)).thenReturn(true);
      // Seul le programme 4 change (3 est conservé) : lui seul doit être géré.
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":[3,4]}")).isTrue();
    }

    @Test
    void enseignant_programmesInchanges_autoriseSansVerifierLesProgrammes() {
      enseignantDuCours();
      when(membershipService.courseProgramIds(1)).thenReturn(List.of(3L));
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":[3]}")).isTrue();
      verify(membershipService, never()).hasRoleInProgram(anyLong(), anyLong(), anyString());
    }

    @Test
    void enseignant_retireUnProgrammeQuIlNeGerePas_refuse() {
      enseignantDuCours();
      when(membershipService.courseProgramIds(1)).thenReturn(List.of(3L, 8L));
      when(membershipService.hasRoleInProgram(5, 8, RoleNames.ADMIN)).thenReturn(false);
      when(membershipService.hasRoleInProgram(5, 8, RoleNames.TEACHER)).thenReturn(false);
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":[3]}")).isFalse();
    }

    @Test
    void enseignant_programIdsNonTableau_refuse() {
      enseignantDuCours();
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":3}")).isFalse();
      verify(membershipService, never()).courseProgramIds(anyLong());
    }

    @Test
    void enseignant_programIdsNull_neChangeRien_autorise() {
      enseignantDuCours();
      assertThat(allowed(PATH, "PATCH", "{\"programIds\":null}")).isTrue();
    }
  }
}
