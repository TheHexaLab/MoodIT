package com.moodit.core_service.controller;

import tools.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.EstablishmentNotFoundException;
import com.moodit.core_service.service.EstablishmentService;
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

@WebMvcTest(controllers = EstablishmentController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class EstablishmentControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private EstablishmentService establishmentService;

    @Autowired
    private ObjectMapper objectMapper;

    private EstablishmentDTO establishmentDTO;
    private ProgramDTO programDTO;

    @BeforeEach
    void init() {
        establishmentDTO = EstablishmentDTO.builder()
                .id(1)
                .name("Cégep de Sherbrooke")
                .domainEmail("cegepsherbrooke.qc.ca")
                .build();

        programDTO = ProgramDTO.builder()
                .id(1)
                .name("Informatique")
                .code("420")
                .build();
    }

    @Nested
    @DisplayName("GET /api/establishments")
    class FindAll {

        @Test
        @DisplayName("Valide → retourne 200 avec liste d'établissements")
        void devrait_retourner_200_avec_liste() throws Exception {
            when(establishmentService.findAll()).thenReturn(List.of(establishmentDTO));

            mockMvc.perform(get("/api/establishments"))
                    .andExpect(status().isOk())
                    .andExpect(content().contentType(MediaType.APPLICATION_JSON))
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].name").value("Cégep de Sherbrooke"));
        }

        @Test
        @DisplayName("Cas limite → retourne 200 avec liste vide")
        void devrait_retourner_200_avec_liste_vide() throws Exception {
            when(establishmentService.findAll()).thenReturn(List.of());

            mockMvc.perform(get("/api/establishments"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(0));
        }
    }

    @Nested
    @DisplayName("GET /api/establishments/{establishmentId}/programs")
    class GetProgramsByEstablishment {

        @Test
        @DisplayName("Valide → retourne 200 avec les programmes de l'établissement")
        void devrait_retourner_200_avec_programmes() throws Exception {
            when(establishmentService.getProgramsByEstablishment(1)).thenReturn(List.of(programDTO));

            mockMvc.perform(get("/api/establishments/1/programs"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(1))
                    .andExpect(jsonPath("$[0].name").value("Informatique"));
        }

        @Test
        @DisplayName("Erroné → établissement inexistant retourne 404")
        void devrait_retourner_404_si_etablissement_inexistant() throws Exception {
            when(establishmentService.getProgramsByEstablishment(99))
                    .thenThrow(new EstablishmentNotFoundException()); // Assure-toi que cette exception existe

            mockMvc.perform(get("/api/establishments/99/programs"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Pertinent : Erreur d'argument → ID au mauvais format (String) retourne 400")
        void devrait_retourner_400_si_id_est_une_chaine_de_caracteres() throws Exception {
            mockMvc.perform(get("/api/establishments/invalide/programs"))
                    .andExpect(status().isBadRequest());
            verifyNoInteractions(establishmentService);
        }
    }

    // ===================== POST =====================

    @Nested
    @DisplayName("POST /api/establishments")
    class CreateEstablishment {

        @Test
        @DisplayName("Valide → crée l'établissement et retourne 201 Created")
        void devrait_creer_etablissement_et_retourner_201() throws Exception {
            EstablishmentDTO inputDto = EstablishmentDTO.builder()
                    .name("Cégep de Sherbrooke")
                    .domainEmail("cegepsherbrooke.qc.ca")
                    .build();

            when(establishmentService.create(any(EstablishmentDTO.class))).thenReturn(establishmentDTO);

            mockMvc.perform(post("/api/establishments")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(inputDto)))
                    .andExpect(status().isCreated()) // Validation du statut 201
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.name").value("Cégep de Sherbrooke"));
        }
    }

    @Nested
    @DisplayName("POST /api/establishments/programs")
    class AddProgramToEstablishment {

        @Test
        @DisplayName("Valide → associe le programme et retourne 201 Created")
        void devrait_ajouter_programme_a_etablissement_et_retourner_21() throws Exception {
            ProgramCreateInEstablishmentDTO dto = ProgramCreateInEstablishmentDTO.builder()
                    .establishmentId(1)
                    .name("Informatique")
                    .code("420")
                    .build();

            when(establishmentService.addProgramToEstablishment(any(ProgramCreateInEstablishmentDTO.class)))
                    .thenReturn(programDTO);

            mockMvc.perform(post("/api/establishments/programs")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isCreated()) // Validation du statut 201
                    .andExpect(jsonPath("$.id").value(1))
                    .andExpect(jsonPath("$.name").value("Informatique"));
        }

        @Test
        @DisplayName("Erroné → établissement parent inexistant retourne 404")
        void devrait_retourner_404_si_etablissement_parent_inexistant() throws Exception {
            ProgramCreateInEstablishmentDTO dto = ProgramCreateInEstablishmentDTO.builder()
                    .establishmentId(99)
                    .name("Informatique")
                    .build();

            when(establishmentService.addProgramToEstablishment(any(ProgramCreateInEstablishmentDTO.class)))
                    .thenThrow(new EstablishmentNotFoundException());

            mockMvc.perform(post("/api/establishments/programs")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }
    }

    // ===================== PATCH =====================

    @Nested
    @DisplayName("PATCH /api/establishments/{establishmentId}")
    class UpdateEstablishment {

        @Test
        @DisplayName("Valide → modifie l'établissement et retourne 200 OK")
        void devrait_modifier_et_retourner_etablissement() throws Exception {
            EstablishmentUpdateDTO dto = EstablishmentUpdateDTO.builder()
                    .name("Nouveau Nom Cégep")
                    .build();

            establishmentDTO.setName("Nouveau Nom Cégep");
            when(establishmentService.updateEstablishment(eq(1), any(EstablishmentUpdateDTO.class)))
                    .thenReturn(establishmentDTO);

            mockMvc.perform(patch("/api/establishments/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.name").value("Nouveau Nom Cégep"));
        }

        @Test
        @DisplayName("Erroné → établissement inexistant retourne 404")
        void devrait_retourner_404_si_etablissement_inexistant() throws Exception {
            EstablishmentUpdateDTO dto = EstablishmentUpdateDTO.builder()
                    .name("Nouveau Nom")
                    .build();

            when(establishmentService.updateEstablishment(eq(99), any(EstablishmentUpdateDTO.class)))
                    .thenThrow(new EstablishmentNotFoundException());

            mockMvc.perform(patch("/api/establishments/99")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(dto)))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("Cas limite → un corps de requête vide `{}` retourne 200 sans altération")
        void devrait_retourner_200_sans_modification_si_body_vide() throws Exception {
            when(establishmentService.updateEstablishment(eq(1), any(EstablishmentUpdateDTO.class)))
                    .thenReturn(establishmentDTO);

            mockMvc.perform(patch("/api/establishments/1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.name").value("Cégep de Sherbrooke")); // Nom d'origine intact
        }
    }
}