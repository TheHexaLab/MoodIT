package com.moodit.core_service.dto;

import com.moodit.core_service.model.Forum;
import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import lombok.experimental.SuperBuilder;

import java.util.List;

@Data
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class CourseForumsDTO extends CourseDTO {
    private List<ForumDTO> forums;
}
