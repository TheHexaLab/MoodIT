package com.moodit.core_service.controller;

import tools.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.service.CourseService;
import com.moodit.core_service.service.ForumService;
import com.moodit.core_service.service.QuizService;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(controllers = CourseController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class CourseControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private CourseService courseService;

    @MockitoBean
    private ForumService forumService; // Présent dans le constructeur du contrôleur

    @MockitoBean
    private QuizService quizService; // Dépendance ajoutée au contrôleur par le merge Quiz

    @Autowired
    private ObjectMapper objectMapper;

    private CourseDTO courseDTO;
    private ForumDTO forumDTO;

    @BeforeEach
    void init() {
        courseDTO = CourseDTO.builder()
                .id(1)
                .title("Mathématiques")
                .code("MATH101")
                .build();

        forumDTO = ForumDTO.builder()
                .id(10)
                .title("Entraide Algèbre")
                .courseId(1)
                .build();
    }

    // ===================== GET =====================

    @Nested
    @DisplayName("GET /api/courses/{courseId}")
    class FindCourse {

        @Test
        @DisplayName("Valide → retourne 200 avec le cours demandé")
        void devrait_retourner_200_avec_cours() throws Exception {
            when(courseService.findById(1)).thenReturn(courseDTO);

            mockMvc.perform(get("/api/courses/1"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.title").value("Mathématiques"));
        }

        @Test
        @DisplayName("Erroné → cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_inexistant() throws Exception {
            when(courseService.findById(99)).thenThrow(new CourseNotFoundException());

            mockMvc.perform(get("/api/courses/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Pertinent : Erreur d'argument → ID au mauvais format (String) retourne 400")
        void devrait_retourner_400_si_id_est_une_chaine_de_caracteres() throws Exception {
            mockMvc.perform(get("/api/courses/invalide"))
                    .andExpect(status().isBadRequest());
            verifyNoInteractions(courseService);
        }
    }

    @Nested
    @DisplayName("GET /api/courses/{courseId}/forums")
    class GetForumsByCourse {

        @Test
        @DisplayName("Valide → retourne 200 avec la liste des forums du cours")
        void devrait_retourner_200_avec_liste_forums() throws Exception {
            when(courseService.getForumsByCourseAndType(1, null)).thenReturn(List.of(forumDTO));

            mockMvc.perform(get("/api/courses/1/forums"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].title").value("Entraide Algèbre"));
        }

        @Test
        @DisplayName("Cas limite → cours sans forum retourne liste vide")
        void devrait_retourner_200_avec_liste_vide() throws Exception {
            when(courseService.getForumsByCourseAndType(1, null)).thenReturn(List.of());

            mockMvc.perform(get("/api/courses/1/forums"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(0));
        }

        @Test
        @DisplayName("Erroné → cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_inexistant() throws Exception {
            when(courseService.getForumsByCourseAndType(99, null)).thenThrow(new CourseNotFoundException());

            mockMvc.perform(get("/api/courses/99/forums"))
                    .andExpect(status().isNotFound());
        }
    }

    @Nested
    @DisplayName("GET /api/courses/{courseId}/forums/{forumId}")
    class GetForumByCourseAndId {

        @Test
        @DisplayName("Valide → retourne 200 avec le forum spécifique")
        void devrait_retourner_200_avec_forum_specifique() throws Exception {
            when(courseService.getForumByIdInCourse(1, 10)).thenReturn(forumDTO);

            mockMvc.perform(get("/api/courses/1/forums/10"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(10))
                    .andExpect(jsonPath("$.title").value("Entraide Algèbre"));
        }

        @Test
        @DisplayName("Erroné → forum inexistant dans ce cours retourne 404")
        void devrait_retourner_404_si_forum_ou_cours_inexistant() throws Exception {
            when(courseService.getForumByIdInCourse(1, 99)).thenThrow(new ForumNotFoundException());

            mockMvc.perform(get("/api/courses/1/forums/99"))
                    .andExpect(status().isNotFound());
        }
    }

    // ===================== POST =====================

    @Nested
    @DisplayName("POST /api/courses/forums")
    class AddForumToCourse {

        @Test
        @DisplayName("Valide → ajoute le forum et retourne 200 OK")
        void devrait_ajouter_forum_et_retourner_200() throws Exception {
            ForumDTO inputDto = ForumDTO.builder()
                    .title("Entraide Algèbre")
                    .courseId(1)
                    .build();

            when(courseService.addForumToCourse(any(ForumDTO.class))).thenReturn(forumDTO);

            mockMvc.perform(post("/api/courses/forums")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(inputDto)))
                    .andExpect(status().isOk()) // Ton contrôleur utilise ResponseEntity.ok() ici
                    .andExpect(jsonPath("$.id").value(10))
                    .andExpect(jsonPath("$.title").value("Entraide Algèbre"));
        }

        @Test
        @DisplayName("Erroné → rattachement à un cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_parent_inexistant() throws Exception {
            ForumDTO inputDto = ForumDTO.builder().title("Invalide").courseId(99).build();

            when(courseService.addForumToCourse(any(ForumDTO.class))).thenThrow(new CourseNotFoundException());

            mockMvc.perform(post("/api/courses/forums")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(inputDto)))
                    .andExpect(status().isNotFound());
        }
    }

    // ===================== PATCH =====================

    @Nested
    @DisplayName("PATCH /api/courses/{courseId}")
    class UpdateCourse {

        @Test
        @DisplayName("Valide → modifie le cours et retourne 200 OK")
        void devrait_modifier_et_retourner_le_cours() throws Exception {
            CourseUpdateDTO dto = CourseUpdateDTO.builder()
                    .title("Nouveau Titre Math")
                    .build();

            courseDTO.setTitle("Nouveau Titre Math");
            when(courseService.updateCourse(eq(1), any(CourseUpdateDTO.class))).thenReturn(courseDTO);

            mockMvc.perform(patch("/api/courses/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Nouveau Titre Math"));
        }

        @Test
        @DisplayName("Erroné → cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_inexistant() throws Exception {
            CourseUpdateDTO dto = CourseUpdateDTO.builder().title("Nouveau Titre").build();

            when(courseService.updateCourse(eq(99), any(CourseUpdateDTO.class))).thenThrow(new CourseNotFoundException());

            mockMvc.perform(patch("/api/courses/99")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Cas limite → corps de requête vide `{}` retourne 200 sans altération")
        void devrait_retourner_200_sans_modification_si_body_vide() throws Exception {
            when(courseService.updateCourse(eq(1), any(CourseUpdateDTO.class))).thenReturn(courseDTO);

            mockMvc.perform(patch("/api/courses/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Mathématiques"));
        }
    }

    // ===================== DELETE =====================

    @Nested
    @DisplayName("DELETE /api/courses/{courseId}")
    class DeleteCourse {

        @Test
        @DisplayName("Valide → supprime le cours et retourne 204 No Content")
        void devrait_supprimer_le_cours_et_retourner_204() throws Exception {
            doNothing().when(courseService).deleteCourse(1);

            mockMvc.perform(delete("/api/courses/1"))
                    .andExpect(status().isNoContent()); // Validation du code 204

            verify(courseService, times(1)).deleteCourse(1);
        }

        @Test
        @DisplayName("Erroné → tentative de suppression d'un cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_a_supprimer_inexistant() throws Exception {
            doThrow(new CourseNotFoundException()).when(courseService).deleteCourse(99);

            mockMvc.perform(delete("/api/courses/99"))
                    .andExpect(status().isNotFound());
        }
    }
}