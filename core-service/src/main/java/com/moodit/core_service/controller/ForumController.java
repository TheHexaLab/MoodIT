package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.*;

//Service
import com.moodit.core_service.service.ForumService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;


@RestController
@RequestMapping("/forums")
@RequiredArgsConstructor
public class ForumController {

    private final ForumService forumService;

    //region GET
    @GetMapping("/{forumId}/f_type")
    public ResponseEntity<String> getForumType(@PathVariable Integer forumId) {
        return ResponseEntity.ok(forumService.getForumType(forumId));
    }

    //Vérifier s'il sert réellement à quelque chose
    @GetMapping("/{forumId}")
    public ResponseEntity<ForumDTO> findForumById(@PathVariable Integer forumId) {

        return ResponseEntity.ok(forumService.findById(forumId));
    }

    @GetMapping("/{forumId}/posts/{postId}")
    public ResponseEntity<PostDTO> getPostByForum(@PathVariable Integer forumId,
                                                  @PathVariable Integer postId,
                                                  @RequestParam(defaultValue = "false") boolean loadChildren) {
        return ResponseEntity.ok(forumService.getPostByForum(forumId, postId, loadChildren));
    }
    //endregion

    //region POST
    @PostMapping("/posts")
    public ResponseEntity<Void> addPostToForum(@RequestBody PostCreateInForumDTO postCreateInForumDTO) {
        Integer userId = (Integer) SecurityContextHolder.getContext()
                .getAuthentication()
                .getPrincipal();
        forumService.addPostToForum(postCreateInForumDTO, userId);
        return ResponseEntity.noContent().build(); //code 204
    }
    @PostMapping("/posts/votes")
    public ResponseEntity<Void> addVoteToPost(@RequestBody VoteCreateInPostDTO voteCreateInPostDTO) {
        Integer userId = (Integer) SecurityContextHolder.getContext()
                .getAuthentication()
                .getPrincipal();
        forumService.addVoteToPost(voteCreateInPostDTO, userId);
        return ResponseEntity.noContent().build(); //code 204
    }
    //endregion

    //region PATCH
    @PatchMapping("/{forumId}")
    public ResponseEntity<ForumDTO> updateForum(@PathVariable Integer forumId, @RequestBody ForumUpdateDTO forumUpdateDTO) {
        return ResponseEntity.ok(forumService.updateForum(forumId, forumUpdateDTO));
    }

    @PatchMapping("/{forumId}/posts/{postId}")
    public ResponseEntity<PostDTO> updatePost(@PathVariable Integer forumId,
                                              @PathVariable Integer postId,
                                              @RequestBody ForumUpdatePostDTO forumUpdatePostDTO) {
        return ResponseEntity.ok(forumService.updatePost(forumId, postId, forumUpdatePostDTO));
    }
    //endregion

    //region DELETE
    @DeleteMapping("/{forumId}")
    public ResponseEntity<Void> deleteForum(@PathVariable Integer forumId) {
        forumService.deleteForum(forumId);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/{forumId}/posts/{postId}")
    public ResponseEntity<Void> deletePost(@PathVariable Integer forumId,
                                           @PathVariable Integer postId) {
        forumService.deletePost(forumId, postId);
        return ResponseEntity.noContent().build();
    }
    //endregion
}