package com.moodit.core_service.dto;

import lombok.Data;

import java.time.LocalDateTime;

@Data
public class PostDTO {
    private Integer id;
    private LocalDateTime createdAt;
    private String content;
    private Boolean isPinned;
}
