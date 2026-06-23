package com.moodit.core_service.dto;

import lombok.Data;

@Data
public class VoteCreateInPostDTO {
    private Integer voteValue;
    private Integer postId;
    private Integer forumId;
}
