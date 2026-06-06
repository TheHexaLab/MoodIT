package com.moodit.core_service.controller;

//Model
import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.model.Forum;

//Service
import com.moodit.core_service.service.ForumService;

import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/forums")
@RequiredArgsConstructor
public class ForumController {

    private final ForumService forumService;

    @GetMapping("/{forumId}/f_type")
    public ResponseEntity<String> getForumType(@PathVariable Integer forumId) {
        return ResponseEntity.ok(forumService.getForumType(forumId));
    }

    @GetMapping("/{forumId}")
    public ResponseEntity<ForumDTO> findForumById(
            @PathVariable Integer forumId) {

        return ResponseEntity.ok(
                forumService.findById(forumId)
        );
    }
}