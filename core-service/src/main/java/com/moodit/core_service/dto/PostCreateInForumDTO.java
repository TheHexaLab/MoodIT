package com.moodit.core_service.dto;

import lombok.Data;

@Data
public class PostCreateInForumDTO{
    private String content;
    private Integer forumId;
    private Integer parentPostId;
}
