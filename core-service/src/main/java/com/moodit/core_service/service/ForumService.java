package com.moodit.core_service.service;

import com.moodit.core_service.dto.*;

import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.exception.PostNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.User;
import com.moodit.core_service.model.Vote;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.PostRepository;
import com.moodit.core_service.repository.UserRepository;
import com.moodit.core_service.repository.VoteRepository;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.Author;
import com.moodit.core_service.realtime.dto.ChannelMessageDto;
import com.moodit.core_service.realtime.dto.ForumPostDto;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class ForumService {

    private final ForumRepository forumRepository;
    private final PostRepository postRepository;
    private final VoteRepository voteRepository;
    private final UserRepository userRepository;
    private final RealtimeEventPublisher realtimePublisher;

    // ── Temps réel ───────────────────────────────────────────────────────────────
    /** Un canal 'Discussion' (chat) ⇒ room `channel:` ; sinon 'Thread' ⇒ room `forum:`. */
    private boolean isDiscussion(Forum forum) {
        return "Discussion".equals(forum.getFType().getName());
    }

    /** Auteur embarqué dans un évènement temps réel (sous-ensemble de User_). */
    private Author toAuthor(User user) {
        return new Author(user.getId(), user.getUsername(), user.getFirstName(),
                user.getLastName(), user.getAvatarColor());
    }

    /**
     * Exécute l'action APRÈS le commit de la transaction (ou tout de suite hors transaction).
     * Évite la race « écho diffusé avant commit » : un client qui re-fetch verrait l'ancien état.
     */
    private void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
        } else {
            action.run();
        }
    }

    //region Transformations d'Entités (entité BD -> DTO)
    /** Auteur d'un post embarqué dans le DTO (le front lit message.author : prénom/nom, avatarColor…). */
    private UserDTO toAuthorDTO(User user) {
        UserDTO dto = new UserDTO();
        dto.setId(user.getId());
        dto.setUsername(user.getUsername());
        dto.setFirstName(user.getFirstName());
        dto.setLastName(user.getLastName());
        dto.setEmail(user.getEmail());
        dto.setAvatarColor(user.getAvatarColor());
        return dto;
    }

    public ForumDTO toForumDTO(Forum forum) {

        ForumDTO dto = new ForumDTO();

        dto.setId(forum.getId());
        dto.setTitle(forum.getTitle());
        dto.setPosition(forum.getPosition());
        dto.setFTypeId(forum.getFType().getId());
        dto.setFTypeName(forum.getFType().getName());
        dto.setCourseId(forum.getCourse().getId());

        return dto;
    }
    public PostDTO toPostDTO(Post post) {
        PostDTO dto = new PostDTO();

        dto.setId(post.getId());
        dto.setCreatedAt(toUtcInstant(post.getCreatedAt()));
        dto.setContent(post.getContent());
        dto.setTitle(post.getTitle());
        dto.setIsPinned(post.getIsPinned());

        return dto;
    }

    /** Le timestamp BD (TIMESTAMP sans zone, stocké en UTC) → Instant UTC pour le client. */
    private Instant toUtcInstant(LocalDateTime dateTime) {
        return dateTime == null ? null : dateTime.toInstant(ZoneOffset.UTC);
    }
    public PostVoteUserDTO toPostVoteUserDTO(Post post, boolean loadChildren, Integer currentUserId) {
        PostVoteUserDTO dto = new PostVoteUserDTO();

        dto.setId(post.getId());
        dto.setCreatedAt(toUtcInstant(post.getCreatedAt()));
        dto.setContent(post.getContent());
        dto.setTitle(post.getTitle());
        dto.setIsPinned(post.getIsPinned());
        // Collections null-safe : un post FRAÎCHEMENT créé (new Post()) a des collections
        // non initialisées → 0 vote / 0 enfant, sans NPE.
        dto.setVoteTotalValue(post.getVotes() == null ? 0 : post.getVotes()
                .stream()
                .mapToInt(Vote::getValue)
                .sum());
        // Vote propre de l'utilisateur courant (1 / -1 / null) : le front s'en sert pour
        // surligner le bouton qu'il a activé. currentUserId null (appelant non identifié)
        // → pas de surlignage.
        dto.setUserVoteValue(currentUserId == null || post.getVotes() == null ? null
                : post.getVotes().stream()
                    .filter(v -> v.getUser().getId().equals(currentUserId))
                    .map(Vote::getValue)
                    .findFirst()
                    .orElse(null));
        dto.setUserId(post.getUser().getId());
        dto.setPostParentId(post.getParent() != null ? post.getParent().getId() : null);
        dto.setAuthor(toAuthorDTO(post.getUser()));
        dto.setChildrenCount(post.getChildren() == null ? 0 : post.getChildren().size());
        if (loadChildren && post.getChildren() != null) {
            dto.setChildren(post.getChildren()
                    .stream()
                    .map(child -> toPostVoteUserDTO(child, false, currentUserId)) // pas récursif
                    .toList()); }
        else {
            dto.setChildren(null); // non déroulé, juste le count
        }
        return dto;
    }

    /** Résout l'id de l'utilisateur courant depuis l'email injecté par le gateway
     *  (null si absent / inconnu → DTO sans surlignage de vote). */
    private Integer resolveUserId(String email) {
        if (email == null || email.isBlank()) return null;
        return userRepository.findByEmail(email).map(User::getId).orElse(null);
    }
    //endregion

    //region GET
    public String getForumType(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        return forum.getFType().getName();
    }
    public ForumDTO findById(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        return toForumDTO(forum);
    }
    public PostVoteUserDTO getPostByForum (Integer forumId, Integer postId, boolean loadChildren, String email) {
        Integer currentUserId = resolveUserId(email);
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(PostNotFoundException::new);

        return toPostVoteUserDTO(post, loadChildren, currentUserId);
    }

    /**
     * Réponses DIRECTES (enfants immédiats) d'un post, en LISTE. Endpoint dédié
     * (`/posts/{postId}/replies`) : pas de query param `loadChildren` à préserver, le
     * front reçoit directement les réponses. `email` → vote propre par réponse.
     */
    public List<PostVoteUserDTO> getRepliesByPost(Integer forumId, Integer postId, String email) {
        Integer currentUserId = resolveUserId(email);
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(PostNotFoundException::new);

        List<Post> children = post.getChildren();
        if (children == null) return List.of();
        return children.stream()
                .map(child -> toPostVoteUserDTO(child, false, currentUserId))
                .toList();
    }

    public List<PostVoteUserDTO> getAllPostsByForum(Integer forumId, boolean loadChildren, String email) {
        Integer currentUserId = resolveUserId(email);
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        return forum.getPosts().stream()
                .filter(p -> p.getParent() == null) // only root posts OR remove this if you want all
                .map(p -> toPostVoteUserDTO(p, loadChildren, currentUserId))
                .toList();
    }

    /**
     * TOUS les messages d'un canal 'Discussion' (racines ET réponses), à PLAT et triés
     * chronologiquement. Le front les relie via `postParentId` (style chat/Discord).
     */
    public List<PostVoteUserDTO> getAllMessagesByForum(Integer forumId, String email) {
        Integer currentUserId = resolveUserId(email);
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        return forum.getPosts().stream()
                .sorted(Comparator.comparing(Post::getCreatedAt,
                        Comparator.nullsLast(Comparator.naturalOrder())))
                .map(p -> toPostVoteUserDTO(p, false, currentUserId))
                .toList();
    }
    //endregion

    //region POST
    @Transactional
    public PostVoteUserDTO addPostToForum(PostCreateInForumDTO postCreateInForumDTO, String email) {
        Forum forum = forumRepository.findById(postCreateInForumDTO.getForumId())
                .orElseThrow(ForumNotFoundException::new);
        User user = userRepository.findByEmail(email)
                .orElseThrow(UserNotFoundException::new);

        Post post = new Post();
        post.setForum(forum);
        post.setUser(user);
        post.setContent(postCreateInForumDTO.getContent());
        post.setTitle(postCreateInForumDTO.getTitle());
        post.setIsPinned(false);
        // createdAt est généré par la BD (@CreationTimestamp source=DB) → ordre cohérent.

        if (postCreateInForumDTO.getParentPostId() != null) {
            Post parent = forum.getPosts()
                    .stream()
                    .filter(p -> p.getId().equals(postCreateInForumDTO.getParentPostId()))
                    .findFirst()
                    .orElseThrow(PostNotFoundException::new);
            post.setParent(parent);
        }
        // saveAndFlush : force l'INSERT immédiat pour récupérer l'id ET le createdAt
        // généré par la BD, afin de renvoyer le post persisté au client (réconciliation
        // de l'affichage optimiste : remplace l'id temporaire négatif par l'id réel).
        Post saved = postRepository.saveAndFlush(post);

        // ── Diffusion temps réel (après commit) : les autres abonnés à ce forum/canal
        // voient le message/post apparaître LIVE ; l'auteur déduplique via clientId. ──
        long forumId = forum.getId();
        long postId = saved.getId();
        String content = saved.getContent();
        Instant createdInstant = toUtcInstant(saved.getCreatedAt());
        String createdAt = createdInstant == null ? null : createdInstant.toString();
        Author author = toAuthor(user);
        Long parentId = saved.getParent() != null ? saved.getParent().getId().longValue() : null;
        boolean discussion = isDiscussion(forum);
        String title = saved.getTitle();
        Boolean isPinned = saved.getIsPinned();
        // Le front envoie clientMessageId (chat) ou clientPostId (forum) selon le cas.
        String clientId = discussion
                ? postCreateInForumDTO.getClientMessageId()
                : postCreateInForumDTO.getClientPostId();
        afterCommit(() -> {
            if (discussion) {
                realtimePublisher.messageCreated(forumId,
                        new ChannelMessageDto(postId, content, createdAt, author, parentId, clientId));
            } else {
                realtimePublisher.postCreated(forumId,
                        new ForumPostDto(postId, content, createdAt, author, isPinned, title,
                                List.of(), List.of(), 0, clientId),
                        parentId);
            }
        });

        // Post neuf : aucun vote encore → userVoteValue null (l'auteur suffit comme contexte).
        return toPostVoteUserDTO(saved, false, user.getId());
    }
    @Transactional
    public void addVoteToPost(VoteCreateInPostDTO voteCreateInPostDTO, String email) {
        User user = userRepository.findByEmail(email)
                .orElseThrow(UserNotFoundException::new);

        Optional<Vote> existingVote = voteRepository.findByUserIdAndPostId(user.getId(), voteCreateInPostDTO.getPostId());

        // Valeur RÉSULTANTE du vote de l'utilisateur après l'opération (0 = retiré) : c'est
        // ce que les autres abonnés appliquent (withVote côté front).
        int result;
        if (existingVote.isEmpty()) {
            Post post = forumRepository.findById(voteCreateInPostDTO.getForumId())
                    .orElseThrow(ForumNotFoundException::new)
                    .getPosts().stream()
                    .filter(p -> p.getId().equals(voteCreateInPostDTO.getPostId()))
                    .findFirst()
                    .orElseThrow(PostNotFoundException::new);

            Vote vote = new Vote();
            vote.setPost(post);
            vote.setUser(user);
            vote.setValue(voteCreateInPostDTO.getVoteValue());
            voteRepository.save(vote);
            result = voteCreateInPostDTO.getVoteValue();

        } else if (existingVote.get().getValue().equals(voteCreateInPostDTO.getVoteValue())) {
            // Même valeur: annuler
            voteRepository.delete(existingVote.get());
            result = 0;
        } else {
            // Valeur opposée: changer
            existingVote.get().setValue(voteCreateInPostDTO.getVoteValue());
            result = voteCreateInPostDTO.getVoteValue();
        }

        // ── Diffusion temps réel (après commit) sur la room du forum. ──
        long forumId = voteCreateInPostDTO.getForumId();
        long postId = voteCreateInPostDTO.getPostId();
        long userId = user.getId();
        int resultingValue = result;
        afterCommit(() -> realtimePublisher.postVoted(forumId, postId, userId, resultingValue));
    }
    //endregion

    //region PATCH
    public ForumDTO updateForum(Integer forumId, ForumUpdateDTO forumUpdateDTO) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        if (forumUpdateDTO.getTitle() != null) {
            forum.setTitle(forumUpdateDTO.getTitle());
        }

        forumRepository.save(forum);
        return toForumDTO(forum);
    }
    @Transactional
    public PostDTO updatePost(Integer forumId, Integer postId, ForumUpdatePostDTO forumUpdatePostDTO) {
    Forum forum = forumRepository.findById(forumId)
            .orElseThrow(ForumNotFoundException::new);
    Post post = forum.getPosts()
            .stream()
            .filter(p -> p.getId().equals(postId))
            .findFirst()
            .orElseThrow(PostNotFoundException::new);

        if (forumUpdatePostDTO.getContent() != null) {
            post.setContent(forumUpdatePostDTO.getContent());
        }
        if (forumUpdatePostDTO.getIsPinned() != null) {
            post.setIsPinned(forumUpdatePostDTO.getIsPinned());
        }

        // ── Diffusion temps réel (après commit) : seul le contenu est propagé (les events
        // WS *:edited ne portent que le contenu ; isPinned n'est pas encore diffusé). ──
        if (forumUpdatePostDTO.getContent() != null) {
            long fId = forum.getId();
            long pId = post.getId();
            String content = post.getContent();
            boolean discussion = isDiscussion(forum);
            afterCommit(() -> {
                if (discussion) realtimePublisher.messageEdited(fId, pId, content);
                else realtimePublisher.postEdited(fId, pId, content);
            });
        }

        return toPostDTO(post);
    }
    //endregion

    //region DELETE
    public void deleteForum(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        forumRepository.delete(forum); //ON DELETE CASCADE
    }
    @Transactional
    public void deletePost(Integer forumId, Integer postId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Post not found"));

        // Capturé AVANT delete (f_type du forum encore accessible) ; émis après commit.
        long fId = forum.getId();
        long pId = post.getId();
        boolean discussion = isDiscussion(forum);

        postRepository.delete(post); //ON DELETE CASCADE

        afterCommit(() -> {
            if (discussion) realtimePublisher.messageDeleted(fId, pId);
            else realtimePublisher.postDeleted(fId, pId);
        });
    }
    //endregion

}