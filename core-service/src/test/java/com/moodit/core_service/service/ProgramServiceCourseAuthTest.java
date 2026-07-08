package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.CourseCreateInProgramsDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.exception.ForbiddenException;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Role;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.UserProgramRoleRepository;
import com.moodit.core_service.repository.UserRepository;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Autorisation de l'ajout d'un cours dans des programmes ({@link ProgramService}) :
 *  - un utilisateur SANS rôle global doit être Administrateur/Enseignant de CHAQUE programme visé,
 *    sinon 403 ;
 *  - la liste des programmes « gérables » d'un établissement = tous (admin global/gardien) ou
 *    seulement ceux où l'utilisateur est admin/enseignant.
 */
@ExtendWith(MockitoExtension.class)
class ProgramServiceCourseAuthTest {

    @Mock private ProgramRepository programRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private UserRepository userRepository;
    @Mock private UserProgramRoleRepository userProgramRoleRepository;
    @Mock private EnrollmentRepository enrollmentRepository;
    @Mock private RealtimeEventPublisher realtimePublisher;

    private ProgramService service;

    @BeforeEach
    void setUp() {
        service = new ProgramService(
                programRepository, courseRepository, userRepository,
                userProgramRoleRepository, enrollmentRepository, realtimePublisher);
    }

    private static User userWith(int id, String... roleNames) {
        User u = new User();
        u.setId(id);
        u.setEmail("a@a");
        u.setRoles(Arrays.stream(roleNames).map(n -> {
            Role r = new Role();
            r.setName(n);
            return r;
        }).toList());
        return u;
    }

    private static Program program(int id, String name) {
        Program p = new Program();
        p.setId(id);
        p.setName(name);
        return p;
    }

    private static CourseCreateInProgramsDTO courseIn(List<Integer> programIds) {
        CourseCreateInProgramsDTO dto = new CourseCreateInProgramsDTO();
        dto.setCode("INF101");
        dto.setTitle("Intro");
        dto.setProgramIds(programIds);
        return dto;
    }

    @Test
    void addCourse_notManagerOfEveryTargetProgram_isForbidden() {
        // Aucun rôle global ; gère le programme 1 mais PAS le 2 → refus (il faut TOUS les programmes).
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(userWith(5)));
        when(userRepository.programIdsManagedAmong(5, List.of(1, 2))).thenReturn(List.of(1));

        assertThatThrownBy(() -> service.addCourseToPrograms(courseIn(List.of(1, 2)), "a@a"))
                .isInstanceOf(ForbiddenException.class);
    }

    @Test
    void manageablePrograms_globalGuardian_returnsAllOfEstablishment() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(userWith(5, "Gardien")));
        when(programRepository.findByEstablishment_Id(1))
                .thenReturn(List.of(program(1, "P1"), program(2, "P2")));

        List<ProgramDTO> res = service.getManageableProgramsInEstablishment(1, "a@a");

        assertThat(res).extracting(ProgramDTO::getId).containsExactly(1, 2);
    }

    @Test
    void manageablePrograms_nonAdmin_returnsOnlyManaged() {
        when(userRepository.findByEmail("a@a")).thenReturn(Optional.of(userWith(5)));
        when(programRepository.findManageableInEstablishment(5, 1))
                .thenReturn(List.of(program(1, "P1")));

        List<ProgramDTO> res = service.getManageableProgramsInEstablishment(1, "a@a");

        assertThat(res).extracting(ProgramDTO::getId).containsExactly(1);
    }
}
