package com.moodit.core_service.dto;

import com.moodit.core_service.model.Forum;
import lombok.Data;

import java.util.List;

@Data
public class CourseForumsDTO extends CourseDTO {
    private List<ForumDTO> forums;
}
