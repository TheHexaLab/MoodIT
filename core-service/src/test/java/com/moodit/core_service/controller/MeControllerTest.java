package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.moodit.core_service.dto.MeDto;
import com.moodit.core_service.dto.Role;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.repository.MeRepository;
import java.security.Principal;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * Contrat HTTP de {@link MeController} (MockMvc standalone : le contrôleur dépend de l'ObjectMapper
 * Jackson 2 de la couche temps réel, absent d'un slice @WebMvcTest). L'identité vient du principal
 * (posé en amont par GatewayAuthFilter), jamais d'un paramètre client.
 */
@ExtendWith(MockitoExtension.class)
class MeControllerTest {

    private static final String EMAIL = "rosie@test.ca";
    private static final Principal PRINCIPAL = () -> EMAIL;

    @Mock private MeRepository users;
    @Mock private RealtimeEventPublisher realtimePublisher;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        MeController controller = new MeController(users, realtimePublisher, new ObjectMapper());
        mockMvc = MockMvcBuilders.standaloneSetup(controller).build();
    }

    private static MeDto rosie(String firstName, String settings) {
        return new MeDto(12L, "rosie", firstName, "Tremblay", EMAIL, "#0a5cc0",
                List.of(new Role(1, "Administrateur")), settings);
    }

    // ── GET /me ─────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("GET /me → 200 avec le profil de l'utilisateur du principal")
    void me_renvoieLeProfil() throws Exception {
        when(users.findByEmail(EMAIL)).thenReturn(Optional.of(rosie("Rosie", null)));

        mockMvc.perform(get("/me").principal(PRINCIPAL))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(12))
                .andExpect(jsonPath("$.username").value("rosie"))
                .andExpect(jsonPath("$.email").value(EMAIL))
                .andExpect(jsonPath("$.roles[0].name").value("Administrateur"));
    }

    @Test
    @DisplayName("GET /me : token valide mais compte supprimé → 404")
    void me_compteInexistant_404() throws Exception {
        when(users.findByEmail(EMAIL)).thenReturn(Optional.empty());

        mockMvc.perform(get("/me").principal(PRINCIPAL))
                .andExpect(status().isNotFound());
    }

    // ── PATCH /me ───────────────────────────────────────────────────────────────

    @Test
    @DisplayName("PATCH /me valide → 200, profil à jour et diffusion globale user:updated")
    void updateMe_metAJourEtDiffuse() throws Exception {
        when(users.updateByEmail(EMAIL, "Rosalie", "Tremblay", "#0a5cc0"))
                .thenReturn(Optional.of(rosie("Rosalie", null)));

        mockMvc.perform(patch("/me").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Rosalie\",\"lastName\":\"Tremblay\",\"avatarColor\":\"#0a5cc0\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.firstName").value("Rosalie"));

        ArgumentCaptor<Author> author = ArgumentCaptor.forClass(Author.class);
        verify(realtimePublisher).userUpdated(author.capture());
        org.assertj.core.api.Assertions.assertThat(author.getValue())
                .isEqualTo(new Author(12L, "rosie", "Rosalie", "Tremblay", "#0a5cc0"));
    }

    @Test
    @DisplayName("PATCH /me avec une couleur invalide → 400, rien n'est modifié")
    void updateMe_couleurInvalide_400() throws Exception {
        mockMvc.perform(patch("/me").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Rosie\",\"lastName\":\"Tremblay\",\"avatarColor\":\"rouge\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(users, realtimePublisher);
    }

    @Test
    @DisplayName("PATCH /me avec un prénom vide → 400")
    void updateMe_prenomVide_400() throws Exception {
        mockMvc.perform(patch("/me").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\" \",\"lastName\":\"Tremblay\",\"avatarColor\":\"#0a5cc0\"}"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PATCH /me sur un compte inexistant → 404, aucune diffusion")
    void updateMe_compteInexistant_404() throws Exception {
        when(users.updateByEmail(anyString(), anyString(), anyString(), anyString())).thenReturn(Optional.empty());

        mockMvc.perform(patch("/me").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"firstName\":\"Rosie\",\"lastName\":\"Tremblay\",\"avatarColor\":\"#0A5CC0FF\"}"))
                .andExpect(status().isNotFound());

        verify(realtimePublisher, never()).userUpdated(any());
    }

    // ── PUT /me/settings ────────────────────────────────────────────────────────

    @Test
    @DisplayName("PUT /me/settings → JSON normalisé (compact) persisté, 200, aucune diffusion")
    void updateSettings_normaliseEtPersiste() throws Exception {
        when(users.updateSettingsByEmail(EMAIL, "{\"theme\":\"dark\",\"location\":{\"page\":\"quiz\"}}"))
                .thenReturn(Optional.of(rosie("Rosie", "{\"theme\":\"dark\"}")));

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{ \"theme\" : \"dark\",\n  \"location\": { \"page\": \"quiz\" } }"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.settings").value("{\"theme\":\"dark\"}"));

        verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("PUT /me/settings sans corps ou avec un corps blanc → 400")
    void updateSettings_corpsAbsentOuBlanc_400() throws Exception {
        mockMvc.perform(put("/me/settings").principal(PRINCIPAL).contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest());
        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON).content("   "))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PUT /me/settings avec un JSON mal formé → 400")
    void updateSettings_jsonInvalide_400() throws Exception {
        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"theme\": "))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PUT /me/settings au-delà de 8 Ko → 413")
    void updateSettings_tropVolumineux_413() throws Exception {
        String big = "{\"blob\":\"" + "x".repeat(8 * 1024) + "\"}";

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON).content(big))
                .andExpect(status().is(413));

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PUT /me/settings d'exactement 8 Ko → accepté (borne incluse)")
    void updateSettings_exactement8Ko_accepte() throws Exception {
        String atLimit = "{\"b\":\"" + "x".repeat(8 * 1024 - 8) + "\"}";
        when(users.updateSettingsByEmail(EMAIL, atLimit)).thenReturn(Optional.of(rosie("Rosie", atLimit)));

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType("application/json;charset=UTF-8").content(atLimit))
                .andExpect(status().isOk());

        verify(users).updateSettingsByEmail(EMAIL, atLimit);
    }

    @Test
    @DisplayName("PUT /me/settings : 8 Ko + 1 octet → 413")
    void updateSettings_unOctetDeTrop_413() throws Exception {
        String overLimit = "{\"b\":\"" + "x".repeat(8 * 1024 - 7) + "\"}";

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType("application/json;charset=UTF-8").content(overLimit))
                .andExpect(status().is(413));

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PUT /me/settings : la limite compte les OCTETS UTF-8, pas les caractères")
    void updateSettings_limiteEnOctets_413() throws Exception {
        // ~4 100 caractères mais 8 194 octets (« é » = 2 octets en UTF-8).
        String accents = "{\"b\":\"" + "é".repeat(4093) + "\"}";

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType("application/json;charset=UTF-8").content(accents))
                .andExpect(status().is(413));

        verifyNoInteractions(users);
    }

    @Test
    @DisplayName("PUT /me/settings sur un compte inexistant → 404")
    void updateSettings_compteInexistant_404() throws Exception {
        when(users.updateSettingsByEmail(EMAIL, "{}")).thenReturn(Optional.empty());

        mockMvc.perform(put("/me/settings").principal(PRINCIPAL)
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isNotFound());
    }
}
