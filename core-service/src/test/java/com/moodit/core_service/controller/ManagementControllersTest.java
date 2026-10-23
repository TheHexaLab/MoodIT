package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseForumsDTO;
import com.moodit.core_service.dto.CourseUpdateDTO;
import com.moodit.core_service.dto.EnrollmentDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.QuizDTO;
import com.moodit.core_service.dto.QuizDetailDTO;
import com.moodit.core_service.dto.UserCreateInCoursesDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.EstablishmentNotFoundException;
import com.moodit.core_service.exception.ProgramNotFoundException;
import com.moodit.core_service.realtime.dto.ItemChangeDto;
import com.moodit.core_service.realtime.dto.ItemDto;
import com.moodit.core_service.service.CourseService;
import com.moodit.core_service.service.EstablishmentService;
import com.moodit.core_service.service.ForumService;
import com.moodit.core_service.service.ProgramService;
import com.moodit.core_service.service.QuizService;
import com.moodit.core_service.service.UserService;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Complète CourseControllerTest / ProgramControllerTest / EstablishmentControllerTest /
 * UserControllerTest sur les routes qu'ils ne couvrent pas : inscriptions, sections, quiz d'un
 * cours (vue étudiant vs éditeur), suppression, candidats aux rôles, programmes gérables.
 * Services mockés, sécurité exclue (autorisation déléguée au permission-service).
 */
@WebMvcTest(controllers = {CourseController.class, ProgramController.class,
        EstablishmentController.class, UserController.class},
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class ManagementControllersTest {

    @Autowired private MockMvc mockMvc;

    @MockitoBean private CourseService courseService;
    @MockitoBean private ForumService forumService;
    @MockitoBean private QuizService quizService;
    @MockitoBean private ProgramService programService;
    @MockitoBean private EstablishmentService establishmentService;
    @MockitoBean private UserService userService;

    // ── CourseController ────────────────────────────────────────────────────────

    @Nested
    @DisplayName("/api/courses")
    class Courses {

        @Test
        @DisplayName("POST /courses/users → synchronise les cours de l'utilisateur")
        void synchroniserCoursUtilisateur() throws Exception {
            when(courseService.syncUserCourses(any(UserCreateInCoursesDTO.class)))
                    .thenReturn(List.of(CourseDTO.builder().id(3).code("IFT3").build()));

            mockMvc.perform(post("/api/courses/users").contentType(MediaType.APPLICATION_JSON)
                            .content("{\"id\":5,\"courseIds\":[3],\"programId\":7}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].code").value("IFT3"));

            verify(courseService).syncUserCourses(argThat(dto -> dto.getId() == 5
                    && dto.getCourseIds().equals(List.of(3)) && dto.getProgramId() == 7));
        }

        @Test
        @DisplayName("PATCH /courses/{id} → cours mis à jour")
        void modifierCours() throws Exception {
            when(courseService.updateCourse(eq(3), any(CourseUpdateDTO.class)))
                    .thenReturn(CourseDTO.builder().id(3).title("Algo II").build());

            mockMvc.perform(patch("/api/courses/3").contentType(MediaType.APPLICATION_JSON)
                            .content("{\"title\":\"Algo II\",\"programIds\":[7,8]}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Algo II"));

            verify(courseService).updateCourse(eq(3),
                    argThat(dto -> "Algo II".equals(dto.getTitle()) && dto.getProgramIds().equals(List.of(7, 8))));
        }

        @Test
        @DisplayName("PATCH /courses/{id}/sections → changement appliqué renvoyé (id réel)")
        void changerSection() throws Exception {
            when(courseService.changeSection(eq(3), eq("text"), any(ItemChangeDto.class)))
                    .thenReturn(ItemChangeDto.create(new ItemDto("15", "général")));

            mockMvc.perform(patch("/api/courses/3/sections").contentType(MediaType.APPLICATION_JSON)
                            .content("{\"sectionType\":\"text\",\"change\":{\"type\":\"create\","
                                    + "\"item\":{\"id\":\"tmp-1\",\"name\":\"général\"}}}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.type").value("create"))
                    .andExpect(jsonPath("$.item.id").value("15"));

            verify(courseService).changeSection(eq(3), eq("text"),
                    argThat(c -> "create".equals(c.type()) && "tmp-1".equals(c.item().id())));
        }

        @Test
        @DisplayName("DELETE /courses/{id} → 204")
        void supprimerCours() throws Exception {
            mockMvc.perform(delete("/api/courses/3"))
                    .andExpect(status().isNoContent());

            verify(courseService).deleteCourse(3);
        }

        @Test
        @DisplayName("DELETE d'un cours inexistant → 404")
        void supprimerCours_inexistant_404() throws Exception {
            doThrow(new CourseNotFoundException()).when(courseService).deleteCourse(99);

            mockMvc.perform(delete("/api/courses/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("DELETE /courses/{id}/users/{userId} → 204, désinscription")
        void desinscrire() throws Exception {
            mockMvc.perform(delete("/api/courses/3/users/5"))
                    .andExpect(status().isNoContent());

            verify(courseService).removeUserFromCourse(3, 5);
        }

        @Test
        @DisplayName("GET /courses/{id}/quizzes → vue étudiant : publiés seulement")
        void quizPublies() throws Exception {
            when(quizService.listQuizzes(3, true)).thenReturn(List.of(QuizDTO.builder().id(4).title("Q").build()));

            mockMvc.perform(get("/api/courses/3/quizzes"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].id").value(4));

            verify(quizService).listQuizzes(3, true);
        }

        @Test
        @DisplayName("GET /courses/{id}/quizzes/manage → vue éditeur : brouillons inclus")
        void quizGeres() throws Exception {
            when(quizService.listQuizzes(3, false)).thenReturn(List.of(
                    QuizDTO.builder().id(4).isPublished(true).build(),
                    QuizDTO.builder().id(5).isPublished(false).build()));

            mockMvc.perform(get("/api/courses/3/quizzes/manage"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(2))
                    .andExpect(jsonPath("$[1].isPublished").value(false));

            verify(quizService).listQuizzes(3, false);
        }

        @Test
        @DisplayName("POST /courses/{id}/quizzes → quiz créé renvoyé")
        void creerQuiz() throws Exception {
            when(quizService.createQuiz(eq(3), any(QuizDetailDTO.class)))
                    .thenReturn(QuizDetailDTO.builder().id(77).title("Nouveau").questions(List.of()).build());

            mockMvc.perform(post("/api/courses/3/quizzes").contentType(MediaType.APPLICATION_JSON)
                            .content("{\"title\":\"Nouveau\",\"questions\":[]}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(77));

            verify(quizService).createQuiz(eq(3), argThat(dto -> "Nouveau".equals(dto.getTitle())));
        }

        @Test
        @DisplayName("PATCH /courses/{id}/quizzes/reorder → 204, ordre transmis")
        void reordonnerQuiz() throws Exception {
            mockMvc.perform(patch("/api/courses/3/quizzes/reorder").contentType(MediaType.APPLICATION_JSON)
                            .content("[5,4,6]"))
                    .andExpect(status().isNoContent());

            verify(quizService).reorderQuizzes(3, List.of(5, 4, 6));
        }
    }

    // ── ProgramController ───────────────────────────────────────────────────────

    @Nested
    @DisplayName("/api/programs")
    class Programs {

        @Test
        @DisplayName("GET /programs/{id}/users → membres du programme")
        void membres() throws Exception {
            when(programService.getUsersByProgram(7)).thenReturn(List.of(UserDTO.builder().id(5).username("rosie").build()));

            mockMvc.perform(get("/api/programs/7/users"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].username").value("rosie"));
        }

        @Test
        @DisplayName("GET /programs/{id}/role-candidates → pagination par défaut 0/10")
        void candidatsRole_defauts() throws Exception {
            when(programService.getProgramRoleCandidates(7, 2, null, 0, 10)).thenReturn(List.of());

            mockMvc.perform(get("/api/programs/7/role-candidates").param("roleId", "2"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$").isEmpty());

            verify(programService).getProgramRoleCandidates(7, 2, null, 0, 10);
        }

        @Test
        @DisplayName("GET /programs/{id}/role-candidates avec recherche/pagination → transmis")
        void candidatsRole_parametres() throws Exception {
            when(programService.getProgramRoleCandidates(7, 2, "ro", 1, 5))
                    .thenReturn(List.of(UserDTO.builder().id(9).build()));

            mockMvc.perform(get("/api/programs/7/role-candidates")
                            .param("roleId", "2").param("search", "ro").param("page", "1").param("size", "5"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].id").value(9));
        }

        @Test
        @DisplayName("DELETE /programs/{id}/users/{userId} → 204, l'utilisateur quitte le programme")
        void quitterProgramme() throws Exception {
            mockMvc.perform(delete("/api/programs/7/users/5"))
                    .andExpect(status().isNoContent());

            verify(programService).removeUserFromProgram(7, 5);
        }

        @Test
        @DisplayName("DELETE /programs/{id} → 204")
        void supprimerProgramme() throws Exception {
            mockMvc.perform(delete("/api/programs/7"))
                    .andExpect(status().isNoContent());

            verify(programService).deleteProgram(7);
        }

        @Test
        @DisplayName("DELETE d'un programme inexistant → 404")
        void supprimerProgramme_inexistant_404() throws Exception {
            doThrow(new ProgramNotFoundException()).when(programService).deleteProgram(99);

            mockMvc.perform(delete("/api/programs/99"))
                    .andExpect(status().isNotFound());
        }
    }

    // ── EstablishmentController ─────────────────────────────────────────────────

    @Nested
    @DisplayName("/api/establishments")
    class Establishments {

        @Test
        @DisplayName("GET /establishments/{id}/manageable-programs → programmes gérables par l'utilisateur")
        void programmesGerables() throws Exception {
            when(programService.getManageableProgramsInEstablishment(2, "rosie@test.ca"))
                    .thenReturn(List.of(ProgramDTO.builder().id(7).name("Génie info").build()));

            mockMvc.perform(get("/api/establishments/2/manageable-programs").header("X-User-Email", "rosie@test.ca"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].name").value("Génie info"));
        }

        @Test
        @DisplayName("GET /establishments/{id}/manageable-programs sans header X-User-Email → 400")
        void programmesGerables_sansEmail_400() throws Exception {
            mockMvc.perform(get("/api/establishments/2/manageable-programs"))
                    .andExpect(status().isBadRequest());

            verifyNoInteractions(programService);
        }

        @Test
        @DisplayName("DELETE /establishments/{id} → 204")
        void supprimerEtablissement() throws Exception {
            mockMvc.perform(delete("/api/establishments/2"))
                    .andExpect(status().isNoContent());

            verify(establishmentService).deleteEstablishment(2);
        }

        @Test
        @DisplayName("DELETE d'un établissement inexistant → 404")
        void supprimerEtablissement_inexistant_404() throws Exception {
            doThrow(new EstablishmentNotFoundException()).when(establishmentService).deleteEstablishment(99);

            mockMvc.perform(delete("/api/establishments/99"))
                    .andExpect(status().isNotFound());
        }
    }

    // ── UserController ──────────────────────────────────────────────────────────

    @Nested
    @DisplayName("/api/users")
    class Users {

        @Test
        @DisplayName("GET /users/{id}/enrollments → cours où l'utilisateur est inscrit")
        void inscriptions() throws Exception {
            EnrollmentDTO e = new EnrollmentDTO();
            e.setCourseId(3);
            when(userService.getEnrollmentsByUser(5)).thenReturn(List.of(e));

            mockMvc.perform(get("/api/users/5/enrollments"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].courseId").value(3));
        }

        @Test
        @DisplayName("GET /users/{id}/programs/{programId}/enrollments → cours avec forums et quiz")
        void inscriptionsParProgramme() throws Exception {
            when(userService.getEnrollmentsByUserAndProgram(5, 7)).thenReturn(List.of(
                    CourseForumsDTO.builder().id(3).code("IFT3").forums(List.of()).quizzes(List.of()).build()));

            mockMvc.perform(get("/api/users/5/programs/7/enrollments"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].code").value("IFT3"))
                    .andExpect(jsonPath("$[0].forums").isArray());
        }
    }

    @Test
    @DisplayName("Paramètre requis manquant (roleId) → 400 sans appel au service")
    void parametreRequisManquant_400() throws Exception {
        mockMvc.perform(get("/api/programs/7/role-candidates"))
                .andExpect(status().isBadRequest());

        verify(programService, org.mockito.Mockito.never())
                .getProgramRoleCandidates(any(), any(), isNull(), org.mockito.ArgumentMatchers.anyInt(),
                        org.mockito.ArgumentMatchers.anyInt());
    }
}
