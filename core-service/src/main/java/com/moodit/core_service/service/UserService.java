package com.moodit.core_service.service;

// Model
import com.moodit.core_service.dto.*;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Enrollment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.User;
import com.moodit.core_service.service.ProgramService;
// Repository
import com.moodit.core_service.repository.UserRepository;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;

// Le pont entre le Controller et le Repository
@Service
@RequiredArgsConstructor
public class UserService {

  private final UserRepository userRepository;
  private final ProgramService programService;
  private final CourseService courseService;

  // region Transformations d'Entités (entité BD -> DTO)
  public UserDTO toUserDTO(User user) {
    UserDTO dto = new UserDTO();

    dto.setId(user.getId());
    dto.setUsername(user.getUsername());
    dto.setFirstName(user.getFirstName());
    dto.setLastName(user.getLastName());
    dto.setEmail(user.getEmail());
    dto.setSettings(user.getSettings());
    dto.setAvatarColor(user.getAvatarColor());
    dto.setCreatedAt(user.getCreatedAt());
    // dto.setVerifiedEmail(user.getVerifiedEmail());

    return dto;
  }

  public UserProgramsDTO toUserProgramsDTO(User user) {
    UserProgramsDTO dto = new UserProgramsDTO();

    dto.setId(user.getId());
    dto.setUsername(user.getUsername());
    dto.setFirstName(user.getFirstName());
    dto.setLastName(user.getLastName());
    dto.setEmail(user.getEmail());
    dto.setSettings(user.getSettings());
    dto.setAvatarColor(user.getAvatarColor());
    dto.setCreatedAt(user.getCreatedAt());
    // dto.setVerifiedEmail(user.getVerifiedEmail());
    dto.setPrograms(user.getPrograms().stream().map(programService::toProgramDTO).toList());

    return dto;
  }

  // endregion

  public UserProgramsDTO findById(Integer id) {
    User user = userRepository.findById(id).orElseThrow(UserNotFoundException::new);

    return toUserProgramsDTO(user);
  }

  public UserProgramsDTO findByUsername(String username) {
    User user = userRepository.findByUsername(username).orElseThrow(UserNotFoundException::new);

    return toUserProgramsDTO(user);
  }

  public List<UserDTO> findUsersByProgramAndRole(Integer programId, Integer roleId) {

    return userRepository.findByPrograms_IdAndRoles_Id(programId, roleId).stream()
        .map(this::toUserDTO)
        .toList();
  }

  public List<ProgramDTO> findProgramsByUserId(Integer userId) {

    User user = userRepository.findById(userId).orElseThrow(UserNotFoundException::new);

    return user.getPrograms().stream().map(programService::toProgramDTO).toList();
  }

  public UserDTO updateUser(Integer userId, UserUpdateDTO dto) {

    User user = userRepository.findById(userId).orElseThrow(UserNotFoundException::new);

    if (dto.getFirstName() != null) {
      user.setFirstName(dto.getFirstName());
    }

    if (dto.getLastName() != null) {
      user.setLastName(dto.getLastName());
    }

    if (dto.getAvatarColor() != null) {
      user.setAvatarColor(dto.getAvatarColor());
    }

    User saved = userRepository.save(user);

    return toUserDTO(saved);
  }

  public List<EnrollmentDTO> getEnrollmentsByUser(Integer userId) {
    User user =
        userRepository.findById(userId).orElseThrow(() -> new RuntimeException("User not found"));
    return user.getEnrollments().stream()
        .map(
            e -> {
              EnrollmentDTO dto = new EnrollmentDTO();
              dto.setCourseId(e.getCourse().getId());
              return dto;
            })
        .toList();
  }

  public List<CourseForumsDTO> getEnrollmentsByUserAndProgram(Integer userId, Integer programId) {

    User user = userRepository.findById(userId)
            .orElseThrow(UserNotFoundException::new);

    return user.getEnrollments().stream()
            .map(Enrollment::getCourse)
            .filter(course ->
                    course.getPrograms().stream()
                            .anyMatch(p -> p.getId().equals(programId))
            )
            .distinct()
            .map(courseService::toCourseForumsDTO)
            .toList();
  }
}
