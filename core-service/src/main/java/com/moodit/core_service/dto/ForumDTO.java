package com.moodit.core_service.dto;

import lombok.Data;

@Data
public class ForumDTO {
    private Integer id;
    private String title;
    private Integer courseId;
    private Integer fTypeId;
    private String fTypeName;
}
