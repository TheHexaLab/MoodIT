package com.moodit.core_service.service;

import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.dto.PostDTO;

import com.moodit.core_service.dto.PostVoteUserDTO;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Post;
import com.moodit.core_service.model.Vote;
import com.moodit.core_service.repository.ForumRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class ForumService {

    private final ForumRepository forumRepository;

    //region Transformations d'Entités (entité BD -> DTO)
    public ForumDTO toForumDTO(Forum forum) {

        ForumDTO dto = new ForumDTO();

        dto.setId(forum.getId());
        dto.setTitle(forum.getTitle());
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
        dto.setIsPinned(post.getIsPinned());

        return dto;
    }
    public PostVoteUserDTO toPostVoteUserDTO(Post post, boolean loadChildren) {
        PostVoteUserDTO dto = new PostVoteUserDTO();

        dto.setId(post.getId());
        dto.setCreatedAt(post.getCreatedAt());
        dto.setContent(post.getContent());
        dto.setIsPinned(post.getIsPinned());
        dto.setVoteTotalValue(post.getVotes()
                .stream()
                .mapToInt(Vote::getValue)
                .sum());
        dto.setUserId(post.getUser().getId());
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
                .orElseThrow(() -> new RuntimeException("Forum not found"));

        return forum.getFType().getName();
    }
    public ForumDTO findById(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(() -> new RuntimeException("Forum not found"));

        return toForumDTO(forum);
    }
    public PostVoteUserDTO getPostByForum (Integer forumId, Integer postId, boolean loadChildren) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(() -> new RuntimeException("Forum not found"));
        Post post = forum.getPosts()
                .stream()
                .filter(p -> p.getId().equals(postId))
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Post not found in this forum"));

        return toPostVoteUserDTO(post, loadChildren);
    }
    //endregion

}