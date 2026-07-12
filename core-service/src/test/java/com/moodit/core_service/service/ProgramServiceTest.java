package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.*;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.*;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
public class ProgramServiceTest {

    // @Mock crée une fausse version du repository, pas la vrai BD
    @Mock private ProgramRepository programRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private UserRepository userRepository;
    @Mock private UserProgramRoleRepository userProgramRoleRepository;
    @Mock private EnrollmentRepository enrollmentRepository;
    @Mock private RealtimeEventPublisher realtimePublisher;
    @Mock private AuditLogService auditLogService;

    //@InjectMocks crée le service et injecte les @Mock dedans automatiquement
    @InjectMocks private ProgramService programService;

    private Program program;
    private Course course;
    private User user;

    // NB : addCourseToPrograms ne fait plus de contrôle de rôle (délégué au permission-service) :
    // les tests ci-dessous n'ont donc plus besoin de simuler un utilisateur admin.

    @Nested
    class FindAll {
        @Test
        @DisplayName("Retourner la liste de programmes")
        void findAll_devrait_retourner_liste_de_programmes() {
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").build();
            Program program2 = Program.builder().id(1).name("Électrique").code("GE").cohort("71").color("FF0000").build();

            when(programRepository.findAll()).thenReturn(List.of(program, program2));

            List<ProgramDTO> result = programService.findAll();

            assertEquals(2, result.size());
            assertEquals("Informatique", result.get(0).getName());
            assertEquals("Électrique", result.get(1).getName());
        }

        @Test
        @DisplayName("Retourner une liste vide si aucun programme")
        void findAll_devrait_retourner_liste_vide() {
            when(programRepository.findAll()).thenReturn(List.of());

            List<ProgramDTO> result = programService.findAll();

            assertEquals(0, result.size());
        }
    }

    @Nested
    class findById {
        @Test
        @DisplayName("Retourne le programme recherché")
        void findById_devrait_retourner_le_programme() {
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").build();
            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            ProgramDTO result = programService.findById(1);

            assertEquals(1, result.getId());
            assertEquals("GI", result.getCode());
            //S'assurer que findById(1) a bien été appelé une seule fois
            verify(programRepository, times(1)).findById(1);
        }

        @Test
        @DisplayName("Retourne ProgramNotFoundException, Aucun programme trouvé")
        void findById_programme_inexistant_devrait_lancer_exception() {
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.findById(99));
            verify(programRepository, times(1)).findById(99);
        }

        @Test
        @DisplayName("Retourne IllegalArgumentException, Programme id est null")
        void findById_avec_id_null_devrait_lancer_exception() {
            assertThrows(IllegalArgumentException.class, () -> programService.findById(null));
            verifyNoInteractions(programRepository);
        }
    }

    @Nested
    class getCoursesByProgram {
        @Test
        @DisplayName("Retourne tous les cours d'un programme")
        void getCoursesByProgram_devrait_retourner_les_cours() {
            course = Course.builder().id(10).title("Base de données").code("BD101").build();
            Course course2 = Course.builder().id(11).title("Patron de conception").code("PATRON42").build();
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(List.of(course, course2)).build();

            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            ProgramCoursesDTO result = programService.getCoursesByProgram(1);

            assertEquals(2, result.getCourses().size());
            assertEquals("Base de données", result.getCourses().get(0).getTitle());
            assertEquals("Patron de conception", result.getCourses().get(1).getTitle());
            verify(programRepository, times(1)).findById(1);
        }

        @Test
        @DisplayName("Retourne ProgramNotFoundException, Aucun programme trouvé")
        void getCoursesByProgram_avec_id_inexistant_devrait_lancer_programNotFoundException() {
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.getCoursesByProgram(99));
            verify(programRepository, times(1)).findById(99);
        }

        @Test
        @DisplayName("Retourne une liste vide de cours si le programme n'a aucun cours associé")
        void getCoursesByProgram_programme_sans_cours_devrait_retourner_liste_vide() {
            program = Program.builder().id(1).name("Art").code("ART").cohort("71").color("00FF00").courses(List.of()).build();
            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            ProgramCoursesDTO result = programService.getCoursesByProgram(1);

            assertNotNull(result.getCourses());
            assertTrue(result.getCourses().isEmpty());
            assertEquals(0, result.getCourses().size());
            verify(programRepository, times(1)).findById(1);
        }

        @Test
        @DisplayName("Retourne IllegalArgumentException, Programme id est null")
        void getCoursesByProgram_avec_id_null_devrait_lancer_exception() {
            assertThrows(IllegalArgumentException.class, () -> programService.findById(null));
            verifyNoInteractions(programRepository);
        }
    }

    @Nested
    class getCourseByProgram {
        @Test
        @DisplayName("Retourne le cours recherché dans un programme")
        void getCourseByProgram_devrait_retourner_le_cours() {
            course = Course.builder().id(10).title("Base de données").code("BD101").build();
            Course course2 = Course.builder().id(11).title("Patron de conception").code("PATRON42").build();
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(List.of(course, course2)).build();
            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            CourseDTO result = programService.getCourseByProgram(1, 11);

            assertEquals("PATRON42", result.getCode());
            verify(programRepository, times(1)).findById(1);
        }
        @Test
        @DisplayName("Retourne CourseNotFound, le cours n'appartient pas au programme spécifié")
        void getCourseByProgram_cours_non_associe_devrait_lancer_exception() {
            course = Course.builder().id(10).title("Base de données").code("BD101").build();
            Course course2 = Course.builder().id(11).title("Patron de conception").code("PATRON42").build();
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(List.of(course, course2)).build();

            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            assertThrows(CourseNotFoundException.class, () -> programService.getCourseByProgram(1, 99));
            verify(programRepository, times(1)).findById(1);
        }
        @Test
        @DisplayName("Retourne CourseNotFoundException, le cours n'existe pas")
        void getCourseByProgram_cours_inexistant_devrait_lancer_exception() {
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(List.of()).build();
            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            assertThrows(CourseNotFoundException.class, () -> programService.getCourseByProgram(1, 99));
            verify(programRepository, times(1)).findById(1);
        }
        @Test
        @DisplayName("Retourne ProgramNotFoundException, le program n'existe pas")
        void getCourseByProgram_program_inexistant_devrait_lancer_exception() {
            when(programRepository.findById(1)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.getCourseByProgram(1, 99));
            verify(programRepository, times(1)).findById(1);
        }
        @Test
        @DisplayName("Retourne IllegalArgumentException, l'un des identifiants fournis est null")
        void getCourseByProgram_arguments_null_devrait_lancer_illegalArgumentException() {
            assertThrows(IllegalArgumentException.class, () -> programService.getCourseByProgram(null, 11));
            assertThrows(IllegalArgumentException.class, () -> programService.getCourseByProgram(1, null));
            verifyNoInteractions(programRepository);
        }
    }

    @Nested
    class addCourseToPrograms {
        @Test
        @DisplayName("Ajouter un cours à plusieurs programmes")
        void addCourseToPrograms_devrait_sauvegarder_le_cours() {
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(new ArrayList<>()).build();
            Program program2 = Program.builder().id(2).name("Réseaux").courses(new ArrayList<>()).build();
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder().title("Mathématique de l'ingénierie").code("MATH67").programIds(List.of(1, 2)).build();

            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(1);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            when(programRepository.findById(2)).thenReturn(Optional.of(program2));

            CourseDTO result = programService.addCourseToPrograms(dto);

            assertEquals("Mathématique de l'ingénierie", result.getTitle());
            assertEquals(1, program.getCourses().size());
            assertEquals("Mathématique de l'ingénierie", program.getCourses().get(0).getTitle());
            assertEquals(1, program2.getCourses().size());
            assertEquals("Mathématique de l'ingénierie", program2.getCourses().get(0).getTitle());
            verify(courseRepository, times(1)).save(any(Course.class));
            verify(programRepository, times(1)).saveAll(anyList());
        }
        @Test
        @DisplayName("Inscrit automatiquement le créateur au cours créé + journalise (ENROLLMENT_JOIN)")
        void addCourseToPrograms_inscrit_le_createur() {
            program = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder()
                    .title("Algo").code("GIF201").programIds(List.of(1)).build();

            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(42);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            // Acteur (créateur) résolu via le SecurityContext (exposé par AuditLogService).
            when(auditLogService.currentActor()).thenReturn("prof@moodit.ca");
            User creator = User.builder().id(7).username("prof").build();
            when(userRepository.findByEmail("prof@moodit.ca")).thenReturn(Optional.of(creator));
            when(enrollmentRepository.findByUserIdAndCourseId(7, 42)).thenReturn(Optional.empty());

            programService.addCourseToPrograms(dto);

            verify(enrollmentRepository, times(1)).save(any(Enrollment.class));
            verify(auditLogService, times(1))
                    .record(eq("ENROLLMENT_JOIN"), eq("ENROLLMENT"), eq(42), anyString(), anyString());
        }
        @Test
        @DisplayName("N'inscrit PAS deux fois le créateur (idempotent) si déjà inscrit")
        void addCourseToPrograms_createur_deja_inscrit_ne_reinscrit_pas() {
            program = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder()
                    .title("Algo").code("GIF201").programIds(List.of(1)).build();

            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(42);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            when(auditLogService.currentActor()).thenReturn("prof@moodit.ca");
            User creator = User.builder().id(7).username("prof").build();
            when(userRepository.findByEmail("prof@moodit.ca")).thenReturn(Optional.of(creator));
            Enrollment existing = new Enrollment();
            when(enrollmentRepository.findByUserIdAndCourseId(7, 42)).thenReturn(Optional.of(existing));

            programService.addCourseToPrograms(dto);

            verify(enrollmentRepository, never()).save(any(Enrollment.class));
            verify(auditLogService, never())
                    .record(eq("ENROLLMENT_JOIN"), eq("ENROLLMENT"), eq(42), anyString(), anyString());
        }
        @Test
        @DisplayName("Retourne ProgramNotFoundException, si au moins un des programmes n'existe pas")
        void addCourseToPrograms_avec_un_id_inexistant_devrait_lancer_exception() {
            program = Program.builder().id(1).name("Informatique").code("GI").cohort("71").color("FF0000").courses(new ArrayList<>()).build();
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder().title("Système distribués").code("SYST45").programIds(List.of(1, 99)).build();

            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.addCourseToPrograms(dto));
            verify(programRepository, never()).saveAll(anyList());
        }
        @Test
        @DisplayName("Retourne IllegalArgumentException, si les id sont null")
        void addCourseToPrograms_avec_arguments_null_devrait_lancer_illegalArgumentException() {
            assertThrows(IllegalArgumentException.class, () -> programService.addCourseToPrograms(null));

            CourseCreateInProgramsDTO dtoAvecListeNull = CourseCreateInProgramsDTO.builder()
                    .title("Chimie")
                    .code("CHM10")
                    .programIds(null)
                    .build();

            assertThrows(IllegalArgumentException.class, () -> programService.addCourseToPrograms(dtoAvecListeNull));
            verifyNoInteractions(programRepository, courseRepository);
        }
        @Test
        @DisplayName("Retourne IllegalArgumentException et ne crée aucun cours, si la liste de programmes est vide")
        void addCourseToPrograms_avec_liste_vide_ne_devrait_pas_creer_de_cours() {
            CourseCreateInProgramsDTO dtoAvecListeVide = CourseCreateInProgramsDTO.builder()
                    .title("Chimie")
                    .code("CHM10")
                    .programIds(List.of())
                    .build();

            assertThrows(IllegalArgumentException.class, () -> programService.addCourseToPrograms(dtoAvecListeVide));
            verifyNoInteractions(programRepository, courseRepository);
        }
        @Test
        @DisplayName("Gère correctement les doublons d'IDs dans la requête sans dupliquer l'association")
        void addCourseToPrograms_avec_id_doublon_ne_devrait_pas_creer_de_doublon() {
            program = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder()
                    .title("Algèbre")
                    .code("ALG02")
                    .programIds(List.of(1, 1)) // Doublon
                    .build();

            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(1);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));

            programService.addCourseToPrograms(dto);

            assertEquals(1, program.getCourses().size());
        }
    }

    @Nested
    class addUserToPrograms {
        @Test
        @DisplayName("Ajouter un usager à dess programmes")
        void addUserToPrograms_devrait_associer_usager_au_programme() {
            User userTest = User.builder().id(1).username("jdoe").email("jdoe@moodit.com").programs(new ArrayList<>()).build();
            Program programTest = Program.builder().id(1).name("Informatique").build();
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder().id(1).programIds(List.of(1)).build();

            when(userRepository.findById(1)).thenReturn(Optional.of(userTest));
            when(programRepository.findById(1)).thenReturn(Optional.of(programTest));

            programService.addUserToPrograms(dto);

            verify(userRepository, times(1)).save(userTest);
            assertEquals(1, userTest.getPrograms().size());
            assertEquals("Informatique", userTest.getPrograms().get(0).getName());
        }

        @Test
        @DisplayName("Retourner UserNotFoundException, si l'usager n'existe pas")
        void addUserToPrograms_usager_inexistant_devrait_lancer_exception() {
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder().id(99).programIds(List.of(1)).build();

            when(userRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(UserNotFoundException.class, () -> programService.addUserToPrograms(dto));
            verify(userRepository, never()).save(any(User.class));
        }

        @Test
        @DisplayName("Retourner ProgramNotFoundException, si un programme n'existe pas")
        void addUserToPrograms_programme_inexistant_devrait_lancer_exception() {
            User userTest = User.builder().id(1).programs(new ArrayList<>()).build();
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder().id(1).programIds(List.of(99)).build();

            when(userRepository.findById(1)).thenReturn(Optional.of(userTest));
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.addUserToPrograms(dto));
            verify(userRepository, never()).save(any(User.class));
        }

        @Test
        @DisplayName("Retourner IllegalArgumentException, si les ids sont null")
        void addUserToPrograms_avec_arguments_null_devrait_lancer_illegalArgumentException() {
            assertThrows(IllegalArgumentException.class, () -> programService.addUserToPrograms(null));
            UserCreateInProgramsDTO dtoAvecListeNull = UserCreateInProgramsDTO.builder().id(1).programIds(null).build();

            assertThrows(IllegalArgumentException.class, () -> programService.addUserToPrograms(dtoAvecListeNull));
            verifyNoInteractions(userRepository, programRepository);
        }

        @Test
        @DisplayName("Gère correctement les doublons d'IDs dans la requête sans dupliquer l'association")
        void addUserToPrograms_avec_id_doublon_ne_devrait_pas_creer_de_doublon() {
            User userTest = User.builder().id(1).programs(new ArrayList<>()).build();
            Program programTest = Program.builder().id(1).name("Informatique").build();
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder().id(1).programIds(List.of(1, 1)).build();

            when(userRepository.findById(1)).thenReturn(Optional.of(userTest));
            when(programRepository.findById(1)).thenReturn(Optional.of(programTest));

            programService.addUserToPrograms(dto);

            assertEquals(1, userTest.getPrograms().size());
        }
    }

    @Nested
    class updateProgram {
        @Test
        @DisplayName("Modifier un program")
        void updateProgram_devrait_modifier_le_programme() {
            Program programExistant = Program.builder().id(1).name("Ancien Nom").code("101").cohort("71").build();
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder().name("Nouveau Nom").code("421").build();

            when(programRepository.findById(1)).thenReturn(Optional.of(programExistant));
            when(programRepository.save(any(Program.class))).thenAnswer(invocation -> invocation.getArgument(0));

            ProgramDTO result = programService.updateProgram(1, dto);

            verify(programRepository, times(1)).save(programExistant);

            // Validé la mise à jour
            assertEquals("Nouveau Nom", programExistant.getName());
            assertEquals("421", programExistant.getCode());
            assertEquals("71", programExistant.getCohort());

            // Vérifié le retour envoyé au contrôleur
            assertNotNull(result);
            assertEquals("Nouveau Nom", result.getName());
            assertEquals("421", result.getCode());
        }
        @Test
        @DisplayName("Retourne ProgramNotFoundException, si le programme à modifier n'existe pas")
        void updateProgram_programme_inexistant_devrait_lancer_exception() {
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder().name("Nom").code("123").build();
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertThrows(ProgramNotFoundException.class, () -> programService.updateProgram(99, dto));
            verify(programRepository, never()).save(any(Program.class));
        }

        @Test
        @DisplayName("Retourne IllegalArgumentException, l'ID de modification est null")
        void updateProgram_avec_arguments_null_devrait_lancer_illegalArgumentException() {
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder().name("Nom").build();

            assertThrows(IllegalArgumentException.class, () -> programService.updateProgram(null, dto));
            assertThrows(IllegalArgumentException.class, () -> programService.updateProgram(1, null));
            verifyNoInteractions(programRepository);
        }
    }

    @Nested
    class removeUserFromProgram {
        @Test
        @DisplayName("Quitter un programme retire l'adhésion, les rôles ET les inscriptions du programme")
        void removeUserFromProgram_retire_roles_et_inscriptions() {
            User u = new User();
            u.setId(5);
            Program p = Program.builder().id(1).build();
            u.setPrograms(new ArrayList<>(List.of(p)));
            when(userRepository.findById(5)).thenReturn(Optional.of(u));

            programService.removeUserFromProgram(1, 5);

            assertEquals(0, u.getPrograms().size());               // User_Program retiré
            verify(userRepository).saveAndFlush(u);                 // flush avant les nettoyages
            verify(userProgramRoleRepository).deleteByProgramIdAndUserId(1, 5); // rôles retirés
            verify(enrollmentRepository).deleteForUserLeavingProgram(5, 1);     // inscriptions retirées
        }
    }
}

