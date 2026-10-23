package com.moodit.core_service.controller;

import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.RoleDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.service.RoleService;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Contrat HTTP de {@link RoleController} (/api/roles) : liste filtrée par portée, attribution par
 * programme et globale (204), administrateurs actuels et candidats paginés (valeurs par défaut).
 */
@WebMvcTest(controllers = RoleController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class RoleControllerTest {

    private static final String CHANGE = "{\"type\":\"assign\",\"roleId\":2,\"userId\":5,\"programId\":7}";

    @Autowired private MockMvc mockMvc;

    @MockitoBean private RoleService roleService;

    @Test
    @DisplayName("GET /roles sans portée → scope null transmis")
    void listeSansPortee() throws Exception {
        when(roleService.findAll(isNull())).thenReturn(List.of(new RoleDTO(1, "Administrateur")));

        mockMvc.perform(get("/api/roles"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("Administrateur"));
    }

    @Test
    @DisplayName("GET /roles?scope=program → portée transmise")
    void listeParPortee() throws Exception {
        when(roleService.findAll("program")).thenReturn(List.of(new RoleDTO(3, "Enseignant")));

        mockMvc.perform(get("/api/roles").param("scope", "program"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(3));
    }

    @Test
    @DisplayName("POST /roles/change → 204, requête transmise au service")
    void changerRoleProgramme_204() throws Exception {
        mockMvc.perform(post("/api/roles/change").contentType(MediaType.APPLICATION_JSON).content(CHANGE))
                .andExpect(status().isNoContent());

        verify(roleService).changeRole(argThat(r -> "assign".equals(r.getType()) && r.getRoleId() == 2
                && r.getUserId() == 5 && r.getProgramId() == 7));
    }

    @Test
    @DisplayName("POST /roles/change pour un utilisateur inexistant → 404")
    void changerRole_utilisateurInexistant_404() throws Exception {
        org.mockito.Mockito.doThrow(new UserNotFoundException()).when(roleService)
                .changeRole(org.mockito.ArgumentMatchers.any());

        mockMvc.perform(post("/api/roles/change").contentType(MediaType.APPLICATION_JSON).content(CHANGE))
                .andExpect(status().isNotFound());
    }

    @Test
    @DisplayName("POST /roles/global/change → 204")
    void changerRoleGlobal_204() throws Exception {
        mockMvc.perform(post("/api/roles/global/change").contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"unassign\",\"roleId\":1,\"userId\":5}"))
                .andExpect(status().isNoContent());

        verify(roleService).changeGlobalRole(argThat(r -> "unassign".equals(r.getType()) && r.getProgramId() == null));
    }

    @Test
    @DisplayName("GET /roles/global/users → administrateurs actuels")
    void administrateurs() throws Exception {
        when(roleService.getUsersWithGlobalRoles()).thenReturn(List.of(
                UserDTO.builder().id(5).username("rosie").roles(List.of(1)).build()));

        mockMvc.perform(get("/api/roles/global/users"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].username").value("rosie"))
                .andExpect(jsonPath("$[0].roles[0]").value(1));
    }

    @Test
    @DisplayName("GET /roles/global/candidates → page 0 / taille 10 par défaut, recherche absente")
    void candidats_defauts() throws Exception {
        when(roleService.getGlobalRoleCandidates(1, null, 0, 10)).thenReturn(List.of());

        mockMvc.perform(get("/api/roles/global/candidates").param("roleId", "1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());

        verify(roleService).getGlobalRoleCandidates(1, null, 0, 10);
    }

    @Test
    @DisplayName("GET /roles/global/candidates avec recherche et pagination → transmis tels quels")
    void candidats_parametres() throws Exception {
        when(roleService.getGlobalRoleCandidates(1, "ros", 2, 5))
                .thenReturn(List.of(UserDTO.builder().id(9).build()));

        mockMvc.perform(get("/api/roles/global/candidates")
                        .param("roleId", "1").param("search", "ros").param("page", "2").param("size", "5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(9));
    }

    @Test
    @DisplayName("GET /roles/global/candidates sans roleId (requis) → 400")
    void candidats_sansRoleId_400() throws Exception {
        mockMvc.perform(get("/api/roles/global/candidates"))
                .andExpect(status().isBadRequest());

        verifyNoInteractions(roleService);
    }
}
