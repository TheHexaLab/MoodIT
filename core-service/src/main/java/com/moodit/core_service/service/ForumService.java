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
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class ForumService {

    private final ForumRepository forumRepository;
    private final PostRepository postRepository;
    private final VoteRepository voteRepository;
    private final UserRepository userRepository;

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
        dto.setCreatedAt(post.getCreatedAt());
        dto.setContent(post.getContent());
        dto.setTitle(post.getTitle());
        dto.setIsPinned(post.getIsPinned());

        return dto;
    }
    public PostVoteUserDTO toPostVoteUserDTO(Post post, boolean loadChildren) {
        PostVoteUserDTO dto = new PostVoteUserDTO();

        dto.setId(post.getId());
        dto.setCreatedAt(post.getCreatedAt());
        dto.setContent(post.getContent());
        dto.setTitle(post.getTitle());
        dto.setIsPinned(post.getIsPinned());
        dto.setVoteTotalValue(post.getVotes()
                .stream()
                .mapToInt(Vote::getValue)
                .sum());
        dto.setUserId(post.getUser().getId());
        dto.setAuthor(toAuthorDTO(post.getUser()));
        dto.setChildrenCount(post.getChildren().size());
        if (loadChildren) {
            dto.setChildren(post.getChildren()
                    .stream()
                    .map(child -> toPostVoteUserDTO(child, false)) // pas récursif
                    .toList()); }
        else {
            dto.setChildren(null); // non déroulé, juste le count
        }
        return dto;
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
    public PostVoteUserDTO getPostByForum (Integer forumId, Integer postId, boolean loadChildren) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(PostNotFoundException::new);

        return toPostVoteUserDTO(post, loadChildren);
    }

    public List<PostVoteUserDTO> getAllPostsByForum(Integer forumId, boolean loadChildren) {

        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        return forum.getPosts().stream()
                .filter(p -> p.getParent() == null) // only root posts OR remove this if you want all
                .map(p -> toPostVoteUserDTO(p, loadChildren))
                .toList();
    }
    //endregion

    //region POST
    @Transactional
    public void addPostToForum(PostCreateInForumDTO postCreateInForumDTO, String email) {
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
        post.setCreatedAt(LocalDateTime.now());

        if (postCreateInForumDTO.getParentPostId() != null) {
            Post parent = forum.getPosts()
                    .stream()
                    .filter(p -> p.getId().equals(postCreateInForumDTO.getParentPostId()))
                    .findFirst()
                    .orElseThrow(PostNotFoundException::new);
            post.setParent(parent);
        }
        postRepository.save(post);
    }
    @Transactional
    public void addVoteToPost(VoteCreateInPostDTO voteCreateInPostDTO, String email) {
        User user = userRepository.findByEmail(email)
                .orElseThrow(UserNotFoundException::new);

        Optional<Vote> existingVote = voteRepository.findByUserIdAndPostId(user.getId(), voteCreateInPostDTO.getPostId());

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

        } else if (existingVote.get().getValue().equals(voteCreateInPostDTO.getVoteValue())) {
            // Même valeur: annuler
            voteRepository.delete(existingVote.get());
        } else {
            // Valeur opposée: changer
            existingVote.get().setValue(voteCreateInPostDTO.getVoteValue());
        }
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

        return toPostDTO(post);
    }
    //endregion

    //region DELETE
    public void deleteForum(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);

        forumRepository.delete(forum); //ON DELETE CASCADE
    }
    public void deletePost(Integer forumId, Integer postId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(ForumNotFoundException::new);
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Post not found"));

        postRepository.delete(post); //ON DELETE CASCADE
    }
    //endregion

}