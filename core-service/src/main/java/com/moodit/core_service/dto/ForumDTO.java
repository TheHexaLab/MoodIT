package com.moodit.core_service.dto;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class ForumDTO {
    private Integer id;
    private String title;
    private Integer position;
    private Integer courseId;
    private Integer fTypeId;
    private String fTypeName;
}
