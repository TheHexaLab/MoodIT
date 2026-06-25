package com.moodit.core_service.dto;

import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
@JsonPropertyOrder({"id", "content", "createdAt", "isPinned", "userId", "voteTotalValue", "childrenCount", "children"})
public class PostVoteUserDTO extends PostDTO{
    private Integer voteTotalValue;
    private Integer userId;
    private Integer childrenCount;
    private List<PostVoteUserDTO> children;
}
