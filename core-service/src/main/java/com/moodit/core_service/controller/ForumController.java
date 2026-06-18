package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.ForumDTO;

//Service
import com.moodit.core_service.dto.PostDTO;
import com.moodit.core_service.service.ForumService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
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
}