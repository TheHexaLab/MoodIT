package com.moodit.core_service.dto;

import lombok.Data;

@Data
public class ForumUpdatePostDTO {
    private String content;
    private Boolean isPinned;
}
