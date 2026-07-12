package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.ProgramDTO;
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
 * Filtrage PAR RÔLE de la liste des programmes « gérables » d'un établissement
 * ({@link ProgramService#getManageableProgramsInEstablishment}) : tous (admin global/gardien)
 * ou seulement ceux où l'utilisateur est admin/enseignant.
 *
 * NB : l'autorisation de l'AJOUT d'un cours (403 si on ne gère pas tous les programmes visés)
 * n'est plus testée ici — elle est déléguée au permission-service (règle POST /programs/courses).
 */
@ExtendWith(MockitoExtension.class)
class ProgramServiceCourseAuthTest {

    @Mock private ProgramRepository programRepository;
    @Mock private CourseRepository courseRepository;
    @Mock private UserRepository userRepository;
    @Mock private UserProgramRoleRepository userProgramRoleRepository;
    @Mock private EnrollmentRepository enrollmentRepository;
    @Mock private RealtimeEventPublisher realtimePublisher;
    @Mock private AuditLogService auditLogService;

    private ProgramService service;

    @BeforeEach
    void setUp() {
        service = new ProgramService(
                programRepository, courseRepository, userRepository,
                userProgramRoleRepository, enrollmentRepository, realtimePublisher, auditLogService);
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
