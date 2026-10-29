package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.*;
import com.moodit.core_service.model.*;
import com.moodit.core_service.repository.*;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
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
    @Mock private FTypeRepository fTypeRepository;

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

            assertEquals(1, result.getId());
            assertEquals("Informatique", result.getName());
            assertEquals("GI", result.getCode());
            assertEquals("71", result.getCohort());
            assertEquals("FF0000", result.getColor());
            assertEquals(10, result.getCourses().get(0).getId());
            assertEquals("BD101", result.getCourses().get(0).getCode());
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

            assertEquals(1, result.getId());
            // Journalisé avec le contexte des programmes visés…
            verify(auditLogService).record("COURSE_CREATE", "COURSE", 1,
                    "Cours « Mathématique de l'ingénierie » (MATH67) créé",
                    "Programmes : Informatique, Réseaux");
            // …et diffusé en direct dans CHAQUE programme (hors transaction → immédiat).
            com.moodit.core_service.realtime.dto.CourseDto live =
                    com.moodit.core_service.realtime.dto.CourseDto.of(1, "MATH67", "Mathématique de l'ingénierie");
            verify(realtimePublisher).courseCreated(1L, live);
            verify(realtimePublisher).courseCreated(2L, live);
        }

        @Test
        @DisplayName("Le nouveau cours reçoit son canal « Annonces »")
        void addCourseToPrograms_cree_le_canal_annonces() {
            Program gi = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            FType announcement = new FType();
            announcement.setId(3);
            announcement.setName("Announcement");
            when(fTypeRepository.findByName("Announcement")).thenReturn(Optional.of(announcement));
            when(programRepository.findById(1)).thenReturn(Optional.of(gi));
            ArgumentCaptor<Course> saved = ArgumentCaptor.forClass(Course.class);
            when(courseRepository.save(saved.capture())).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(1);
                return c;
            });

            programService.addCourseToPrograms(
                    CourseCreateInProgramsDTO.builder().title("Physique").code("PHY1").programIds(List.of(1)).build());

            List<Forum> forums = saved.getValue().getForums();
            assertEquals(1, forums.size());
            assertEquals("Annonces", forums.get(0).getTitle());
            assertEquals(announcement, forums.get(0).getFType());
            assertEquals(saved.getValue(), forums.get(0).getCourse());
        }

        @Test
        @DisplayName("Dans une transaction : courseCreated diffusé seulement APRÈS le commit")
        void addCourseToPrograms_diffusion_apres_commit() {
            program = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(3);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
            try {
                programService.addCourseToPrograms(CourseCreateInProgramsDTO.builder()
                        .title("Algo").code("GIF201").programIds(List.of(1)).build());

                verifyNoInteractions(realtimePublisher);
                org.springframework.transaction.support.TransactionSynchronizationManager.getSynchronizations()
                        .forEach(org.springframework.transaction.support.TransactionSynchronization::afterCommit);
                verify(realtimePublisher).courseCreated(1L,
                        com.moodit.core_service.realtime.dto.CourseDto.of(3, "GIF201", "Algo"));
            } finally {
                org.springframework.transaction.support.TransactionSynchronizationManager.clearSynchronization();
            }
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

            CourseDTO created = programService.addCourseToPrograms(dto);

            org.mockito.ArgumentCaptor<Enrollment> enrollment = org.mockito.ArgumentCaptor.forClass(Enrollment.class);
            verify(enrollmentRepository, times(1)).save(enrollment.capture());
            assertSame(creator, enrollment.getValue().getUser());
            assertEquals(42, enrollment.getValue().getCourse().getId());
            assertNotNull(enrollment.getValue().getEnrolledAt());
            assertEquals(42, created.getId());
            verify(auditLogService, times(1)).record("ENROLLMENT_JOIN", "ENROLLMENT", 42,
                    "Inscription au cours « Algo » (GIF201) à sa création",
                    "Cours : Algo (GIF201)\nProgrammes : Informatique"
                            + "\nUtilisateur : prof");
        }

        @Test
        @DisplayName("Créateur sans nom d'utilisateur → référencé par #id dans le journal")
        void addCourseToPrograms_createur_sans_username() {
            program = Program.builder().id(1).name("Informatique").courses(new ArrayList<>()).build();
            when(courseRepository.save(any(Course.class))).thenAnswer(inv -> {
                Course c = inv.getArgument(0);
                c.setId(42);
                return c;
            });
            when(programRepository.findById(1)).thenReturn(Optional.of(program));
            when(auditLogService.currentActor()).thenReturn("prof@moodit.ca");
            when(userRepository.findByEmail("prof@moodit.ca")).thenReturn(Optional.of(User.builder().id(7).build()));
            when(enrollmentRepository.findByUserIdAndCourseId(7, 42)).thenReturn(Optional.empty());

            programService.addCourseToPrograms(CourseCreateInProgramsDTO.builder()
                    .title("Algo").code("GIF201").programIds(List.of(1)).build());

            verify(auditLogService).record(eq("ENROLLMENT_JOIN"), eq("ENROLLMENT"), eq(42), anyString(),
                    argThat((String d) -> d.endsWith("\nUtilisateur : #7")));
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
            // Programme introuvable → nom de repli « #id » ; utilisateur sans username → « #id ».
            verify(auditLogService).record("PROGRAM_MEMBER_REMOVE", "PROGRAM", 1,
                    "Utilisateur #5 retiré du programme « #1 »", "Programme : #1");
            verify(realtimePublisher).subscriptionRemoved(5L, 1L);
        }

        @Test
        @DisplayName("Quitter un programme : le journal nomme l'utilisateur et le programme ; les autres programmes restent")
        void removeUserFromProgram_journal_nomme() {
            User u = User.builder().id(5).username("alice").build();
            Program quitte = Program.builder().id(1).name("Informatique").build();
            Program garde = Program.builder().id(2).name("Réseaux").build();
            u.setPrograms(new ArrayList<>(List.of(quitte, garde)));
            when(userRepository.findById(5)).thenReturn(Optional.of(u));
            when(programRepository.findById(1)).thenReturn(Optional.of(quitte));

            programService.removeUserFromProgram(1, 5);

            assertEquals(List.of(garde), u.getPrograms());
            verify(auditLogService).record("PROGRAM_MEMBER_REMOVE", "PROGRAM", 1,
                    "Utilisateur alice retiré du programme « Informatique »", "Programme : Informatique");
        }
    }

    // ── Chemins complémentaires (#90) : membres, candidats, synchro par établissement, échos WS ──

    private static Establishment establishment(int id, String name) {
        Establishment e = new Establishment();
        e.setId(id);
        e.setName(name);
        return e;
    }

    private static Program programIn(int id, Establishment est) {
        return Program.builder().id(id).name("P" + id).code("C" + id).cohort("71").color("#00000" + id)
                .establishment(est).build();
    }

    @Nested
    class getUsersByProgram {
        @Test
        @DisplayName("Chaque membre porte ses rôles DANS ce programme (vide s'il n'en a pas)")
        void getUsersByProgram_roles_par_programme() {
            User alice = User.builder().id(1).username("alice").email("a@test.ca")
                    .firstName("Alice").lastName("Lovelace").settings("{\"theme\":\"dark\"}")
                    .avatarColor("#123456").createdAt(java.time.LocalDateTime.of(2026, 1, 2, 3, 4)).build();
            User bob = User.builder().id(2).username("bob").build();
            when(userProgramRoleRepository.findByProgramId(10)).thenReturn(List.of(
                    new UserProgramRole(10, 1, 1), new UserProgramRole(10, 1, 2)));
            when(userRepository.findDistinctByPrograms_Id(10)).thenReturn(List.of(alice, bob));

            List<UserDTO> result = programService.getUsersByProgram(10);

            assertEquals(2, result.size());
            assertEquals("alice", result.get(0).getUsername());
            assertEquals("a@test.ca", result.get(0).getEmail());
            assertEquals(1, result.get(0).getId());
            assertEquals("Alice", result.get(0).getFirstName());
            assertEquals("Lovelace", result.get(0).getLastName());
            assertEquals("{\"theme\":\"dark\"}", result.get(0).getSettings());
            assertEquals("#123456", result.get(0).getAvatarColor());
            assertEquals(java.time.LocalDateTime.of(2026, 1, 2, 3, 4), result.get(0).getCreatedAt());
            assertEquals(List.of(1, 2), result.get(0).getRoles());
            assertEquals(List.of(), result.get(1).getRoles());
        }
    }

    @Nested
    class getProgramRoleCandidates {
        @Test
        @DisplayName("Normalise la recherche (trim + minuscules), borne page/taille et joint les rôles actuels")
        void getProgramRoleCandidates_normalise_et_borne() {
            User bob = User.builder().id(2).username("bob").build();
            when(userProgramRoleRepository.findByProgramId(10)).thenReturn(List.of(new UserProgramRole(10, 2, 1)));
            when(userRepository.findProgramRoleCandidates(eq(10), eq(2), any(), any())).thenReturn(List.of(bob));

            List<UserDTO> first = programService.getProgramRoleCandidates(10, 2, "  BoB ", -1, 0);
            programService.getProgramRoleCandidates(10, 2, null, 3, 999);

            org.mockito.ArgumentCaptor<String> q = org.mockito.ArgumentCaptor.forClass(String.class);
            org.mockito.ArgumentCaptor<org.springframework.data.domain.Pageable> page =
                    org.mockito.ArgumentCaptor.forClass(org.springframework.data.domain.Pageable.class);
            verify(userRepository, times(2)).findProgramRoleCandidates(eq(10), eq(2), q.capture(), page.capture());
            assertEquals(List.of("bob", ""), q.getAllValues());
            assertEquals(0, page.getAllValues().get(0).getPageNumber());
            assertEquals(10, page.getAllValues().get(0).getPageSize());
            assertEquals(3, page.getAllValues().get(1).getPageNumber());
            assertEquals(50, page.getAllValues().get(1).getPageSize());
            assertEquals(List.of(1), first.get(0).getRoles());
        }
    }

    @Nested
    class addUserToProgramsParEtablissement {
        @Test
        @DisplayName("establishmentId fourni : retire les programmes déselectionnés de CET établissement seulement, ajoute les nouveaux, émet les deux")
        void addUserToPrograms_synchro_scopee_a_l_etablissement() {
            Establishment udes = establishment(1, "UdeS");
            Establishment poly = establishment(2, "Poly");
            Program p1 = programIn(1, udes);   // déselectionné → retiré
            Program p2 = programIn(2, poly);   // autre établissement → conservé
            Program p3 = programIn(3, udes);   // demandé → ajouté
            User u = User.builder().id(5).username("alice").programs(new ArrayList<>(List.of(p1, p2))).build();
            when(userRepository.findById(5)).thenReturn(Optional.of(u));
            when(programRepository.findById(3)).thenReturn(Optional.of(p3));
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder()
                    .id(5).programIds(List.of(3)).establishmentId(1).build();

            programService.addUserToPrograms(dto);

            assertEquals(List.of(p2, p3), u.getPrograms());
            verify(userRepository).save(u);
            verify(auditLogService).record("PROGRAM_MEMBER_ADD", "PROGRAM", 3,
                    "Utilisateur alice ajouté au(x) programme(s) : P3", "Programme(s) : P3");
            verify(realtimePublisher).subscriptionRemoved(5L, 1L);
            verify(realtimePublisher).subscriptionAdded(5L,
                    new com.moodit.core_service.realtime.dto.ProgramDto(3, "P3", "C3", "71", "#000003"));
        }

        @Test
        @DisplayName("Programmes déjà suivis : rien n'est ajouté, l'audit replie sur les ids (entityId null si plusieurs)")
        void addUserToPrograms_deja_suivis_repli_sur_les_ids() {
            Program p1 = programIn(1, null);
            Program p2 = programIn(2, null);
            User u = User.builder().id(5).programs(new ArrayList<>(List.of(p1, p2))).build();
            when(userRepository.findById(5)).thenReturn(Optional.of(u));

            programService.addUserToPrograms(UserCreateInProgramsDTO.builder().id(5).programIds(List.of(1, 2)).build());

            assertEquals(List.of(p1, p2), u.getPrograms());
            verify(programRepository, never()).findById(any());
            verify(auditLogService).record(eq("PROGRAM_MEMBER_ADD"), eq("PROGRAM"), isNull(),
                    eq("Utilisateur #5 ajouté au(x) programme(s) : [1, 2]"), eq("Programme(s) : [1, 2]"));
            verifyNoInteractions(realtimePublisher);
        }
    }

    @Nested
    class updateProgramComplet {
        @Test
        @DisplayName("Met à jour tous les champs, journalise l'établissement, émet programUpdated par abonné et republie le catalogue")
        void updateProgram_tous_les_champs_et_echos() {
            Establishment udes = establishment(1, "UdeS");
            Program p = programIn(10, udes);
            when(programRepository.findById(10)).thenReturn(Optional.of(p));
            when(userRepository.findDistinctByPrograms_Id(10)).thenReturn(List.of(
                    User.builder().id(100).build(), User.builder().id(101).build()));
            when(programRepository.findByEstablishment_Id(1)).thenReturn(List.of(p));
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder()
                    .name("Génie info").code("GIF").cohort("72").color("#abcdef").build();

            ProgramDTO result = programService.updateProgram(10, dto);

            assertEquals("Génie info", result.getName());
            assertEquals("GIF", result.getCode());
            assertEquals("72", result.getCohort());
            assertEquals("#abcdef", result.getColor());
            verify(auditLogService).record("PROGRAM_UPDATE", "PROGRAM", 10,
                    "Programme « Génie info » mis à jour", "Établissement : UdeS");
            com.moodit.core_service.realtime.dto.ProgramDto expected =
                    new com.moodit.core_service.realtime.dto.ProgramDto(10, "Génie info", "GIF", "72", "#abcdef");
            verify(realtimePublisher).programUpdated(100L, expected);
            verify(realtimePublisher).programUpdated(101L, expected);
            verify(realtimePublisher).establishmentUpdated(1L, List.of(expected));
        }
    }

    @Nested
    class catalogueEtRecherche {
        @Test
        @DisplayName("publishEstablishmentCatalog(null) ne fait rien")
        void publishEstablishmentCatalog_null_sans_effet() {
            programService.publishEstablishmentCatalog(null);

            verifyNoInteractions(programRepository, realtimePublisher);
        }

        @Test
        @DisplayName("Dans une transaction, l'écho du catalogue n'est émis qu'APRÈS le commit")
        void publishEstablishmentCatalog_attend_le_commit() {
            when(programRepository.findByEstablishment_Id(1)).thenReturn(List.of());
            org.springframework.transaction.support.TransactionSynchronizationManager.initSynchronization();
            try {
                programService.publishEstablishmentCatalog(1);
                verify(realtimePublisher, never()).establishmentUpdated(anyLong(), any());

                org.springframework.transaction.support.TransactionSynchronizationManager.getSynchronizations()
                        .forEach(org.springframework.transaction.support.TransactionSynchronization::afterCommit);
                verify(realtimePublisher).establishmentUpdated(1L, List.of());
            } finally {
                org.springframework.transaction.support.TransactionSynchronizationManager.clearSynchronization();
            }
        }

        @Test
        @DisplayName("findProgramById renvoie l'entité ou lance ProgramNotFoundException")
        void findProgramById_trouve_ou_echoue() {
            Program p = programIn(10, null);
            when(programRepository.findById(10)).thenReturn(Optional.of(p));
            when(programRepository.findById(99)).thenReturn(Optional.empty());

            assertSame(p, programService.findProgramById(10));
            assertThrows(ProgramNotFoundException.class, () -> programService.findProgramById(99));
        }

        @Test
        @DisplayName("getCoursesByProgram(null) → IllegalArgumentException sans accès BD")
        void getCoursesByProgram_id_null() {
            assertThrows(IllegalArgumentException.class, () -> programService.getCoursesByProgram(null));
            verifyNoInteractions(programRepository);
        }
    }

    @Nested
    class deleteProgramUnitaire {
        @Test
        @DisplayName("Supprime, purge les cours orphelins, journalise et émet programDeleted + catalogue")
        void deleteProgram_purge_les_orphelins_et_emet() {
            Establishment udes = establishment(1, "UdeS");
            Program p = programIn(10, udes);
            p.setCourses(List.of(Course.builder().id(20).build(), Course.builder().id(21).build()));
            when(programRepository.findById(10)).thenReturn(Optional.of(p));
            when(userRepository.findDistinctByPrograms_Id(10)).thenReturn(List.of(User.builder().id(100).build()));
            when(programRepository.findByEstablishment_Id(1)).thenReturn(List.of());

            programService.deleteProgram(10);

            org.mockito.InOrder order = inOrder(programRepository, courseRepository);
            order.verify(programRepository).delete(p);
            order.verify(programRepository).flush();
            order.verify(courseRepository).deleteOrphanedAmong(List.of(20, 21));
            verify(auditLogService).record("PROGRAM_DELETE", "PROGRAM", 10,
                    "Programme « P10 » (#10) supprimé", "Établissement : UdeS");
            verify(realtimePublisher).programDeleted(100L, 10);
            verify(realtimePublisher).establishmentUpdated(1L, List.of());
        }

        @Test
        @DisplayName("Sans cours (courses null) : aucune purge d'orphelins")
        void deleteProgram_sans_cours() {
            Program p = programIn(10, establishment(1, "UdeS"));
            when(programRepository.findById(10)).thenReturn(Optional.of(p));

            programService.deleteProgram(10);

            verify(programRepository).delete(p);
            verify(courseRepository, never()).deleteOrphanedAmong(any());
        }

        // Bogue : sans établissement, les détails d'audit valent la chaîne « Établissement : null »
        // (concaténation d'un null) au lieu d'être null, comme le fait updateProgram pour le même cas.
        @Test
        @DisplayName("Sans établissement : détails d'audit null (pas « Établissement : null »)")
        void deleteProgram_sans_etablissement_details_null() {
            Program p = programIn(10, null);
            when(programRepository.findById(10)).thenReturn(Optional.of(p));

            programService.deleteProgram(10);

            verify(auditLogService).record(eq("PROGRAM_DELETE"), eq("PROGRAM"), eq(10), any(), isNull());
        }
    }
}

