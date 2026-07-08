package com.moodit.core_service.controller;

import tools.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.*;
import com.moodit.core_service.service.ProgramService;
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

// @WebMvcTest charge SEULEMENT le controller — pas la BD, pas les services réels
@WebMvcTest(controllers = ProgramController.class,
            excludeAutoConfiguration = SecurityAutoConfiguration.class)
class ProgramControllerTest {

    // MockMvc simule des vraies requêtes HTTP sans démarrer un serveur
    @Autowired private MockMvc mockMvc;

    // Remplace le vrai ProgramService par un mock
    @MockitoBean private ProgramService programService;

    // Convertit les objets Java en JSON pour le body des requêtes
    @Autowired private ObjectMapper objectMapper;

    private ProgramDTO programDTO;
    private ProgramCoursesDTO programCoursesDTO;
    private CourseDTO courseDTO;

    @BeforeEach
    void init() {
        courseDTO = CourseDTO.builder()
                .id(1)
                .title("Programmation")
                .code("PROG101")
                .build();

        programDTO = ProgramDTO.builder()
                .id(1)
                .name("Informatique")
                .code("GI")
                .cohort("71")
                .color("#FF0000")
                .build();

        programCoursesDTO = ProgramCoursesDTO.builder()
                .id(1)
                .name("Informatique")
                .code("GI")
                .cohort("71")
                .color("#FF0000")
                .courses(List.of(courseDTO))
                .build();
    }

    @Nested
    @DisplayName("GET /programs")
    class FindAll {

        @Test
        @DisplayName("Valide → retourne 200 avec liste de programmes")
        void devrait_retourner_200_avec_liste() throws Exception {
            when(programService.findAll()).thenReturn(List.of(programDTO));

            mockMvc.perform(get("/api/programs"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].name").value("Informatique"));
        }

        @Test
        @DisplayName("Cas limite → retourne 200 avec liste vide")
        void devrait_retourner_200_avec_liste_vide() throws Exception {
            when(programService.findAll()).thenReturn(List.of());

            mockMvc.perform(get("/api/programs"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(0));
        }
    }

    @Nested
    @DisplayName("GET /programs/{programId}")
    class FindById {

        @Test
        @DisplayName("Valide → retourne 200 avec le programme")
        void devrait_retourner_200_avec_programme() throws Exception {
            when(programService.findById(1)).thenReturn(programDTO);

            mockMvc.perform(get("/api/programs/1"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.name").value("Informatique"));
        }

        @Test
        @DisplayName("Erroné → programme inexistant retourne 404")
        void devrait_retourner_404_si_programme_inexistant() throws Exception {
            when(programService.findById(99)).thenThrow(new ProgramNotFoundException());

            mockMvc.perform(get("/programs/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Pertinent : Erreur d'argument → ID au mauvais format (String) retourne 400 Bad Request")
        void devrait_retourner_400_si_id_est_une_chaine_de_caracteres() throws Exception {
            mockMvc.perform(get("/api/programs/abc"))
                    .andExpect(status().isBadRequest());
            verifyNoInteractions(programService);
        }
    }

    @Nested
    @DisplayName("GET /programs/{programId}/courses")
    class GetCoursesByProgram {

        @Test
        @DisplayName("Valide → retourne 200 avec les cours du programme")
        void devrait_retourner_200_avec_cours() throws Exception {
            when(programService.getCoursesByProgram(1)).thenReturn(programCoursesDTO);

            mockMvc.perform(get("/api/programs/1/courses"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.courses.length()").value(1))
                    .andExpect(jsonPath("$.courses[0].title").value("Programmation"));
        }

        @Test
        @DisplayName("Erroné → programme inexistant retourne 404")
        void devrait_retourner_404_si_programme_inexistant() throws Exception {
            when(programService.getCoursesByProgram(99)).thenThrow(new ProgramNotFoundException());

            mockMvc.perform(get("/api/programs/99/courses"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Cas limite → programme sans cours retourne liste vide")
        void devrait_retourner_200_avec_liste_cours_vide() throws Exception {
            ProgramCoursesDTO emptyCoursesDTO = ProgramCoursesDTO.builder()
                    .id(1).name("Info").courses(List.of()).build();

            when(programService.getCoursesByProgram(1)).thenReturn(emptyCoursesDTO);

            mockMvc.perform(get("/api/programs/1/courses"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.courses.length()").value(0));
        }
    }

    @Nested
    @DisplayName("GET /programs/{programId}/courses/{courseId}")
    class GetCourseByProgram {

        @Test
        @DisplayName("Valide → retourne 200 avec le cours")
        void devrait_retourner_200_avec_cours() throws Exception {
            when(programService.getCourseByProgram(1, 1)).thenReturn(courseDTO);

            mockMvc.perform(get("/api/programs/1/courses/1"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Programmation"));
        }

        @Test
        @DisplayName("Erroné → cours inexistant retourne 404")
        void devrait_retourner_404_si_cours_inexistant() throws Exception {
            when(programService.getCourseByProgram(1, 99)).thenThrow(new CourseNotFoundException());

            mockMvc.perform(get("/api/programs/1/courses/99"))
                    .andExpect(status().isNotFound());
        }
    }

    @Nested
    @DisplayName("POST /programs/courses")
    class AddCourseToPrograms {

        @Test
        @DisplayName("Valide → retourne 200 avec le cours créé")
        void devrait_retourner_200_avec_cours_cree() throws Exception {
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder()
                    .title("Programmation")
                    .code("PROG101")
                    .programIds(List.of(1))
                    .build();

            when(programService.addCourseToPrograms(any(), any())).thenReturn(courseDTO);

            mockMvc.perform(post("/api/programs/courses")
                            .header("X-User-Email", "admin@test")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Programmation"));
        }

        @Test
        @DisplayName("Erroné → programme inexistant retourne 404")
        void devrait_retourner_404_si_programme_inexistant() throws Exception {
            CourseCreateInProgramsDTO dto = CourseCreateInProgramsDTO.builder()
                    .title("Programmation").code("PROG101").programIds(List.of(99)).build();

            when(programService.addCourseToPrograms(any(), any())).thenThrow(new ProgramNotFoundException());

            mockMvc.perform(post("/api/programs/courses")
                            .header("X-User-Email", "admin@test")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }
    }

    @Nested
    @DisplayName("POST /programs/users")
    class AddUserToPrograms {

        @Test
        @DisplayName("Valide → retourne 201 Created")
        void devrait_retourner_201() throws Exception {
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder()
                    .id(1)
                    .programIds(List.of(1))
                    .build();

            mockMvc.perform(post("/api/programs/users")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isCreated());
        }

        @Test
        @DisplayName("Erroné → usager inexistant retourne 404")
        void devrait_retourner_404_si_usager_inexistant() throws Exception {
            UserCreateInProgramsDTO dto = UserCreateInProgramsDTO.builder()
                    .id(99).programIds(List.of(1)).build();

            doThrow(new UserNotFoundException()).when(programService).addUserToPrograms(any());

            mockMvc.perform(post("/api/programs/users")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }
    }

    @Nested
    @DisplayName("PATCH /programs/{programId}")
    class UpdateProgram {

        @Test
        @DisplayName("Valide → retourne 200 avec programme modifié")
        void devrait_retourner_200_avec_programme_modifie() throws Exception {
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder().name("Nouveau nom").build();
            programDTO.setName("Nouveau nom");

            when(programService.updateProgram(eq(1), any())).thenReturn(programDTO);

            mockMvc.perform(patch("/api/programs/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.name").value("Nouveau nom"));
        }

        @Test
        @DisplayName("Erroné → programme inexistant retourne 404")
        void presidential_devrait_retourner_404_si_programme_inexistant() throws Exception {
            ProgramUpdateDTO dto = ProgramUpdateDTO.builder().name("Nouveau nom").build();

            when(programService.updateProgram(eq(99), any())).thenThrow(new ProgramNotFoundException());

            mockMvc.perform(patch("/api/programs/99")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }
    }
}