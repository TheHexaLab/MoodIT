package com.moodit.core_service.service;

import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.repository.ForumRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ForumService {

    private final ForumRepository forumRepository;

    public ForumDTO toForumDTO(Forum forum) {

        ForumDTO dto = new ForumDTO();

        dto.setId(forum.getId());
        dto.setTitle(forum.getTitle());

        dto.setCourseId(forum.getCourse().getId());

        dto.setFTypeId(forum.getFType().getId());
        dto.setFTypeName(forum.getFType().getName());

        return dto;
    }


    public String getForumType(Integer forumId) {
        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(() ->
                        new RuntimeException("Forum not found"));

        return forum.getFType().getName();
    }

    public ForumDTO findById(Integer forumId) {

        Forum forum = forumRepository.findById(forumId)
                .orElseThrow(() ->
                        new RuntimeException("Forum not found"));

        return toForumDTO(forum);
    }

}