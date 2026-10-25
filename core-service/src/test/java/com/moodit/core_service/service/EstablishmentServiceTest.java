package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.EstablishmentDTO;
import com.moodit.core_service.dto.EstablishmentUpdateDTO;
import com.moodit.core_service.dto.ProgramCreateInEstablishmentDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.UserCreateInProgramsDTO;
import com.moodit.core_service.exception.EstablishmentNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.repository.EstablishmentRepository;
import com.moodit.core_service.repository.ProgramRepository;
import com.moodit.core_service.repository.UserRepository;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Tests unitaires de {@link EstablishmentService}. Hors transaction, {@code afterCommit} exécute
 * l'écho temps réel tout de suite : on le vérifie directement sur le publisher mocké.
 */
@ExtendWith(MockitoExtension.class)
class EstablishmentServiceTest {

  @Mock private EstablishmentRepository establishmentRepository;
  @Mock private ProgramService programService;
  @Mock private ProgramRepository programRepository;
  @Mock private UserRepository userRepository;
  @Mock private RealtimeEventPublisher realtimePublisher;
  @Mock private AuditLogService auditLogService;

  @InjectMocks private EstablishmentService establishmentService;

  private static Establishment establishment(int id, String name, String domain, List<Program> programs) {
    Establishment e = new Establishment();
    e.setId(id);
    e.setName(name);
    e.setDomainEmail(domain);
    e.setPrograms(programs);
    return e;
  }

  private static Program program(int id, String code) {
    return Program.builder().id(id).name("Programme " + code).code(code).cohort("71").build();
  }

  private static User user(int id) {
    return User.builder().id(id).username("u" + id).build();
  }

  @Nested
  class Lectures {

    @Test
    @DisplayName("findAll renvoie nombre et codes des programmes ; programs null → 0 et liste vide")
    void findAll_mappe_les_etablissements() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca",
          List.of(program(10, "GI"), program(11, "GE")));
      Establishment vide = establishment(2, "Vide", "vide.ca", null);
      when(establishmentRepository.findAll()).thenReturn(List.of(udes, vide));

      List<EstablishmentDTO> result = establishmentService.findAll();

      assertThat(result).hasSize(2);
      assertThat(result.get(0).getName()).isEqualTo("UdeS");
      assertThat(result.get(0).getDomainEmail()).isEqualTo("usherbrooke.ca");
      assertThat(result.get(0).getProgramCount()).isEqualTo(2);
      assertThat(result.get(0).getProgramCodes()).containsExactly("GI", "GE");
      assertThat(result.get(1).getProgramCount()).isZero();
      assertThat(result.get(1).getProgramCodes()).isEmpty();
    }

    @Test
    @DisplayName("getProgramsByEstablishment délègue chaque programme à ProgramService")
    void getProgramsByEstablishment_mappe_les_programmes() {
      Program gi = program(10, "GI");
      when(establishmentRepository.findById(1))
          .thenReturn(Optional.of(establishment(1, "UdeS", "usherbrooke.ca", List.of(gi))));
      ProgramDTO giDto = ProgramDTO.builder().id(10).code("GI").build();
      when(programService.toProgramDTO(gi)).thenReturn(giDto);

      assertThat(establishmentService.getProgramsByEstablishment(1)).containsExactly(giDto);
    }

    @Test
    @DisplayName("getProgramsByEstablishment : établissement inconnu → EstablishmentNotFoundException")
    void getProgramsByEstablishment_inconnu() {
      when(establishmentRepository.findById(9)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> establishmentService.getProgramsByEstablishment(9))
          .isInstanceOf(EstablishmentNotFoundException.class);
    }
  }

  @Nested
  class Create {

    @Test
    @DisplayName("Sauvegarde l'établissement, journalise ESTABLISHMENT_CREATE et émet establishmentUpserted")
    void cree_journalise_et_emet() {
      when(establishmentRepository.save(any())).thenAnswer(inv -> {
        Establishment e = inv.getArgument(0);
        e.setId(5);
        return e;
      });
      EstablishmentDTO dto = EstablishmentDTO.builder().name("Polytechnique").domainEmail("polymtl.ca").build();

      EstablishmentDTO result = establishmentService.create(dto);

      ArgumentCaptor<Establishment> captor = ArgumentCaptor.forClass(Establishment.class);
      verify(establishmentRepository).save(captor.capture());
      assertThat(captor.getValue().getName()).isEqualTo("Polytechnique");
      assertThat(captor.getValue().getDomainEmail()).isEqualTo("polymtl.ca");
      assertThat(result.getId()).isEqualTo(5);
      assertThat(result.getProgramCount()).isZero();
      verify(auditLogService).record(eq("ESTABLISHMENT_CREATE"), eq("ESTABLISHMENT"), eq(5),
          eq("Établissement « Polytechnique » créé"));
      verify(realtimePublisher).establishmentUpserted(5L, "Polytechnique", "polymtl.ca", 0, List.of());
    }
  }

  @Nested
  class AddProgramToEstablishment {

    private static final String CREATOR = "admin@test.ca";

    private User creator() {
      return User.builder().id(7).username("admin").email(CREATOR).build();
    }

    @Test
    @DisplayName("Crée le programme rattaché, y abonne le créateur, journalise et republie le catalogue")
    void cree_le_programme() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", new ArrayList<>());
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(userRepository.findByEmail(CREATOR)).thenReturn(Optional.of(creator()));
      when(programRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Program p = inv.getArgument(0);
        p.setId(20);
        return p;
      });
      ProgramDTO expected = ProgramDTO.builder().id(20).build();
      when(programService.toProgramDTO(any())).thenReturn(expected);
      ProgramCreateInEstablishmentDTO dto = ProgramCreateInEstablishmentDTO.builder()
          .establishmentId(1).name("Génie logiciel").code("GLO").cohort("72").color("#123456").build();

      ProgramDTO result = establishmentService.addProgramToEstablishment(dto, CREATOR);

      ArgumentCaptor<Program> captor = ArgumentCaptor.forClass(Program.class);
      verify(programRepository).saveAndFlush(captor.capture());
      Program saved = captor.getValue();
      assertThat(saved.getName()).isEqualTo("Génie logiciel");
      assertThat(saved.getCode()).isEqualTo("GLO");
      assertThat(saved.getCohort()).isEqualTo("72");
      assertThat(saved.getColor()).isEqualTo("#123456");
      assertThat(saved.getEstablishment()).isSameAs(udes);
      assertThat(result).isSameAs(expected);
      verify(auditLogService).record(eq("PROGRAM_CREATE"), eq("PROGRAM"), eq(20),
          eq("Programme « Génie logiciel » créé"), eq("Établissement : UdeS"));
      verify(programService).publishEstablishmentCatalog(1);

      // Le créateur (identité du token, pas un id de la requête) est abonné au programme créé,
      // APRÈS sa création et dans le même appel de service (même transaction).
      ArgumentCaptor<UserCreateInProgramsDTO> sub = ArgumentCaptor.forClass(UserCreateInProgramsDTO.class);
      org.mockito.InOrder ordre = org.mockito.Mockito.inOrder(programRepository, programService);
      ordre.verify(programRepository).saveAndFlush(any());
      ordre.verify(programService).addUserToPrograms(sub.capture());
      assertThat(sub.getValue().getId()).isEqualTo(7);
      assertThat(sub.getValue().getProgramIds()).containsExactly(20);
      assertThat(sub.getValue().getEstablishmentId()).isNull(); // ajout seul, aucun désabonnement
    }

    @Test
    @DisplayName("Créateur inconnu → UserNotFoundException, rien n'est créé")
    void createur_inconnu() {
      when(establishmentRepository.findById(1))
          .thenReturn(Optional.of(establishment(1, "UdeS", "usherbrooke.ca", new ArrayList<>())));
      when(userRepository.findByEmail(CREATOR)).thenReturn(Optional.empty());
      ProgramCreateInEstablishmentDTO dto =
          ProgramCreateInEstablishmentDTO.builder().establishmentId(1).name("X").code("X").build();

      assertThatThrownBy(() -> establishmentService.addProgramToEstablishment(dto, CREATOR))
          .isInstanceOf(UserNotFoundException.class);
      verify(programRepository, never()).saveAndFlush(any());
      verifyNoInteractions(auditLogService);
    }

    @Test
    @DisplayName("Abonnement en échec → l'exception remonte (transaction annulée), catalogue non republié")
    void abonnement_en_echec() {
      when(establishmentRepository.findById(1))
          .thenReturn(Optional.of(establishment(1, "UdeS", "usherbrooke.ca", new ArrayList<>())));
      when(userRepository.findByEmail(CREATOR)).thenReturn(Optional.of(creator()));
      when(programRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Program p = inv.getArgument(0);
        p.setId(20);
        return p;
      });
      org.mockito.Mockito.doThrow(new RuntimeException("boom"))
          .when(programService).addUserToPrograms(any());
      ProgramCreateInEstablishmentDTO dto =
          ProgramCreateInEstablishmentDTO.builder().establishmentId(1).name("X").code("X").build();

      assertThatThrownBy(() -> establishmentService.addProgramToEstablishment(dto, CREATOR))
          .hasMessage("boom");
      verify(programService, never()).publishEstablishmentCatalog(any());
    }

    @Test
    @DisplayName("Établissement inconnu → EstablishmentNotFoundException, rien n'est créé")
    void etablissement_inconnu() {
      when(establishmentRepository.findById(1)).thenReturn(Optional.empty());
      ProgramCreateInEstablishmentDTO dto =
          ProgramCreateInEstablishmentDTO.builder().establishmentId(1).build();

      assertThatThrownBy(() -> establishmentService.addProgramToEstablishment(dto, CREATOR))
          .isInstanceOf(EstablishmentNotFoundException.class);
      verify(programRepository, never()).saveAndFlush(any());
      verifyNoInteractions(auditLogService);
    }
  }

  @Nested
  class UpdateEstablishment {

    @Test
    @DisplayName("Met à jour nom et domaine, journalise et émet establishmentUpserted avec le catalogue")
    void met_a_jour_et_emet() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", List.of(program(10, "GI")));
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(establishmentRepository.save(udes)).thenReturn(udes);

      EstablishmentDTO result = establishmentService.updateEstablishment(1,
          EstablishmentUpdateDTO.builder().name("Université de Sherbrooke").domainEmail("udes.ca").build());

      assertThat(result.getName()).isEqualTo("Université de Sherbrooke");
      assertThat(result.getDomainEmail()).isEqualTo("udes.ca");
      verify(auditLogService).record(eq("ESTABLISHMENT_UPDATE"), eq("ESTABLISHMENT"), eq(1),
          eq("Établissement « Université de Sherbrooke » mis à jour"));
      verify(realtimePublisher).establishmentUpserted(1L, "Université de Sherbrooke", "udes.ca", 1, List.of("GI"));
    }

    @Test
    @DisplayName("Champs null : nom et domaine inchangés")
    void champs_null_inchanges() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", null);
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(establishmentRepository.save(udes)).thenReturn(udes);

      EstablishmentDTO result = establishmentService.updateEstablishment(1, new EstablishmentUpdateDTO());

      assertThat(result.getName()).isEqualTo("UdeS");
      assertThat(result.getDomainEmail()).isEqualTo("usherbrooke.ca");
      verify(realtimePublisher).establishmentUpserted(1L, "UdeS", "usherbrooke.ca", 0, List.of());
    }

    @Test
    @DisplayName("Établissement inconnu → EstablishmentNotFoundException, aucun écho")
    void etablissement_inconnu() {
      when(establishmentRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> establishmentService.updateEstablishment(1, new EstablishmentUpdateDTO()))
          .isInstanceOf(EstablishmentNotFoundException.class);
      verify(establishmentRepository, never()).save(any());
      verifyNoInteractions(realtimePublisher, auditLogService);
    }
  }

  @Nested
  class DeleteEstablishment {

    @Test
    @DisplayName("Supprime, journalise et émet programDeleted pour chaque (abonné, programme) puis establishmentDeleted")
    void supprime_et_emet_par_abonne() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", null);
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(programRepository.findProgramIdsByEstablishmentId(1)).thenReturn(List.of(10, 11));
      when(userRepository.findDistinctByPrograms_Id(10)).thenReturn(List.of(user(100), user(101)));
      when(userRepository.findDistinctByPrograms_Id(11)).thenReturn(List.of(user(100)));

      establishmentService.deleteEstablishment(1);

      verify(establishmentRepository).delete(udes);
      verify(auditLogService).record(eq("ESTABLISHMENT_DELETE"), eq("ESTABLISHMENT"), eq(1),
          eq("Établissement « UdeS » supprimé (#1)"));
      verify(realtimePublisher).programDeleted(100L, 10L);
      verify(realtimePublisher).programDeleted(101L, 10L);
      verify(realtimePublisher).programDeleted(100L, 11L);
      verify(realtimePublisher).establishmentDeleted(1L);
      // Les programmes ne sont pas supprimés par JPA (ON DELETE CASCADE côté BD).
      verify(programRepository, never()).delete(any());
    }

    @Test
    @DisplayName("Dans une transaction, establishmentDeleted n'est émis qu'APRÈS le commit")
    void echo_differe_apres_commit() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", null);
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(programRepository.findProgramIdsByEstablishmentId(1)).thenReturn(List.of());
      TransactionSynchronizationManager.initSynchronization();
      try {
        establishmentService.deleteEstablishment(1);
        verifyNoInteractions(realtimePublisher);

        TransactionSynchronizationManager.getSynchronizations()
            .forEach(TransactionSynchronization::afterCommit);
        verify(realtimePublisher).establishmentDeleted(1L);
      } finally {
        TransactionSynchronizationManager.clearSynchronization();
      }
    }

    @Test
    @DisplayName("Un échec de diffusion WS ne fait pas échouer la suppression (best-effort)")
    void echec_ws_ignore() {
      Establishment udes = establishment(1, "UdeS", "usherbrooke.ca", null);
      when(establishmentRepository.findById(1)).thenReturn(Optional.of(udes));
      when(programRepository.findProgramIdsByEstablishmentId(1)).thenReturn(List.of(10));
      when(userRepository.findDistinctByPrograms_Id(10)).thenReturn(List.of(user(100)));
      doThrow(new RuntimeException("WS en panne")).when(realtimePublisher).programDeleted(anyLong(), anyLong());

      assertThatCode(() -> establishmentService.deleteEstablishment(1)).doesNotThrowAnyException();

      verify(establishmentRepository).delete(udes);
      verify(auditLogService).record(eq("ESTABLISHMENT_DELETE"), any(), eq(1), any());
    }

    @Test
    @DisplayName("Établissement inconnu → EstablishmentNotFoundException, rien n'est supprimé")
    void etablissement_inconnu() {
      when(establishmentRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> establishmentService.deleteEstablishment(1))
          .isInstanceOf(EstablishmentNotFoundException.class);
      verify(establishmentRepository, never()).delete(any());
      verifyNoInteractions(realtimePublisher);
    }
  }
}
