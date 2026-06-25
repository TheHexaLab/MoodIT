package com.moodit.core_service.controller;

import tools.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.service.UserService;
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

@WebMvcTest(controllers = UserController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class UserControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private UserService userService;

    @Autowired
    private ObjectMapper objectMapper;

    private UserDTO userDTO;
    private UserProgramsDTO userProgramsDTO;
    private ProgramDTO programDTO;

    @BeforeEach
    void init() {
        userDTO = UserDTO.builder()
                .id(1)
                .username("jdoe")
                .firstName("John")
                .lastName("Doe")
                .email("jdoe@moodit.com")
                .build();

        programDTO = ProgramDTO.builder()
                .id(10)
                .name("Informatique")
                .code("420")
                .build();

        userProgramsDTO = UserProgramsDTO.builder()
                .id(1)
                .username("jdoe")
                .firstName("John")
                .lastName("Doe")
                .email("jdoe@moodit.com")
                .programs(List.of(programDTO))
                .build();
    }

    // ===================== GET =====================

    @Nested
    @DisplayName("GET /api/users/{userId}")
    class FindById {

        @Test
        @DisplayName("Valide → retourne 200 avec l'usager et ses programmes")
        void devrait_retourner_200_avec_usager() throws Exception {
            when(userService.findById(1)).thenReturn(userProgramsDTO);

            mockMvc.perform(get("/api/users/1"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.username").value("jdoe"))
                    .andExpect(jsonPath("$.programs.length()").value(1));
        }

        @Test
        @DisplayName("Erroné → usager inexistant retourne 404")
        void devrait_retourner_404_si_usager_inexistant() throws Exception {
            when(userService.findById(99)).thenThrow(new UserNotFoundException());

            mockMvc.perform(get("/api/users/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Pertinent : Erreur d'argument → ID au mauvais format (String) retourne 400")
        void devrait_retourner_400_si_id_est_une_chaine_de_caracteres() throws Exception {
            mockMvc.perform(get("/api/users/abc"))
                    .andExpect(status().isBadRequest());
            verifyNoInteractions(userService);
        }
    }

    @Nested
    @DisplayName("GET /api/users/username/{username}")
    class FindByUsername {

        @Test
        @DisplayName("Valide → retourne 200 avec l'usager trouvé par son username")
        void devrait_retourner_200_avec_usager_par_username() throws Exception {
            when(userService.findByUsername("jdoe")).thenReturn(userProgramsDTO);

            mockMvc.perform(get("/api/users/username/jdoe"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.username").value("jdoe"));
        }

        @Test
        @DisplayName("Erroné → username inconnu retourne 404")
        void devrait_retourner_404_si_username_introuvable() throws Exception {
            when(userService.findByUsername("inconnu")).thenThrow(new UserNotFoundException());

            mockMvc.perform(get("/api/users/username/inconnu"))
                    .andExpect(status().isNotFound());
        }
    }

    @Nested
    @DisplayName("GET /api/users/role/{role}/programs/{programId}")
    class FindByRole {

        @Test
        @DisplayName("Valide → retourne 200 avec la liste des usagers filtrés par rôle et programme")
        void devrait_retourner_200_avec_liste_usagers() throws Exception {
            // Le contrôleur passe (programId, role) dans cet ordre au service : userService.findUsersByProgramAndRole(programId, role)
            when(userService.findUsersByProgramAndRole(10, 2)).thenReturn(List.of(userDTO));

            mockMvc.perform(get("/api/users/role/2/programs/10"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].username").value("jdoe"));
        }

        @Test
        @DisplayName("Cas limite → aucun usager ne correspond, retourne liste vide")
        void devrait_retourner_200_avec_liste_vide() throws Exception {
            when(userService.findUsersByProgramAndRole(10, 3)).thenReturn(List.of());

            mockMvc.perform(get("/api/users/role/3/programs/10"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(0));
        }
    }

    @Nested
    @DisplayName("GET /api/users/{userId}/programs")
    class GetProgramsByUser {

        @Test
        @DisplayName("Valide → retourne 200 avec les programmes de l'usager")
        void devrait_retourner_200_avec_les_programmes_de_l_usager() throws Exception {
            when(userService.findProgramsByUserId(1)).thenReturn(List.of(programDTO));

            mockMvc.perform(get("/api/users/1/programs"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].name").value("Informatique"));
        }

        @Test
        @DisplayName("Cas limite → usager inscrit à aucun programme, retourne liste vide")
        void devrait_retourner_200_avec_liste_programmes_vide() throws Exception {
            when(userService.findProgramsByUserId(1)).thenReturn(List.of());

            mockMvc.perform(get("/api/users/1/programs"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(0));
        }

        @Test
        @DisplayName("Erroné → usager inexistant retourne 404")
        void devrait_retourner_404_si_usager_inexistant() throws Exception {
            when(userService.findProgramsByUserId(99)).thenThrow(new UserNotFoundException());

            mockMvc.perform(get("/api/users/99/programs"))
                    .andExpect(status().isNotFound());
        }
    }

    // ===================== PATCH =====================

    @Nested
    @DisplayName("PATCH /api/users/{userId}")
    class UpdateUser {

        @Test
        @DisplayName("Valide → modifie l'usager et retourne 200 OK")
        void devrait_modifier_et_retourner_l_usager() throws Exception {
            UserUpdateDTO dto = UserUpdateDTO.builder()
                    .firstName("NouveauPrénom")
                    .build();

            userDTO.setFirstName("NouveauPrénom");
            when(userService.updateUser(eq(1), any(UserUpdateDTO.class))).thenReturn(userDTO);

            mockMvc.perform(patch("/api/users/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.firstName").value("NouveauPrénom"))
                    .andExpect(jsonPath("$.lastName").value("Doe")); // Inchangé
        }

        @Test
        @DisplayName("Erroné → usager inexistant retourne 404")
        void devrait_retourner_404_si_usager_inexistant() throws Exception {
            UserUpdateDTO dto = UserUpdateDTO.builder().firstName("Test").build();

            when(userService.updateUser(eq(99), any(UserUpdateDTO.class))).thenThrow(new UserNotFoundException());

            mockMvc.perform(patch("/api/users/99")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Cas limite → corps de requête vide `{}` retourne 200 sans altération")
        void devrait_retourner_200_sans_modification_si_body_vide() throws Exception {
            when(userService.updateUser(eq(1), any(UserUpdateDTO.class))).thenReturn(userDTO);

            mockMvc.perform(patch("/api/users/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.firstName").value("John")); // Nom d'origine intact
        }
    }
}