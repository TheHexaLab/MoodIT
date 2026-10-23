package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.CourseForumsDTO;
import com.moodit.core_service.dto.EnrollmentDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.dto.UserProgramsDTO;
import com.moodit.core_service.dto.UserUpdateDTO;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Enrollment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.RoleNames;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.UserProgramRole;
import com.moodit.core_service.repository.RoleRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/** Tests unitaires de {@link UserService} (dépôts et services collaborateurs mockés). */
@ExtendWith(MockitoExtension.class)
class UserServiceTest {

  @Mock private UserRepository userRepository;
  @Mock private ProgramService programService;
  @Mock private CourseService courseService;
  @Mock private UserProgramRoleRepository userProgramRoleRepository;
  @Mock private RoleRepository roleRepository;

  @InjectMocks private UserService userService;

  private static final LocalDateTime CREATED = LocalDateTime.of(2026, 9, 1, 8, 30);

  private static Role role(int id, String name) {
    Role r = new Role();
    r.setId(id);
    r.setName(name);
    return r;
  }

  private static Program program(int id) {
    return Program.builder().id(id).name("P" + id).code("C" + id).cohort("71").build();
  }

  private static User user() {
    return User.builder()
        .id(1)
        .username("alice")
        .firstName("Alice")
        .lastName("Tremblay")
        .email("alice@usherbrooke.ca")
        .settings("{\"theme\":\"dark\"}")
        .avatarColor("#ff0000")
        .createdAt(CREATED)
        .roles(new ArrayList<>(List.of(role(3, RoleNames.GUARDIAN))))
        .programs(new ArrayList<>())
        .enrollments(new ArrayList<>())
        .build();
  }

  private static Enrollment enrollment(User u, Course c) {
    Enrollment e = new Enrollment();
    e.setUser(u);
    e.setCourse(c);
    return e;
  }

  /** ProgramService.toProgramDTO simulé : id + nom, roleName vide (posé par UserService). */
  private void stubToProgramDTO() {
    when(programService.toProgramDTO(any())).thenAnswer(inv -> {
      Program p = inv.getArgument(0);
      return ProgramDTO.builder().id(p.getId()).name(p.getName()).build();
    });
  }

  @Nested
  class Transformations {

    @Test
    @DisplayName("toUserDTO copie les champs du profil et les ids des rôles globaux")
    void toUserDTO_copie_les_champs() {
      UserDTO dto = userService.toUserDTO(user());

      assertThat(dto.getId()).isEqualTo(1);
      assertThat(dto.getUsername()).isEqualTo("alice");
      assertThat(dto.getFirstName()).isEqualTo("Alice");
      assertThat(dto.getLastName()).isEqualTo("Tremblay");
      assertThat(dto.getEmail()).isEqualTo("alice@usherbrooke.ca");
      assertThat(dto.getSettings()).isEqualTo("{\"theme\":\"dark\"}");
      assertThat(dto.getAvatarColor()).isEqualTo("#ff0000");
      assertThat(dto.getCreatedAt()).isEqualTo(CREATED);
      assertThat(dto.getRoles()).containsExactly(3);
    }

    @Test
    @DisplayName("toUserProgramsDTO ajoute les programmes de l'utilisateur")
    void toUserProgramsDTO_ajoute_les_programmes() {
      User u = user();
      u.getPrograms().add(program(10));
      stubToProgramDTO();

      UserProgramsDTO dto = userService.toUserProgramsDTO(u);

      assertThat(dto.getUsername()).isEqualTo("alice");
      assertThat(dto.getSettings()).isEqualTo("{\"theme\":\"dark\"}");
      assertThat(dto.getPrograms()).extracting(ProgramDTO::getId).containsExactly(10);
    }
  }

  @Nested
  class Lectures {

    @Test
    @DisplayName("findById renvoie l'utilisateur avec ses programmes")
    void findById_trouve() {
      when(userRepository.findById(1)).thenReturn(Optional.of(user()));

      assertThat(userService.findById(1).getEmail()).isEqualTo("alice@usherbrooke.ca");
    }

    @Test
    @DisplayName("findById / findByUsername : inconnu → UserNotFoundException")
    void inconnu_lance_exception() {
      when(userRepository.findById(9)).thenReturn(Optional.empty());
      when(userRepository.findByUsername("bob")).thenReturn(Optional.empty());

      assertThatThrownBy(() -> userService.findById(9)).isInstanceOf(UserNotFoundException.class);
      assertThatThrownBy(() -> userService.findByUsername("bob"))
          .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    @DisplayName("findByUsername renvoie l'utilisateur correspondant")
    void findByUsername_trouve() {
      when(userRepository.findByUsername("alice")).thenReturn(Optional.of(user()));

      assertThat(userService.findByUsername("alice").getId()).isEqualTo(1);
    }

    @Test
    @DisplayName("findUsersByProgramAndRole interroge le dépôt avec (programme, rôle) et mappe en DTO")
    void findUsersByProgramAndRole_delegue_au_depot() {
      when(userRepository.findByPrograms_IdAndRoles_Id(10, 2)).thenReturn(List.of(user()));

      List<UserDTO> result = userService.findUsersByProgramAndRole(10, 2);

      assertThat(result).extracting(UserDTO::getUsername).containsExactly("alice");
    }
  }

  @Nested
  class FindProgramsByUserId {

    @Test
    @DisplayName("Pose sur chaque programme le rôle le plus élevé : Administrateur > Enseignant > aucun")
    void pose_le_role_le_plus_eleve() {
      User u = user();
      u.getPrograms().add(program(10)); // Enseignant + Administrateur → Administrateur
      u.getPrograms().add(program(11)); // Enseignant
      u.getPrograms().add(program(12)); // rôle non hiérarchique seulement → null
      u.getPrograms().add(program(13)); // aucun rôle → null
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(userProgramRoleRepository.findByUserId(1)).thenReturn(List.of(
          new UserProgramRole(10, 1, 1),
          new UserProgramRole(10, 1, 2),
          new UserProgramRole(11, 1, 1),
          new UserProgramRole(12, 1, 3)));
      when(roleRepository.findAll()).thenReturn(List.of(
          role(1, RoleNames.TEACHER), role(2, RoleNames.ADMIN), role(3, RoleNames.GUARDIAN)));
      stubToProgramDTO();

      List<ProgramDTO> result = userService.findProgramsByUserId(1);

      assertThat(result).extracting(ProgramDTO::getId).containsExactly(10, 11, 12, 13);
      assertThat(result).extracting(ProgramDTO::getRoleName)
          .containsExactly(RoleNames.ADMIN, RoleNames.TEACHER, null, null);
    }

    @Test
    @DisplayName("Utilisateur inconnu → UserNotFoundException, aucun rôle chargé")
    void utilisateur_inconnu() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> userService.findProgramsByUserId(1))
          .isInstanceOf(UserNotFoundException.class);
      verify(userProgramRoleRepository, never()).findByUserId(any());
    }
  }

  @Nested
  class UpdateUser {

    @Test
    @DisplayName("Met à jour prénom, nom et couleur d'avatar puis sauvegarde")
    void met_a_jour_les_champs() {
      User u = user();
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(userRepository.save(u)).thenReturn(u);

      UserDTO result = userService.updateUser(1,
          UserUpdateDTO.builder().firstName("Alicia").lastName("Roy").avatarColor("#00ff00").build());

      assertThat(result.getFirstName()).isEqualTo("Alicia");
      assertThat(result.getLastName()).isEqualTo("Roy");
      assertThat(result.getAvatarColor()).isEqualTo("#00ff00");
      verify(userRepository).save(u);
    }

    @Test
    @DisplayName("Champs null : valeurs existantes conservées")
    void champs_null_conserves() {
      User u = user();
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(userRepository.save(u)).thenReturn(u);

      UserDTO result = userService.updateUser(1, new UserUpdateDTO());

      assertThat(result.getFirstName()).isEqualTo("Alice");
      assertThat(result.getLastName()).isEqualTo("Tremblay");
      assertThat(result.getAvatarColor()).isEqualTo("#ff0000");
    }

    @Test
    @DisplayName("Utilisateur inconnu → UserNotFoundException, rien n'est sauvegardé")
    void utilisateur_inconnu() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> userService.updateUser(1, new UserUpdateDTO()))
          .isInstanceOf(UserNotFoundException.class);
      verify(userRepository, never()).save(any());
    }
  }

  @Nested
  class Inscriptions {

    @Test
    @DisplayName("getEnrollmentsByUser renvoie l'id du cours de chaque inscription")
    void getEnrollmentsByUser_renvoie_les_cours() {
      User u = user();
      u.getEnrollments().add(enrollment(u, Course.builder().id(5).code("A").build()));
      u.getEnrollments().add(enrollment(u, Course.builder().id(6).code("B").build()));
      when(userRepository.findById(1)).thenReturn(Optional.of(u));

      assertThat(userService.getEnrollmentsByUser(1))
          .extracting(EnrollmentDTO::getCourseId).containsExactly(5, 6);
    }

    // Bogue : getEnrollmentsByUser lève une RuntimeException("User not found") générique, non
    // gérée par GlobalExceptionHandler → HTTP 500 au lieu de 404 (les autres méthodes du service
    // lèvent UserNotFoundException).
    @Test
    @DisplayName("getEnrollmentsByUser : utilisateur inconnu → UserNotFoundException (404)")
    void getEnrollmentsByUser_inconnu_devrait_lancer_UserNotFound() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> userService.getEnrollmentsByUser(1))
          .isInstanceOf(UserNotFoundException.class);
    }

    @Test
    @DisplayName("getEnrollmentsByUserAndProgram : cours du programme seulement, dédupliqués")
    void getEnrollmentsByUserAndProgram_filtre_par_programme() {
      User u = user();
      Program p10 = program(10);
      Program p20 = program(20);
      Course inProgram = Course.builder().id(5).code("A").programs(List.of(p10)).build();
      Course otherProgram = Course.builder().id(6).code("B").programs(List.of(p20)).build();
      u.getEnrollments().add(enrollment(u, inProgram));
      u.getEnrollments().add(enrollment(u, otherProgram));
      u.getEnrollments().add(enrollment(u, inProgram)); // doublon → dédupliqué
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      CourseForumsDTO dto = new CourseForumsDTO();
      dto.setId(5);
      when(courseService.toCourseForumsDTO(inProgram)).thenReturn(dto);

      List<CourseForumsDTO> result = userService.getEnrollmentsByUserAndProgram(1, 10);

      assertThat(result).containsExactly(dto);
      verify(courseService, never()).toCourseForumsDTO(otherProgram);
    }

    @Test
    @DisplayName("getEnrollmentsByUserAndProgram : utilisateur inconnu → UserNotFoundException")
    void getEnrollmentsByUserAndProgram_inconnu() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> userService.getEnrollmentsByUserAndProgram(1, 10))
          .isInstanceOf(UserNotFoundException.class);
    }
  }
}
