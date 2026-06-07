package com.moodit.core_service.dto;

import com.moodit.core_service.model.Forum;
import lombok.Data;

import java.util.List;

@Data
public class CourseDTO {
    private Integer id;
    private String title;
    private String description;
    private String code;
    //private List<Forum> forums;
}
