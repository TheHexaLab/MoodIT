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
    private final ProgramService programService;

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
                .map(programService::toProgramDTO)
                .toList());

        return dto;
    }


    public List<UserDTO> findAll() {
        return userRepository.findAll()
                .stream()
                .map(this::toUserDTO)
                .toList();
    }


    public UserDTO findByUsername(String username) {
        User user = userRepository.findByUsername(username)
                .orElseThrow(() -> new RuntimeException("User not found with username: " + username));

        return toUserDTO(user);
    }

}