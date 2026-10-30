package com.moodit.core_service.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.moodit.core_service.dto.CourseDTO;
import com.moodit.core_service.dto.CourseForumsDTO;
import com.moodit.core_service.dto.CourseProgramsDTO;
import com.moodit.core_service.dto.CourseUpdateDTO;
import com.moodit.core_service.dto.ForumDTO;
import com.moodit.core_service.dto.ProgramDTO;
import com.moodit.core_service.dto.QuizDTO;
import com.moodit.core_service.dto.UserCreateInCoursesDTO;
import com.moodit.core_service.exception.CourseNotFoundException;
import com.moodit.core_service.exception.ForumNotFoundException;
import com.moodit.core_service.exception.UserNotFoundException;
import com.moodit.core_service.model.Course;
import com.moodit.core_service.model.Enrollment;
import com.moodit.core_service.model.Establishment;
import com.moodit.core_service.model.FType;
import com.moodit.core_service.model.Forum;
import com.moodit.core_service.model.Program;
import com.moodit.core_service.model.Question;
import com.moodit.core_service.model.Quiz;
import com.moodit.core_service.model.User;
import com.moodit.core_service.realtime.RealtimeEventPublisher;
import com.moodit.core_service.realtime.dto.CourseDto;
import com.moodit.core_service.realtime.dto.ItemChangeDto;
import com.moodit.core_service.realtime.dto.ItemDto;
import com.moodit.core_service.repository.CourseRepository;
import com.moodit.core_service.repository.EnrollmentRepository;
import com.moodit.core_service.repository.ForumRepository;
import com.moodit.core_service.repository.UserRepository;
import java.time.LocalDateTime;
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
 * Tests unitaires de {@link CourseService} : dépôts, publisher temps réel et journal d'audit
 * mockés. Hors transaction, {@code afterCommit} exécute l'action tout de suite : les échos WS
 * sont donc vérifiables directement.
 */
@ExtendWith(MockitoExtension.class)
class CourseServiceTest {

  @Mock private CourseRepository courseRepository;
  @Mock private ForumRepository forumRepository;
  @Mock private ForumService forumService;
  @Mock private ProgramService programService;
  @Mock private UserRepository userRepository;
  @Mock private EnrollmentRepository enrollmentRepository;
  @Mock private RealtimeEventPublisher realtimePublisher;
  @Mock private AuditLogService auditLogService;

  @InjectMocks private CourseService courseService;

  // ── Fixtures ──────────────────────────────────────────────────────────────

  private static Establishment establishment(String name) {
    Establishment e = new Establishment();
    e.setName(name);
    return e;
  }

  private static Program program(int id, String name) {
    return Program.builder().id(id).name(name).code("P" + id).cohort("71").color("#000000")
        .establishment(establishment("UdeS")).build();
  }

  private static Course course(int id) {
    return Course.builder()
        .id(id)
        .title("Base de données")
        .code("IFT287")
        .forums(new ArrayList<>())
        .quizzes(new ArrayList<>())
        .programs(new ArrayList<>())
        .build();
  }

  private static FType fType(int id, String name) {
    FType t = new FType();
    t.setId(id);
    t.setName(name);
    return t;
  }

  private static Forum forum(int id, String title, int position, FType type, Course course) {
    Forum f = new Forum();
    f.setId(id);
    f.setTitle(title);
    f.setPosition(position);
    f.setFType(type);
    f.setCourse(course);
    return f;
  }

  private static Quiz quiz(int id, String title, Integer position, boolean published, int questions) {
    List<Question> qs = new ArrayList<>();
    for (int i = 0; i < questions; i++) qs.add(new Question());
    return Quiz.builder()
        .id(id)
        .title(title)
        .position(position)
        .isPublished(published)
        .isDaily(false)
        .allowRetry(true)
        .createdAt(LocalDateTime.of(2026, 1, 1, 0, 0))
        .questions(qs)
        .build();
  }

  private static User user(int id, String username) {
    return User.builder().id(id).username(username).email(id + "@test.ca")
        .enrollments(new ArrayList<>()).build();
  }

  private static Enrollment enrollment(User user, Course course) {
    Enrollment e = new Enrollment();
    e.setUser(user);
    e.setCourse(course);
    return e;
  }

  // ── Transformations ───────────────────────────────────────────────────────

  @Nested
  class Transformations {

    @Test
    @DisplayName("toCourseDTO copie id, titre et code")
    void toCourseDTO_copie_les_champs() {
      CourseDTO dto = courseService.toCourseDTO(course(7));

      assertThat(dto.getId()).isEqualTo(7);
      assertThat(dto.getTitle()).isEqualTo("Base de données");
      assertThat(dto.getCode()).isEqualTo("IFT287");
    }

    @Test
    @DisplayName("toCourseProgramsDTO délègue chaque programme à ProgramService")
    void toCourseProgramsDTO_mappe_les_programmes() {
      Course c = course(1);
      c.getPrograms().add(program(10, "Informatique"));
      c.getPrograms().add(program(11, "Électrique"));
      when(programService.toProgramDTO(any()))
          .thenAnswer(inv -> ProgramDTO.builder().id(((Program) inv.getArgument(0)).getId()).build());

      CourseProgramsDTO dto = courseService.toCourseProgramsDTO(c);

      assertThat(dto.getId()).isEqualTo(1);
      assertThat(dto.getTitle()).isEqualTo("Base de données");
      assertThat(dto.getCode()).isEqualTo("IFT287");
      assertThat(dto.getPrograms()).extracting(ProgramDTO::getId).containsExactly(10, 11);
    }

    @Test
    @DisplayName("toCourseForumsDTO ne liste que les quiz publiés, triés par position (null en dernier)")
    void toCourseForumsDTO_filtre_les_brouillons_et_trie() {
      Course c = course(1);
      c.getQuizzes().add(quiz(3, "Troisième", 2, true, 1));
      c.getQuizzes().add(quiz(2, "Brouillon", 0, false, 1));
      c.getQuizzes().add(quiz(1, "Premier", 1, true, 4));
      c.getQuizzes().add(quiz(4, "Sans position", null, true, 0));

      CourseForumsDTO dto = courseService.toCourseForumsDTO(c);

      assertThat(dto.getId()).isEqualTo(1);
      assertThat(dto.getTitle()).isEqualTo("Base de données");
      assertThat(dto.getCode()).isEqualTo("IFT287");
      assertThat(dto.getQuizzes()).extracting(QuizDTO::getTitle)
          .containsExactly("Premier", "Troisième", "Sans position");
      assertThat(dto.getQuizzes().get(0).getQuestionCount()).isEqualTo(4);
      assertThat(dto.getForums()).isEmpty();
    }

    @Test
    @DisplayName("toCourseForumsDTO : quizzes null → liste vide, forums délégués à ForumService")
    void toCourseForumsDTO_quizzes_null_donne_liste_vide() {
      Course c = course(1);
      c.setQuizzes(null);
      Forum f = forum(5, "Général", 0, fType(1, "Discussion"), c);
      c.getForums().add(f);
      ForumDTO forumDto = ForumDTO.builder().id(5).title("Général").build();
      when(forumService.toForumDTO(f)).thenReturn(forumDto);

      CourseForumsDTO dto = courseService.toCourseForumsDTO(c);

      assertThat(dto.getQuizzes()).isEmpty();
      assertThat(dto.getForums()).containsExactly(forumDto);
    }

    @Test
    @DisplayName("toQuizDTO : questions null → questionCount 0")
    void toQuizDTO_questions_null_donne_zero() {
      Quiz q = quiz(1, "Q", 0, true, 0);
      q.setQuestions(null);

      q.setIsDaily(true);
      q.setPosition(6);
      QuizDTO dto = courseService.toQuizDTO(q);

      assertThat(dto.getId()).isEqualTo(1);
      assertThat(dto.getPosition()).isEqualTo(6);
      assertThat(dto.getIsDaily()).isTrue();
      assertThat(dto.getCreatedAt()).isEqualTo(LocalDateTime.of(2026, 1, 1, 0, 0));
      assertThat(dto.getQuestionCount()).isZero();
      assertThat(dto.getTitle()).isEqualTo("Q");
      assertThat(dto.getIsPublished()).isTrue();
      assertThat(dto.getAllowRetry()).isTrue();
    }
  }

  // ── Lectures ──────────────────────────────────────────────────────────────

  @Nested
  class Lectures {

    @Test
    @DisplayName("findById retourne le DTO du cours")
    void findById_retourne_le_cours() {
      when(courseRepository.findById(3)).thenReturn(Optional.of(course(3)));

      CourseDTO dto = courseService.findById(3);

      assertThat(dto.getId()).isEqualTo(3);
      assertThat(dto.getCode()).isEqualTo("IFT287");
      assertThat(dto.getProgramIds()).isEmpty();
    }

    @Test
    @DisplayName("findById renvoie les ids des programmes du cours (pré-remplissage de « Modifier le cours »)")
    void findById_renvoie_les_programmes() {
      Course c = course(3);
      c.getPrograms().add(program(10, "Informatique"));
      c.getPrograms().add(program(11, "Électrique"));
      when(courseRepository.findById(3)).thenReturn(Optional.of(c));

      assertThat(courseService.findById(3).getProgramIds()).containsExactly(10, 11);
    }

    @Test
    @DisplayName("findById lance CourseNotFoundException si le cours n'existe pas")
    void findById_cours_inconnu_lance_exception() {
      when(courseRepository.findById(99)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.findById(99))
          .isInstanceOf(CourseNotFoundException.class);
    }

    @Test
    @DisplayName("getForumsByCourseId recharge chaque forum via ForumService.findById")
    void getForumsByCourseId_delegue_a_forumService() {
      Course c = course(1);
      c.getForums().add(forum(5, "A", 0, fType(1, "Discussion"), c));
      c.getForums().add(forum(6, "B", 1, fType(2, "Thread"), c));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumService.findById(5)).thenReturn(ForumDTO.builder().id(5).build());
      when(forumService.findById(6)).thenReturn(ForumDTO.builder().id(6).build());

      List<ForumDTO> result = courseService.getForumsByCourseId(1);

      assertThat(result).extracting(ForumDTO::getId).containsExactly(5, 6);
    }

    @Test
    @DisplayName("getForumsByCourseId : cours inconnu → CourseNotFoundException")
    void getForumsByCourseId_cours_inconnu() {
      when(courseRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.getForumsByCourseId(1))
          .isInstanceOf(CourseNotFoundException.class);
      verifyNoInteractions(forumService);
    }

    @Test
    @DisplayName("getForumsByCourseAndType filtre sur le type ; typeId null = tous")
    void getForumsByCourseAndType_filtre_par_type() {
      Course c = course(1);
      c.getForums().add(forum(5, "A", 0, fType(1, "Discussion"), c));
      c.getForums().add(forum(6, "B", 1, fType(2, "Thread"), c));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumService.toForumDTO(any()))
          .thenAnswer(inv -> ForumDTO.builder().id(((Forum) inv.getArgument(0)).getId()).build());

      assertThat(courseService.getForumsByCourseAndType(1, 2))
          .extracting(ForumDTO::getId).containsExactly(6);
      assertThat(courseService.getForumsByCourseAndType(1, null))
          .extracting(ForumDTO::getId).containsExactly(5, 6);
    }

    @Test
    @DisplayName("getForumByIdInCourse retourne le forum du cours et échoue s'il n'y est pas")
    void getForumByIdInCourse_retrouve_ou_echoue() {
      Course c = course(1);
      c.getForums().add(forum(5, "A", 0, fType(1, "Discussion"), c));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumService.findById(5)).thenReturn(ForumDTO.builder().id(5).build());

      assertThat(courseService.getForumByIdInCourse(1, 5).getId()).isEqualTo(5);
      // Forum hors du cours : refusé (détail du type d'exception dans le test suivant).
      assertThatThrownBy(() -> courseService.getForumByIdInCourse(1, 42))
          .isInstanceOf(RuntimeException.class);
    }

    // Forum hors du cours : ForumNotFoundException (→ 404 par GlobalExceptionHandler), comme
    // changeSection/forumInCourse, et non une RuntimeException générique (→ 500).
    @Test
    @DisplayName("getForumByIdInCourse : forum hors du cours → ForumNotFoundException (404)")
    void getForumByIdInCourse_forum_hors_cours_devrait_lancer_ForumNotFound() {
      Course c = course(1);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      assertThatThrownBy(() -> courseService.getForumByIdInCourse(1, 42))
          .isInstanceOf(ForumNotFoundException.class);
    }
  }

  // ── addForumToCourse ──────────────────────────────────────────────────────

  @Nested
  class AddForumToCourse {

    @Test
    @DisplayName("Crée un forum rattaché au cours avec le bon type et la position demandée")
    void cree_le_forum_et_le_sauvegarde() {
      Course c = course(1);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumRepository.save(any())).thenAnswer(inv -> inv.getArgument(0));
      when(forumService.toForumDTO(any()))
          .thenAnswer(inv -> ForumDTO.builder().title(((Forum) inv.getArgument(0)).getTitle()).build());
      ForumDTO dto = ForumDTO.builder().courseId(1).title("Devoirs").fTypeId(2).position(3).build();

      ForumDTO result = courseService.addForumToCourse(dto);

      ArgumentCaptor<Forum> captor = ArgumentCaptor.forClass(Forum.class);
      verify(forumRepository).save(captor.capture());
      Forum saved = captor.getValue();
      assertThat(saved.getTitle()).isEqualTo("Devoirs");
      assertThat(saved.getCourse()).isSameAs(c);
      assertThat(saved.getFType().getId()).isEqualTo(2);
      assertThat(saved.getPosition()).isEqualTo(3);
      assertThat(result.getTitle()).isEqualTo("Devoirs");
    }

    @Test
    @DisplayName("Cours inconnu → CourseNotFoundException, rien n'est sauvegardé")
    void cours_inconnu_ne_sauvegarde_rien() {
      when(courseRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.addForumToCourse(ForumDTO.builder().courseId(1).build()))
          .isInstanceOf(CourseNotFoundException.class);
      verify(forumRepository, never()).save(any());
    }
  }

  // ── updateCourse ──────────────────────────────────────────────────────────

  @Nested
  class UpdateCourse {

    @Test
    @DisplayName("Met à jour titre, code et programmes, journalise ; temps réel : gardé → edited, ajouté → created, retiré → deleted")
    void met_a_jour_journalise_et_emet() {
      Course c = course(1);
      Program p10 = program(10, "Informatique");
      Program p11 = program(11, "Électrique");
      Program p12 = program(12, "Mécanique");
      p10.setCourses(new java.util.ArrayList<>(List.of(c)));
      p12.setCourses(new java.util.ArrayList<>(List.of(c)));
      c.getPrograms().add(p10);
      c.getPrograms().add(p12);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(courseRepository.save(c)).thenReturn(c);
      when(programService.findProgramById(10)).thenReturn(p10);
      when(programService.findProgramById(11)).thenReturn(p11);
      CourseUpdateDTO dto = CourseUpdateDTO.builder()
          .title("Nouveau titre").code("IFT999").programIds(List.of(10, 11)).build();

      CourseDTO result = courseService.updateCourse(1, dto);

      assertThat(result.getTitle()).isEqualTo("Nouveau titre");
      assertThat(result.getCode()).isEqualTo("IFT999");
      assertThat(c.getPrograms()).containsExactly(p10, p11);
      verify(auditLogService).record(eq("COURSE_UPDATE"), eq("COURSE"), eq(1),
          contains("Nouveau titre"), contains("Informatique"));
      ArgumentCaptor<CourseDto> captor = ArgumentCaptor.forClass(CourseDto.class);
      verify(realtimePublisher).courseEdited(eq(10L), captor.capture()); // gardé
      verify(realtimePublisher).courseCreated(eq(11L), any());            // ajouté : le cours y apparaît
      verify(realtimePublisher).courseDeleted(12L, 1L);                   // retiré : le cours y disparaît
      verify(realtimePublisher, org.mockito.Mockito.never()).courseEdited(eq(11L), any());
      verify(realtimePublisher, org.mockito.Mockito.never()).courseEdited(eq(12L), any());
      assertThat(captor.getValue().id()).isEqualTo(1L);
      assertThat(captor.getValue().code()).isEqualTo("IFT999");
      assertThat(captor.getValue().title()).isEqualTo("Nouveau titre");
    }

    @Test
    @DisplayName("programIds vide → refusé (400) : le cours resterait sans programme, rien n'est écrit ni émis")
    void programIds_vide_refuse() {
      Course c = course(1);
      Program p10 = program(10, "Informatique");
      p10.setCourses(new java.util.ArrayList<>(List.of(c)));
      c.getPrograms().add(p10);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      org.assertj.core.api.Assertions.assertThatThrownBy(() ->
              courseService.updateCourse(1, CourseUpdateDTO.builder().programIds(List.of()).build()))
          .isInstanceOf(com.moodit.core_service.exception.InvalidCourseException.class)
          .hasMessage("Un cours doit rester rattaché à au moins un programme.");
      assertThat(p10.getCourses()).containsExactly(c);
      verify(courseRepository, org.mockito.Mockito.never()).save(any());
      verifyNoInteractions(auditLogService, realtimePublisher);
    }

    @Test
    @DisplayName("programIds met à jour le côté propriétaire : programme retiré et programme ajouté")
    void programIds_met_a_jour_le_cote_proprietaire() {
      // Course.programs est le côté inverse (mappedBy) : seul Program.courses écrit
      // program_course. Sans cette mise à jour, le PATCH était ignoré en base.
      Course c = course(1);
      Program garde = program(10, "Informatique");
      Program retire = program(12, "Mécanique");
      Program ajoute = program(11, "Électrique");
      garde.setCourses(new java.util.ArrayList<>(List.of(c)));
      retire.setCourses(new java.util.ArrayList<>(List.of(c)));
      ajoute.setCourses(new java.util.ArrayList<>());
      c.getPrograms().add(garde);
      c.getPrograms().add(retire);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(courseRepository.save(c)).thenReturn(c);
      when(programService.findProgramById(10)).thenReturn(garde);
      when(programService.findProgramById(11)).thenReturn(ajoute);

      courseService.updateCourse(1, CourseUpdateDTO.builder().programIds(List.of(10, 11)).build());

      assertThat(garde.getCourses()).containsExactly(c); // pas de doublon
      assertThat(ajoute.getCourses()).containsExactly(c);
      assertThat(retire.getCourses()).isEmpty();
      assertThat(c.getPrograms()).containsExactly(garde, ajoute);
    }

    @Test
    @DisplayName("Champs null du DTO : l'entité garde ses valeurs et ses programmes")
    void champs_null_conserves() {
      Course c = course(1);
      Program p10 = program(10, "Informatique");
      c.getPrograms().add(p10);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(courseRepository.save(c)).thenReturn(c);

      CourseDTO result = courseService.updateCourse(1, new CourseUpdateDTO());

      assertThat(result.getTitle()).isEqualTo("Base de données");
      assertThat(result.getCode()).isEqualTo("IFT287");
      assertThat(c.getPrograms()).containsExactly(p10);
      verify(programService, never()).findProgramById(anyInt());
      verify(realtimePublisher).courseEdited(eq(10L), any());
    }

    @Test
    @DisplayName("Cours inconnu → CourseNotFoundException, ni audit ni écho WS")
    void cours_inconnu() {
      when(courseRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.updateCourse(1, new CourseUpdateDTO()))
          .isInstanceOf(CourseNotFoundException.class);
      verifyNoInteractions(auditLogService, realtimePublisher);
    }
  }

  // ── deleteCourse ──────────────────────────────────────────────────────────

  @Nested
  class DeleteCourse {

    @Test
    @DisplayName("Supprime le cours, journalise le contexte capturé et émet courseDeleted par programme")
    void supprime_journalise_et_emet() {
      Course c = course(1);
      c.getPrograms().add(program(10, "Informatique"));
      c.getPrograms().add(program(11, "Électrique"));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      courseService.deleteCourse(1);

      verify(courseRepository).delete(c);
      verify(auditLogService).record(eq("COURSE_DELETE"), eq("COURSE"), eq(1),
          contains("Base de données"), contains("Informatique"));
      verify(realtimePublisher).courseDeleted(10L, 1L);
      verify(realtimePublisher).courseDeleted(11L, 1L);
    }

    @Test
    @DisplayName("Dans une transaction, courseDeleted n'est émis qu'APRÈS le commit")
    void echo_differe_apres_commit() {
      Course c = course(1);
      c.getPrograms().add(program(10, "Informatique"));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      TransactionSynchronizationManager.initSynchronization();
      try {
        courseService.deleteCourse(1);
        verifyNoInteractions(realtimePublisher);

        TransactionSynchronizationManager.getSynchronizations()
            .forEach(TransactionSynchronization::afterCommit);
        verify(realtimePublisher).courseDeleted(10L, 1L);
      } finally {
        TransactionSynchronizationManager.clearSynchronization();
      }
    }

    @Test
    @DisplayName("Cours sans programme (programs null) : suppression, détails null, sans écho WS")
    void sans_programme_pas_d_echo() {
      Course c = course(1);
      c.setPrograms(null);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      courseService.deleteCourse(1);

      verify(courseRepository).delete(c);
      verify(auditLogService).record(eq("COURSE_DELETE"), eq("COURSE"), eq(1), any(), isNull());
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("Cours inconnu → CourseNotFoundException, rien n'est supprimé")
    void cours_inconnu() {
      when(courseRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.deleteCourse(1))
          .isInstanceOf(CourseNotFoundException.class);
      verify(courseRepository, never()).delete(any());
    }
  }

  // ── changeSection ─────────────────────────────────────────────────────────

  @Nested
  class ChangeSection {

    private Course courseWithForums() {
      Course c = course(1);
      c.getPrograms().add(program(10, "Informatique"));
      c.getForums().add(forum(5, "Général", 0, fType(1, "Discussion"), c));
      c.getForums().add(forum(6, "Entraide", 4, fType(1, "Discussion"), c));
      c.getForums().add(forum(7, "Questions", 2, fType(2, "Thread"), c));
      return c;
    }

    @Test
    @DisplayName("create (text) : forum Discussion en fin de section, id réel renvoyé, audit + WS")
    void create_text_ajoute_en_fin_de_section() {
      Course c = courseWithForums();
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Forum f = inv.getArgument(0);
        f.setId(42);
        return f;
      });

      ItemChangeDto result = courseService.changeSection(1, "text",
          ItemChangeDto.create(new ItemDto("tmp-uuid", "Nouveau canal")));

      ArgumentCaptor<Forum> captor = ArgumentCaptor.forClass(Forum.class);
      verify(forumRepository).saveAndFlush(captor.capture());
      Forum saved = captor.getValue();
      assertThat(saved.getFType().getId()).isEqualTo(1);
      assertThat(saved.getPosition()).as("max(position des Discussion) = 4 → 5").isEqualTo(5);
      assertThat(saved.getCourse()).isSameAs(c);
      assertThat(c.getForums()).hasSize(4).last().isSameAs(saved);
      assertThat(result.type()).isEqualTo("create");
      assertThat(result.item().id()).as("id RÉEL, pas l'id temporaire").isEqualTo("42");
      assertThat(result.item().name()).isEqualTo("Nouveau canal");
      verify(auditLogService).record(eq("FORUM_CREATE"), eq("FORUM"), eq(42),
          contains("Nouveau canal"), contains("Cours : Base de données (IFT287)"));
      verify(realtimePublisher).sectionChanged(10L, 1L, "text", result);
    }

    @Test
    @DisplayName("Canal d'annonces : ni supprimé, ni renommé, ni déplacé par l'API des sections")
    void annonces_protegees_contre_les_sections() {
      Course c = courseWithForums();
      Forum annonces = forum(11, "Annonces", 0, fType(3, "Announcement"), c);
      c.getForums().add(annonces);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      assertThatThrownBy(() -> courseService.changeSection(1, "text", ItemChangeDto.delete("11")))
          .isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> courseService.changeSection(1, "forum", ItemChangeDto.rename("11", "X")))
          .isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> courseService.changeSection(1, "text", ItemChangeDto.reorder(List.of("11", "5"))))
          .isInstanceOf(ForumNotFoundException.class);

      assertThat(c.getForums()).contains(annonces);
      assertThat(annonces.getTitle()).isEqualTo("Annonces");
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("create (text) : les positions des AUTRES sections sont ignorées pour le calcul")
    void create_text_ignore_les_autres_sections() {
      Course c = courseWithForums();
      // Un Thread très loin dans SA section ne doit pas décaler la section Discussion.
      c.getForums().add(forum(8, "Thread lointain", 9, fType(2, "Thread"), c));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Forum f = inv.getArgument(0);
        f.setId(43);
        return f;
      });

      courseService.changeSection(1, "text", ItemChangeDto.create(new ItemDto("tmp", "Autre canal")));

      ArgumentCaptor<Forum> captor = ArgumentCaptor.forClass(Forum.class);
      verify(forumRepository).saveAndFlush(captor.capture());
      assertThat(captor.getValue().getPosition()).isEqualTo(5);
    }

    @Test
    @DisplayName("create (forum) : type Thread ; section vide → position 0 ; sans programme, pas d'écho")
    void create_forum_section_vide_position_zero() {
      Course c = course(1);
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));
      when(forumRepository.saveAndFlush(any())).thenAnswer(inv -> {
        Forum f = inv.getArgument(0);
        f.setId(1);
        return f;
      });

      courseService.changeSection(1, "forum", ItemChangeDto.create(new ItemDto("x", "Sujets")));

      ArgumentCaptor<Forum> captor = ArgumentCaptor.forClass(Forum.class);
      verify(forumRepository).saveAndFlush(captor.capture());
      assertThat(captor.getValue().getFType().getId()).isEqualTo(2);
      assertThat(captor.getValue().getPosition()).isZero();
      verifyNoInteractions(realtimePublisher);
    }

    @Test
    @DisplayName("rename : renomme le forum du cours, journalise et renvoie le changement")
    void rename_renomme_et_journalise() {
      Course c = courseWithForums();
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      ItemChangeDto result = courseService.changeSection(1, "text", ItemChangeDto.rename("6", "Aide"));

      Forum renamed = c.getForums().get(1);
      assertThat(renamed.getTitle()).isEqualTo("Aide");
      verify(forumRepository).save(renamed);
      verify(auditLogService).record(eq("FORUM_RENAME"), eq("FORUM"), eq(6), contains("Aide"), any());
      assertThat(result).isEqualTo(ItemChangeDto.rename("6", "Aide"));
      verify(realtimePublisher).sectionChanged(10L, 1L, "text", result);
    }

    @Test
    @DisplayName("delete : retire le forum de la collection managée (orphanRemoval), sans forumRepository.delete")
    void delete_retire_de_la_collection() {
      Course c = courseWithForums();
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      ItemChangeDto result = courseService.changeSection(1, "forum", ItemChangeDto.delete("7"));

      assertThat(c.getForums()).extracting(Forum::getId).containsExactly(5, 6);
      verify(forumRepository, never()).delete(any());
      verify(auditLogService).record(eq("FORUM_DELETE"), eq("FORUM"), eq(7), contains("#7"), any());
      assertThat(result).isEqualTo(ItemChangeDto.delete("7"));
      verify(realtimePublisher).sectionChanged(10L, 1L, "forum", result);
    }

    @Test
    @DisplayName("reorder : réassigne les positions 0..n dans l'ordre reçu, sans audit")
    void reorder_reassigne_les_positions() {
      Course c = courseWithForums();
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      ItemChangeDto result =
          courseService.changeSection(1, "text", ItemChangeDto.reorder(List.of("6", "5")));

      assertThat(c.getForums().get(1).getPosition()).as("forum 6 en premier").isZero();
      assertThat(c.getForums().get(0).getPosition()).as("forum 5 en second").isEqualTo(1);
      verify(forumRepository).save(c.getForums().get(0));
      verify(forumRepository).save(c.getForums().get(1));
      assertThat(result.orderedIds()).containsExactly("6", "5");
      verifyNoInteractions(auditLogService);
    }

    @Test
    @DisplayName("Forum absent du cours ou id non numérique → ForumNotFoundException")
    void forum_introuvable() {
      Course c = courseWithForums();
      when(courseRepository.findById(1)).thenReturn(Optional.of(c));

      assertThatThrownBy(() -> courseService.changeSection(1, "text", ItemChangeDto.rename("99", "X")))
          .isInstanceOf(ForumNotFoundException.class);
      assertThatThrownBy(() -> courseService.changeSection(1, "text", ItemChangeDto.delete("tmp-uuid")))
          .isInstanceOf(ForumNotFoundException.class);
      verifyNoInteractions(auditLogService, realtimePublisher);
    }

    @Test
    @DisplayName("Type de changement inconnu → IllegalArgumentException")
    void type_inconnu() {
      when(courseRepository.findById(1)).thenReturn(Optional.of(courseWithForums()));

      assertThatThrownBy(() -> courseService.changeSection(1, "text",
              new ItemChangeDto("explode", null, null, null, null)))
          .isInstanceOf(IllegalArgumentException.class)
          .hasMessageContaining("explode");
    }

    @Test
    @DisplayName("Cours inconnu → CourseNotFoundException")
    void cours_inconnu() {
      when(courseRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.changeSection(1, "text", ItemChangeDto.delete("5")))
          .isInstanceOf(CourseNotFoundException.class);
    }
  }

  // ── syncUserCourses ───────────────────────────────────────────────────────

  @Nested
  class SyncUserCourses {

    private UserCreateInCoursesDTO dto(int userId, List<Integer> courseIds, Integer programId) {
      UserCreateInCoursesDTO d = new UserCreateInCoursesDTO();
      d.setId(userId);
      d.setCourseIds(courseIds);
      d.setProgramId(programId);
      return d;
    }

    @Test
    @DisplayName("Ajoute les inscriptions manquantes (sans doublon) et journalise ENROLLMENT_JOIN")
    void ajoute_les_inscriptions_manquantes() {
      User u = user(1, "alice");
      Course c1 = course(1);
      Course c2 = course(2);
      c2.setTitle("Réseaux");
      u.getEnrollments().add(enrollment(u, c1));
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(courseRepository.findById(2)).thenReturn(Optional.of(c2));

      List<CourseDTO> result = courseService.syncUserCourses(dto(1, List.of(1, 2, 2), null));

      assertThat(u.getEnrollments()).hasSize(2);
      Enrollment added = u.getEnrollments().get(1);
      assertThat(added.getCourse()).isSameAs(c2);
      assertThat(added.getUser()).isSameAs(u);
      assertThat(added.getEnrolledAt()).isNotNull();
      assertThat(result).extracting(CourseDTO::getId).containsExactly(1, 2);
      verify(userRepository).save(u);
      verify(auditLogService).record(eq("ENROLLMENT_JOIN"), eq("ENROLLMENT"), eq(2),
          contains("Réseaux"), contains("Utilisateur : alice"));
      verify(auditLogService, never()).record(eq("ENROLLMENT_LEAVE"), any(), any(), any(), any());
    }

    @Test
    @DisplayName("Désélection : retire les inscriptions du programme non demandées, garde celles des autres programmes")
    void desinscrit_seulement_dans_le_programme() {
      User u = user(1, "alice");
      Course inProgram = course(1);
      // Partagé avec un autre programme placé AVANT : le suffixe doit nommer le programme demandé.
      inProgram.getPrograms().add(program(30, "Génie civil"));
      inProgram.getPrograms().add(program(10, "Informatique"));
      Course otherProgram = course(2);
      otherProgram.getPrograms().add(program(20, "Électrique"));
      u.getEnrollments().add(enrollment(u, inProgram));
      u.getEnrollments().add(enrollment(u, otherProgram));
      when(userRepository.findById(1)).thenReturn(Optional.of(u));

      List<CourseDTO> result = courseService.syncUserCourses(dto(1, List.of(), 10));

      assertThat(result).extracting(CourseDTO::getId).containsExactly(2);
      // Suffixe « Programme : <nom> » résolu depuis les programmes du cours.
      verify(auditLogService).record(eq("ENROLLMENT_LEAVE"), eq("ENROLLMENT"), eq(1),
          any(), contains(AuditContext.SEP + "Programme : Informatique"));
      verify(auditLogService, never()).record(any(), any(), eq(2), any(), any());
      verify(courseRepository, never()).findById(anyInt());
    }

    @Test
    @DisplayName("programId null = portée globale : toute inscription non demandée est retirée, sans suffixe programme")
    void programId_null_portee_globale() {
      User u = user(1, "alice");
      Course c1 = course(1);
      c1.getPrograms().add(program(10, "Informatique"));
      Course c2 = course(2);
      u.getEnrollments().add(enrollment(u, c1));
      u.getEnrollments().add(enrollment(u, c2));
      when(userRepository.findById(1)).thenReturn(Optional.of(u));

      List<CourseDTO> result = courseService.syncUserCourses(dto(1, null, null));

      assertThat(result).isEmpty();
      assertThat(u.getEnrollments()).isEmpty();
      ArgumentCaptor<String> details = ArgumentCaptor.forClass(String.class);
      verify(auditLogService).record(eq("ENROLLMENT_LEAVE"), any(), eq(1), any(), details.capture());
      assertThat(details.getValue()).endsWith("Utilisateur : alice");
      verify(auditLogService).record(eq("ENROLLMENT_LEAVE"), any(), eq(2), any(), any());
    }

    @Test
    @DisplayName("Programme absent du cours : suffixe de repli « Programme #id » ; sans username → « #id »")
    void suffixe_programme_inconnu() {
      User u = user(1, null);
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(courseRepository.findById(1)).thenReturn(Optional.of(course(1)));

      courseService.syncUserCourses(dto(1, List.of(1), 77));

      verify(auditLogService).record(eq("ENROLLMENT_JOIN"), any(), eq(1), any(),
          contains("Utilisateur : #1" + AuditContext.SEP + "Programme #77"));
    }

    @Test
    @DisplayName("Utilisateur ou cours inconnu → exception, rien n'est sauvegardé")
    void utilisateur_ou_cours_inconnu() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());
      assertThatThrownBy(() -> courseService.syncUserCourses(dto(1, List.of(1), null)))
          .isInstanceOf(UserNotFoundException.class);

      when(userRepository.findById(2)).thenReturn(Optional.of(user(2, "bob")));
      when(courseRepository.findById(9)).thenReturn(Optional.empty());
      assertThatThrownBy(() -> courseService.syncUserCourses(dto(2, List.of(9), null)))
          .isInstanceOf(CourseNotFoundException.class);

      verify(userRepository, never()).save(any());
    }
  }

  // ── removeUserFromCourse ──────────────────────────────────────────────────

  @Nested
  class RemoveUserFromCourse {

    @Test
    @DisplayName("Retire seulement l'inscription au cours ciblé et journalise ENROLLMENT_LEAVE")
    void retire_l_inscription_ciblee() {
      User u = user(1, "alice");
      Course c1 = course(1);
      Course c2 = course(2);
      u.getEnrollments().add(enrollment(u, c1));
      u.getEnrollments().add(enrollment(u, c2));
      when(userRepository.findById(1)).thenReturn(Optional.of(u));
      when(courseRepository.findById(1)).thenReturn(Optional.of(c1));

      courseService.removeUserFromCourse(1, 1);

      assertThat(u.getEnrollments()).extracting(e -> e.getCourse().getId()).containsExactly(2);
      verify(userRepository).save(u);
      verify(auditLogService).record(eq("ENROLLMENT_LEAVE"), eq("ENROLLMENT"), eq(1),
          contains("« Base de données » (IFT287)"), contains("Utilisateur : alice"));
    }

    @Test
    @DisplayName("Cours déjà supprimé : libellés de repli « #id », pas d'exception")
    void cours_absent_libelle_de_repli() {
      when(userRepository.findById(1)).thenReturn(Optional.of(user(1, "alice")));
      when(courseRepository.findById(5)).thenReturn(Optional.empty());

      courseService.removeUserFromCourse(5, 1);

      verify(auditLogService).record(eq("ENROLLMENT_LEAVE"), eq("ENROLLMENT"), eq(5),
          eq("Désinscription du cours #5"), eq("Cours : #5" + AuditContext.SEP + "Utilisateur : alice"));
    }

    @Test
    @DisplayName("Utilisateur inconnu → UserNotFoundException, aucun audit")
    void utilisateur_inconnu() {
      when(userRepository.findById(1)).thenReturn(Optional.empty());

      assertThatThrownBy(() -> courseService.removeUserFromCourse(1, 1))
          .isInstanceOf(UserNotFoundException.class);
      verifyNoInteractions(auditLogService);
    }
  }
}
