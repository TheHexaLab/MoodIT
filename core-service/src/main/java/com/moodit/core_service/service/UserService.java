package com.moodit.core_service.service;

//Model
import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.UserDTO;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.User;
import com.moodit.core_service.service.ProgramService;
//Repository
import com.moodit.core_service.repository.UserRepository;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;

//Le pont entre le Controller et le Repository
@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;
    //private final ProgramService programService;

    private UserDTO toUserDTO(User user) {
        UserDTO dto = new UserDTO();

        dto.setId(user.getId());
        dto.setUsername(user.getUsername());
        dto.setFirstName(user.getFirstName());
        dto.setLastName(user.getLastName());
        dto.setEmail(user.getEmail());
        dto.setSettings(user.getSettings());
        dto.setAvatarColor(user.getAvatarColor());
        dto.setCreatedAt(user.getCreatedAt());
        dto.setVerifiedEmail(user.getVerifiedEmail());

        //dto.setRoles(user.getRoles())
        dto.setPrograms(user.getPrograms()
                .stream()
                .map(this::toProgramDTO)
                .toList());

        return dto;
    }

    private ProgramDTO toProgramDTO(Program program) {
        ProgramDTO dto = new ProgramDTO();

        dto.setId(program.getId());
        dto.setName(program.getName());
        dto.setCode(program.getCode());
        dto.setCohort(program.getCohort());
        dto.setColor(program.getColor());
        dto.setCourses(program.getCourses()
                .stream()
                .map(this::toCourseDTO)
                .toList());
        return dto;
    }
    private CourseDTO toCourseDTO(Course course) {
        CourseDTO dto = new CourseDTO();

        dto.setId(course.getId());
        dto.setTitle(course.getTitle());
        dto.setDescription(course.getDescription());
        dto.setCode(course.getCode());
        return dto;
    }


    public List<UserDTO> findAll() {
        return userRepository.findAll()
                .stream()
                .map(this::toUserDTO)
                .toList();
    }



}