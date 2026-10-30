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
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.dto.ForumUpdateDTO;
import com.moodit.core_service.dto.ForumUpdatePostDTO;
import com.moodit.core_service.dto.PostCreateInForumDTO;
import com.moodit.core_service.dto.PostDTO;
import com.moodit.core_service.dto.PostVoteUserDTO;
import com.moodit.core_service.dto.VoteCreateInPostDTO;
import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.exception.InvalidPostException;
import com.moodit.core_service.exception.PostNotFoundException;
import com.moodit.core_service.service.ForumService;
import java.util.List;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.security.autoconfigure.SecurityAutoConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * Contrat HTTP de {@link ForumController} (/api/forums) : binding des paramètres (path, query avec
 * valeurs par défaut, header X-User-Email injecté par le gateway), codes de retour (200/201/204)
 * et traduction des exceptions du service (404/400). Le service est mocké ; la sécurité est
 * exclue (autorisation déléguée au permission-service en amont).
 */
@WebMvcTest(controllers = ForumController.class,
        excludeAutoConfiguration = SecurityAutoConfiguration.class)
class ForumControllerTest {

    private static final String EMAIL = "eva@test.ca";

    @Autowired private MockMvc mockMvc;

    @MockitoBean private ForumService forumService;

    private static PostVoteUserDTO postDto(int id, String content) {
        return PostVoteUserDTO.builder().id(id).content(content).voteTotalValue(3).userVoteValue(1).build();
    }

    // ── GET ─────────────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Lecture")
    class Read {

        @Test
        @DisplayName("GET /forums/{id}/f_type → 200 avec le type en texte")
        void forumType() throws Exception {
            when(forumService.getForumType(4)).thenReturn("Discussion");

            mockMvc.perform(get("/api/forums/4/f_type"))
                    .andExpect(status().isOk())
                    .andExpect(content().string("Discussion"));
        }

        @Test
        @DisplayName("GET /forums/{id} → 200 avec le forum")
        void forumParId() throws Exception {
            when(forumService.findById(4)).thenReturn(
                    ForumDTO.builder().id(4).title("Entraide").courseId(1).fTypeName("Thread").build());

            mockMvc.perform(get("/api/forums/4"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(4))
                    .andExpect(jsonPath("$.title").value("Entraide"))
                    .andExpect(jsonPath("$.courseId").value(1));
        }

        @Test
        @DisplayName("GET /forums/{id} d'un forum inexistant → 404")
        void forumInexistant_404() throws Exception {
            when(forumService.findById(99)).thenThrow(new ForumNotFoundException());

            mockMvc.perform(get("/api/forums/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("GET /forums/{id}/posts/{postId} → loadChildren par défaut false, email transmis")
        void postParForum_defauts() throws Exception {
            when(forumService.getPostByForum(4, 10, false, EMAIL)).thenReturn(postDto(10, "Bonjour"));

            mockMvc.perform(get("/api/forums/4/posts/10").header("X-User-Email", EMAIL))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.id").value(10))
                    .andExpect(jsonPath("$.content").value("Bonjour"))
                    .andExpect(jsonPath("$.userVoteValue").value(1));
        }

        @Test
        @DisplayName("GET /forums/{id}/posts/{postId}?loadChildren=true sans email → email null")
        void postParForum_avecEnfantsSansEmail() throws Exception {
            when(forumService.getPostByForum(4, 10, true, null)).thenReturn(postDto(10, "Bonjour"));

            mockMvc.perform(get("/api/forums/4/posts/10").param("loadChildren", "true"))
                    .andExpect(status().isOk());

            verify(forumService).getPostByForum(4, 10, true, null);
        }

        @Test
        @DisplayName("GET d'un post inexistant → 404")
        void postInexistant_404() throws Exception {
            when(forumService.getPostByForum(4, 99, false, null)).thenThrow(new PostNotFoundException());

            mockMvc.perform(get("/api/forums/4/posts/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("GET /forums/{id}/posts/{postId}/replies → 200 avec la liste des réponses")
        void reponses() throws Exception {
            when(forumService.getRepliesByPost(4, 10, EMAIL)).thenReturn(List.of(postDto(11, "r1"), postDto(12, "r2")));

            mockMvc.perform(get("/api/forums/4/posts/10/replies").header("X-User-Email", EMAIL))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.length()").value(2))
                    .andExpect(jsonPath("$[1].content").value("r2"));
        }

        @Test
        @DisplayName("GET /forums/{id}/messages → curseur absent et limite par défaut 30")
        void messages_defauts() throws Exception {
            when(forumService.getMessagesPage(4, null, 30, null)).thenReturn(List.of(postDto(1, "m")));

            mockMvc.perform(get("/api/forums/4/messages"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].id").value(1));
        }

        @Test
        @DisplayName("GET /forums/{id}/messages?before=&limit= → curseur et limite transmis")
        void messages_curseur() throws Exception {
            when(forumService.getMessagesPage(4, 50, 10, EMAIL)).thenReturn(List.of());

            mockMvc.perform(get("/api/forums/4/messages").param("before", "50").param("limit", "10")
                            .header("X-User-Email", EMAIL))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$").isEmpty());

            verify(forumService).getMessagesPage(4, 50, 10, EMAIL);
        }

        @Test
        @DisplayName("GET /forums/{id}/posts → loadChildren false, curseur absent, limite 20 par défaut")
        void sujets_defauts() throws Exception {
            when(forumService.getRootPostsPage(4, null, 20, false, false, null)).thenReturn(List.of(postDto(1, "s")));

            mockMvc.perform(get("/api/forums/4/posts"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$[0].content").value("s"));
        }

        @Test
        @DisplayName("GET /forums/{id}/posts avec tous les paramètres → transmis tels quels")
        void sujets_parametres() throws Exception {
            when(forumService.getRootPostsPage(4, 30, 5, true, true, EMAIL)).thenReturn(List.of());

            mockMvc.perform(get("/api/forums/4/posts")
                            .param("loadChildren", "true").param("before", "30").param("limit", "5")
                            .param("includeExpired", "true")
                            .header("X-User-Email", EMAIL))
                    .andExpect(status().isOk());

            verify(forumService).getRootPostsPage(4, 30, 5, true, true, EMAIL);
        }

        @Test
        @DisplayName("Id de forum non numérique → 400 sans appel au service")
        void idNonNumerique_400() throws Exception {
            mockMvc.perform(get("/api/forums/abc"))
                    .andExpect(status().isBadRequest());

            verifyNoInteractions(forumService);
        }
    }

    // ── POST ────────────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("Écriture")
    class Write {

        private static final String POST_BODY =
                "{\"content\":\"Salut\",\"forumId\":4,\"parentPostId\":null,\"clientMessageId\":\"c-1\"}";

        @Test
        @DisplayName("POST /forums/messages → 201 avec le message persisté")
        void ajouterMessage_201() throws Exception {
            when(forumService.addPostToForum(any(PostCreateInForumDTO.class), eq(EMAIL))).thenReturn(postDto(77, "Salut"));

            mockMvc.perform(post("/api/forums/messages").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON).content(POST_BODY))
                    .andExpect(status().isCreated())
                    .andExpect(jsonPath("$.id").value(77));

            verify(forumService).addPostToForum(
                    argThat(dto -> dto.getForumId() == 4 && "Salut".equals(dto.getContent())
                            && "c-1".equals(dto.getClientMessageId())),
                    eq(EMAIL));
        }

        @Test
        @DisplayName("POST /forums/messages sans header X-User-Email → 400, service non appelé")
        void ajouterMessage_sansEmail_400() throws Exception {
            mockMvc.perform(post("/api/forums/messages")
                            .contentType(MediaType.APPLICATION_JSON).content(POST_BODY))
                    .andExpect(status().isBadRequest());

            verifyNoInteractions(forumService);
        }

        @Test
        @DisplayName("POST /forums/posts → 201 avec le sujet créé (titre transmis)")
        void ajouterSujet_201() throws Exception {
            when(forumService.addPostToForum(any(PostCreateInForumDTO.class), eq(EMAIL))).thenReturn(postDto(78, "Corps"));

            mockMvc.perform(post("/api/forums/posts").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"content\":\"Corps\",\"title\":\"Sujet\",\"forumId\":4,\"clientPostId\":\"p-1\"}"))
                    .andExpect(status().isCreated())
                    .andExpect(jsonPath("$.id").value(78));

            verify(forumService).addPostToForum(
                    argThat(dto -> "Sujet".equals(dto.getTitle()) && "p-1".equals(dto.getClientPostId())),
                    eq(EMAIL));
        }

        @Test
        @DisplayName("POST d'un contenu invalide (trop long) → 400")
        void ajouterSujet_contenuInvalide_400() throws Exception {
            when(forumService.addPostToForum(any(PostCreateInForumDTO.class), eq(EMAIL)))
                    .thenThrow(new InvalidPostException("Contenu trop long"));

            mockMvc.perform(post("/api/forums/posts").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON).content(POST_BODY))
                    .andExpect(status().isBadRequest())
                    .andExpect(content().string("Contenu trop long"));
        }

        @Test
        @DisplayName("POST /forums/posts/votes → 204, vote transmis au service")
        void voter_204() throws Exception {
            mockMvc.perform(post("/api/forums/posts/votes").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"voteValue\":-1,\"postId\":10,\"forumId\":4}"))
                    .andExpect(status().isNoContent());

            verify(forumService).addVoteToPost(
                    argThat((VoteCreateInPostDTO v) -> v.getVoteValue() == -1 && v.getPostId() == 10),
                    eq(EMAIL));
        }

        @ParameterizedTest
        @ValueSource(strings = {
                "{\"voteValue\":0,\"postId\":10,\"forumId\":4}",
                "{\"voteValue\":2,\"postId\":10,\"forumId\":4}",
                "{\"voteValue\":-5,\"postId\":10,\"forumId\":4}",
                "{\"postId\":10,\"forumId\":4}",
                "{\"voteValue\":1,\"forumId\":4}",
                "{\"voteValue\":1,\"postId\":0,\"forumId\":4}",
                "{\"voteValue\":1,\"postId\":10}",
                "{\"voteValue\":1,\"postId\":10,\"forumId\":-4}"
        })
        @DisplayName("POST /forums/posts/votes invalide (valeur ≠ ±1, id absent ou ≤ 0) → 400, service non appelé")
        void voter_invalide_400(String body) throws Exception {
            mockMvc.perform(post("/api/forums/posts/votes").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON).content(body))
                    .andExpect(status().isBadRequest());

            verifyNoInteractions(forumService);
        }

        @Test
        @DisplayName("POST /forums/posts/votes sur un post introuvable → 404")
        void voter_postInexistant_404() throws Exception {
            doThrow(new PostNotFoundException()).when(forumService)
                    .addVoteToPost(any(VoteCreateInPostDTO.class), eq(EMAIL));

            mockMvc.perform(post("/api/forums/posts/votes").header("X-User-Email", EMAIL)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"voteValue\":1,\"postId\":99,\"forumId\":4}"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("PATCH /forums/{id} → 200 avec le forum renommé")
        void modifierForum() throws Exception {
            when(forumService.updateForum(eq(4), any(ForumUpdateDTO.class)))
                    .thenReturn(ForumDTO.builder().id(4).title("Nouveau").build());

            mockMvc.perform(patch("/api/forums/4")
                            .contentType(MediaType.APPLICATION_JSON).content("{\"title\":\"Nouveau\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.title").value("Nouveau"));

            verify(forumService).updateForum(eq(4), argThat(dto -> "Nouveau".equals(dto.getTitle())));
        }

        @Test
        @DisplayName("PATCH /forums/{id}/posts/{postId} → 200 avec le post modifié")
        void modifierPost() throws Exception {
            when(forumService.updatePost(eq(4), eq(10), any(ForumUpdatePostDTO.class)))
                    .thenReturn(PostDTO.builder().id(10).content("édité").isPinned(true).build());

            mockMvc.perform(patch("/api/forums/4/posts/10")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{\"content\":\"édité\",\"isPinned\":true}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.content").value("édité"))
                    .andExpect(jsonPath("$.isPinned").value(true));

            verify(forumService).updatePost(eq(4), eq(10),
                    argThat(dto -> Boolean.TRUE.equals(dto.getIsPinned()) && dto.getTitle() == null));
        }

        @Test
        @DisplayName("PATCH d'un post dans un autre type que application/json → 415, service non appelé")
        void modifierPost_typeNonJson_415() throws Exception {
            mockMvc.perform(patch("/api/forums/4/posts/10")
                            .contentType("application/merge-patch+json")
                            .content("{\"isPinned\":true}"))
                    .andExpect(status().isUnsupportedMediaType());

            verifyNoInteractions(forumService);
        }

        @Test
        @DisplayName("PATCH d'un post en application/json avec charset → accepté")
        void modifierPost_jsonAvecCharset_200() throws Exception {
            when(forumService.updatePost(eq(4), eq(10), any(ForumUpdatePostDTO.class)))
                    .thenReturn(PostDTO.builder().id(10).content("x").build());

            mockMvc.perform(patch("/api/forums/4/posts/10")
                            .contentType("application/json;charset=UTF-8")
                            .content("{\"content\":\"x\"}"))
                    .andExpect(status().isOk());
        }

        @Test
        @DisplayName("PATCH d'un post inexistant → 404")
        void modifierPost_inexistant_404() throws Exception {
            when(forumService.updatePost(eq(4), eq(99), any(ForumUpdatePostDTO.class)))
                    .thenThrow(new PostNotFoundException());

            mockMvc.perform(patch("/api/forums/4/posts/99")
                            .contentType(MediaType.APPLICATION_JSON).content("{\"content\":\"x\"}"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("DELETE /forums/{id} → 204")
        void supprimerForum_204() throws Exception {
            mockMvc.perform(delete("/api/forums/4"))
                    .andExpect(status().isNoContent());

            verify(forumService).deleteForum(4);
        }

        @Test
        @DisplayName("DELETE d'un forum inexistant → 404")
        void supprimerForum_inexistant_404() throws Exception {
            doThrow(new ForumNotFoundException()).when(forumService).deleteForum(99);

            mockMvc.perform(delete("/api/forums/99"))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("DELETE /forums/{id}/posts/{postId} → 204, email de l'auteur transmis")
        void supprimerPost_204() throws Exception {
            mockMvc.perform(delete("/api/forums/4/posts/10").header("X-User-Email", EMAIL))
                    .andExpect(status().isNoContent());

            verify(forumService).deletePost(4, 10, EMAIL);
        }

        @Test
        @DisplayName("DELETE d'un post introuvable → 404 (pas 500)")
        void supprimerPost_inexistant_404() throws Exception {
            doThrow(new PostNotFoundException()).when(forumService).deletePost(4, 99, EMAIL);

            mockMvc.perform(delete("/api/forums/4/posts/99").header("X-User-Email", EMAIL))
                    .andExpect(status().isNotFound());
        }

        @Test
        @DisplayName("DELETE d'un post sans header X-User-Email → 400")
        void supprimerPost_sansEmail_400() throws Exception {
            mockMvc.perform(delete("/api/forums/4/posts/10"))
                    .andExpect(status().isBadRequest());

            verifyNoInteractions(forumService);
        }
    }

    @Test
    @DisplayName("Réponses lues sans header X-User-Email → lecture anonyme (email null transmis)")
    void reponsesSansEmail_lectureAnonyme() throws Exception {
        when(forumService.getRepliesByPost(eq(4), eq(10), isNull())).thenReturn(List.of());

        mockMvc.perform(get("/api/forums/4/posts/10/replies"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$").isEmpty());
    }
}
