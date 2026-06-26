import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProgramMenu, { type Program } from '../../components/ProgramMenu/ProgramMenu.tsx';
import { useProgramsLoader } from '../../components/ProgramMenu/useProgramsLoader.ts';
import CourseMenu, { type Course } from '../../components/CourseMenu/CourseMenu.tsx';
import { useCoursesLoader } from '../../components/CourseMenu/useCoursesLoader.ts';
import { CourseSectionEditor } from '../../components/CourseMenu/CourseSectionEditor.tsx';
import { Spinner } from '../../components/Spinner/Spinner.tsx';
import {
  type ChannelMessageAuthor,
  type ChannelRef,
  type ChannelTypeDefinition,
  type CourseChannel,
  isSameChannel,
} from '../../components/CourseChannelList/CourseChannelList.tsx';
import { defaultTypeDefinitions } from '../../components/CourseChannelList/channelTypeDefinitions.ts';
import { AddCoursePopup, type NewCourse } from '../../components/AddCoursePopup/AddCoursePopup.tsx';
import { JoinCoursesPopup } from '../../components/JoinCoursesPopup/JoinCoursesPopup.tsx';
import { McpManagementPopup } from '../../components/McpManagementPopup/McpManagementPopup.tsx';
import {
  AddSubscriptionPopup,
  type JoinSelection,
  type NewProgram,
} from '../../components/AddSubscriptionPopup/AddSubscriptionPopup.tsx';
import {
  UpdateCoursePopup,
  type CourseUpdate,
} from '../../components/UpdateCoursePopup/UpdateCoursePopup.tsx';
import {
  UpdateProgramPopup,
  type ProgramUpdate,
} from '../../components/UpdateProgramPopup/UpdateProgramPopup.tsx';
import { EditProfilePopup } from '../../components/EditProfilePopup/EditProfilePopup.tsx';
import {
  RoleEditorPopup,
  type Role,
  type RoleChange,
  type User,
} from '../../components/RoleEditorPopup/RoleEditorPopup.tsx';
import { DeleteConfirmationPopup } from '../../components/DeleteConfirmationPopup/DeleteConfirmationPopup.tsx';
import { ErrorPopup } from '../../components/ErrorPopup/ErrorPopup.tsx';
import { ChannelTypeIcon } from '../../components/CourseChannelList/ChannelTypeIcon.tsx';
import { type ItemChange } from '../../components/SectionEditorPopup/types.ts';

// Client WebSocket réel : UNE seule connexion sert le chat, le forum, les cours et
// les programmes (quatre facades) — étape [5] du HANDOFF.
import { createAppSocket } from '../../services/appSocket.ts';
import { getToken } from '../../helpers/auth.ts';
import { useCurrentUser } from '../../context/currentUserContext.ts';
import * as api from './dashboardApi.ts';
import { type QuizEditorHandlers } from '../../components/QuizEditor/editorTypes.ts';
import UserMenu, { type UserMenuUser } from '../../components/UserMenu/UserMenu.tsx';
import LeftMenuGroup from '../../components/LeftMenuGroup/LeftMenuGroup.tsx';
import {
  normalizeCourseChannelsFromSources,
  type ForumChannelSource,
  type ForumType,
  type QuizChannelSource,
} from '../../components/CourseChannelList/courseChannelSources.ts';
import MainPanel from '../../components/MainPanel/MainPanel.tsx';
import { type DemoProgram } from './dashboardApi.ts';
import styles from './Dashboard.module.css';

/**
 * Câblage des callbacks de l'éditeur de quiz sur la couche API (`dashboardApi`).
 * Assemblage côté consommateur : l'éditeur reste « API-ready » (remplacer les corps
 * mock des fonctions `api.*` par des apiFetch suffit, sans toucher à ce mapping).
 */
const quizEditorHandlers: QuizEditorHandlers = {
  onFetchQuiz: api.fetchQuiz,
  onFetchQuizzes: api.fetchQuizzes,
  onFetchLanguages: api.fetchLanguages,
  onFetchQuestionTypes: api.fetchQuestionTypes,
  onCreateQuiz: api.createQuiz,
  onUpdateQuiz: api.updateQuiz,
  onDeleteQuiz: api.deleteQuiz,
  onReorderQuizzes: api.reorderQuizzes,
  onEvaluateCode: api.evaluateCode,
};

/** Popup ouvert dans le Dashboard, avec le contexte nécessaire à son rendu. */
type PopupState =
  | { kind: 'addCourse'; programId: number } // programId = programme préselectionné
  | { kind: 'addSubscription' }
  | { kind: 'editCourse'; courseId: number }
  | { kind: 'editProfile' }
  | { kind: 'editProgram'; programId: number }
  | { kind: 'manageRoles'; programId: number }
  | { kind: 'leaveProgram'; programId: number }
  | { kind: 'leaveCourse'; courseId: number }
  | { kind: 'joinCourses'; programId: number }
  | { kind: 'mcp'; courseId: number };

export default function Dashboard() {
  // Les programmes (et leurs cours/canaux) vivent dans un state : ainsi les
  // modifications de section (réordre, renommage, ajout, suppression) se reflètent
  // dans l'UI. La liste démarre vide et est remplie par api.fetchPrograms au montage.
  const [dashboardPrograms, setDashboardPrograms] = useState<DemoProgram[]>([]);
  // Profil connecté (GET/PATCH /api/me) : logique « API » extraite dans un hook dédié.
  const { currentUser, profileLoading, isAdmin, saveProfile } = useCurrentUser();
  // Aucun programme sélectionné au départ (-1) : une fois la liste chargée,
  // l'utilisateur doit choisir un programme avant que ses cours ne soient chargés.
  const [activeProgramId, setActiveProgramId] = useState<number>(-1);
  const [selectedCourseId, setSelectedCourseId] = useState<number | undefined>(undefined);
  const [selectedChannelRef, setSelectedChannelRef] = useState<ChannelRef | undefined>(undefined);
  // Popup actuellement ouvert (avec son contexte), ou null. Un seul à la fois.
  const [popup, setPopup] = useState<PopupState | null>(null);
  // Type de section en cours de création via les états vides du MainPanel
  // ('text' / 'quiz' / 'forum'), ou null. Réutilise le SectionEditorPopup du CourseMenu.
  const [creatingSectionType, setCreatingSectionType] = useState<string | null>(null);
  // Données du RoleEditorPopup, chargées à la demande (GET par programme).
  const [roleData, setRoleData] = useState<{ roles: Role[]; users: User[] } | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  // Sortie d'un programme (async : overlay de chargement + ErrorPopup en cas d'échec).
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);


  // UNE seule connexion WebSocket pour toute l'app (chat + forum + cours + programmes),
  // créée une fois au montage. Le token est lu à (re)connexion via getToken (localStorage).
  // Les quatre facades (ws.channels / ws.forums / ws.courses / ws.programs) partagent
  // cette connexion ; ws.close() la ferme volontairement (sans reconnexion).
  const ws = useMemo(() => createAppSocket(undefined, () => getToken() ?? ''), []);
  // Ouverture/fermeture pilotées par l'effet : en StrictMode (dev), le démontage
  // ferme puis le remontage rouvre — la garde `ws !== socket` côté appSocket évite
  // qu'un ancien socket en cours de connexion ne tue la nouvelle connexion.
  useEffect(() => {
    ws.open();
    return () => ws.close();
  }, [ws]);

  // Refs vers l'état courant : permettent au handler du socket programmes (abonné
  // une seule fois) de lire la liste / le programme actif sans capture périmée.
  const programsRef = useRef(dashboardPrograms);
  const activeProgramIdRef = useRef(activeProgramId);
  useEffect(() => {
    programsRef.current = dashboardPrograms;
    activeProgramIdRef.current = activeProgramId;
  });

  // Chargement de la liste des programmes : api.fetchPrograms renvoie les données,
  // on les pose dans le state ; le loader pilote loading/erreur.
  const handleFetchPrograms = useCallback(async () => {
    setDashboardPrograms(await api.fetchPrograms());
  }, []);

  const {
    loading: programsLoading,
    loadError: programsError,
    reload: reloadPrograms,
  } = useProgramsLoader(handleFetchPrograms);

  // Abonnement temps réel (scope utilisateur) : programme créé / renommé / supprimé,
  // adhésion / désabonnement. Applique à la liste, et bascule le programme actif s'il
  // disparaît.
  useEffect(() => {
    // Abonnement sur la room user:<id> RÉELLE (issue de GET /api/me). Tant que le
    // profil n'est pas chargé (loadingUser.id === -1), on n'ouvre rien : rejoindre
    // user:1 alors qu'on est l'user 4 serait refusé par DbRoomAuthorizer.
    const userId = currentUser.id;
    if (userId < 0) return;
    return ws.programs.subscribe(userId, {
      onProgramUpsert: (program) =>
        setDashboardPrograms((programs) => upsertProgram(programs, program)),
      onProgramRemove: (programId) => {
        setDashboardPrograms((programs) => programs.filter((p) => p.id !== programId));
        if (activeProgramIdRef.current === programId) {
          const fallback = programsRef.current.find((p) => p.id !== programId);
          setActiveProgramId(fallback?.id ?? -1);
          setSelectedCourseId(undefined);
          setSelectedChannelRef(undefined);
        }
      },
    });
  }, [ws, currentUser.id]);
  // Cours du programme actif : api.fetchCourses renvoie les cours, on les pose dans
  // le programme correspondant ; le loader pilote loading/erreur.
  const handleFetchCourses = useCallback(async (programId: number) => {
    const courses = await api.fetchCourses(programId);
    setDashboardPrograms((programs) =>
      programs.map((p) => (p.id === programId ? { ...p, courses } : p))
    );
  }, []);

  // Chaînage : on ne charge les cours qu'une fois la liste des programmes chargée
  // (fetch programmes → fetch cours). Tant que les programmes chargent / échouent,
  // le loader des cours reste en « chargement » sans lancer la requête.
  const coursesEnabled = !programsLoading && !programsError;

  // États « API-ready » du chargement de la liste (loading / erreur / réessayer).
  const {
    loading: coursesLoading,
    loadError: coursesError,
    reload: reloadCourses,
  } = useCoursesLoader(activeProgramId, handleFetchCourses, coursesEnabled);

  // Abonnement temps réel (scope programme) : applique les évènements cours /
  // section reçus à l'état. Le désabonnement se fait au changement de programme.
  useEffect(() => {
    if (activeProgramId < 0) return;
    return ws.courses.subscribe(activeProgramId, {
      onSectionChange: (courseId, sectionType, change) =>
        setDashboardPrograms((programs) =>
          mapProgramCourses(programs, activeProgramId, (course) =>
            course.id === courseId ? applySectionChange(course, sectionType, change) : course
          )
        ),
      onCourseUpsert: (course) =>
        setDashboardPrograms((programs) => upsertCourse(programs, activeProgramId, course)),
      onCourseDelete: (courseId) =>
        setDashboardPrograms((programs) => removeCourse(programs, activeProgramId, courseId)),
    });
  }, [activeProgramId, ws]);

  // Ouverture d'un canal (navigation / rendu de vue à implémenter côté canaux).
  const handleOpenChannel = (channel: CourseChannel) => {
    console.log('[Dashboard] Ouverture du canal :', channel);
  };

  // Ouvre le AddSubscriptionPopup (création / adhésion à un programme).
  const handleAddProgram = () => setPopup({ kind: 'addSubscription' });

  // Ouvre le AddCoursePopup avec le programme courant préselectionné (admin).
  const handleAddCourse = () => {
    if (isAdmin) setPopup({ kind: 'addCourse', programId: activeProgramId });
  };
  // Ouvre le UpdateCoursePopup pour le cours du crayon (admin ; crayon déjà admin-only).
  const handleEditCourse = (courseId: number) => {
    if (isAdmin) setPopup({ kind: 'editCourse', courseId });
  };
  // « Gestion MCP — Feedback du cours » (menu contextuel, clic droit sur le sélecteur,
  // admin) : ouvre la modale de gestion des analyses MCP du cours.
  const handleOpenMcpManagement = (courseId: number) => {
    if (isAdmin) setPopup({ kind: 'mcp', courseId });
  };
  // « Quitter le cours » (menu contextuel) : ouvre la confirmation. La sortie réelle
  // est faite par handleConfirmLeaveCourse (via api.leaveCourse).
  const handleLeaveCourse = (courseId: number) => setPopup({ kind: 'leaveCourse', courseId });
  // Ouvre le EditProfilePopup (menu du compte).
  const handleEditProfile = () => setPopup({ kind: 'editProfile' });
  // Déconnexion (clear session + redirection login à implémenter).
  const handleLogout = () => console.log('[Dashboard] Déconnexion demandée.');

  // ── Menu contextuel d'un programme (clic droit dans ProgramMenu) ──
  // Ajout d'un cours au programme ciblé (admin) : préselectionne ce programme.
  const handleAddCourseToProgram = (programId: number) => {
    if (isAdmin) setPopup({ kind: 'addCourse', programId });
  };
  const handleEditProgram = (programId: number) => {
    if (isAdmin) setPopup({ kind: 'editProgram', programId });
  };
  // Charge rôles + membres d'un programme (via api.fetchProgramRoles) et alimente le popup.
  const fetchProgramRoles = async (programId: number) => {
    setRoleData(null);
    setRoleError(null);
    setRoleLoading(true);
    try {
      setRoleData(await api.fetchProgramRoles(programId));
    } catch {
      setRoleError('Impossible de charger les membres du programme. Réessaie.');
    } finally {
      setRoleLoading(false);
    }
  };

  const handleManageRoles = (programId: number) => {
    if (!isAdmin) return;
    setPopup({ kind: 'manageRoles', programId });
    void fetchProgramRoles(programId);
  };
  const handleLeaveProgram = (programId: number) => setPopup({ kind: 'leaveProgram', programId });
  // Rejoindre des cours d'un programme (menu contextuel, TOUS les utilisateurs) : ouvre
  // le JoinCoursesPopup. L'adhésion réelle est faite par handleConfirmJoinCourses.
  const handleJoinCourses = (programId: number) => setPopup({ kind: 'joinCourses', programId });
  // Inscription aux cours choisis (via api.joinCourses). La sélection du popup REMPLACE
  // l'ensemble des cours du programme : les cours décochés sont retirés, les nouveaux
  // ajoutés. On préserve les données riches (canaux/quiz/forums) des cours conservés.
  // L'erreur remonte au popup (qui l'affiche).
  const handleConfirmJoinCourses = async (programId: number, courseIds: number[]) => {
    const joined = await api.joinCourses(programId, courseIds);
    setDashboardPrograms((programs) =>
      programs.map((program) => {
        if (program.id !== programId) return program;
        const existingById = new Map(program.courses.map((course) => [course.id, course]));
        const courses = courseIds
          .map((id) => existingById.get(id) ?? joined.find((course) => course.id === id))
          .filter((course): course is Course => course !== undefined);
        return { ...program, courses };
      })
    );
  };
  // Création de canal / quiz / forum via le SectionEditorPopup du type concerné
  // (mêmes actions que l'édition d'une section). Réservé à l'administrateur.
  const handleCreateChannel = () => {
    if (isAdmin) setCreatingSectionType('text');
  };
  const handleCreateQuiz = () => {
    if (isAdmin) setCreatingSectionType('quiz');
  };
  const handleCreateForum = () => {
    if (isAdmin) setCreatingSectionType('forum');
  };
  // Persiste une modification de section (réordre/renommage/suppression/ajout) via
  // api.changeSection. Le state n'est appliqué qu'APRÈS succès (le rejet laisse la
  // sidebar inchangée) : on exerce ainsi spinner / rollback / ErrorPopup du popup.
  const handleSectionChange = async (
    courseId: number,
    sectionType: string,
    change: ItemChange
  ) => {
    await api.changeSection(courseId, sectionType, change);
    setDashboardPrograms((programs) =>
      programs.map((program) => ({
        ...program,
        courses: program.courses.map((course) =>
          course.id === courseId ? applySectionChange(course, sectionType, change) : course
        ),
      }))
    );
  };

  // Synchronise la sidebar après un changement définitif dans l'éditeur de quiz
  // (création/maj/suppression/réordre). L'éditeur travaille sur la liste COMPLÈTE
  // (brouillons compris) ; la sidebar ne montre que les PUBLIÉS → on filtre ici.
  const handleQuizzesChange = (courseId: number, quizzes: Course['quizzes']) => {
    const published = reposition((quizzes ?? []).filter((q) => q.isPublished));
    setDashboardPrograms((programs) =>
      programs.map((program) => ({
        ...program,
        courses: program.courses.map((course) =>
          course.id === courseId ? { ...course, quizzes: published } : course
        ),
      }))
    );
  };

  // Création d'un cours (admin) → rattaché aux programmes choisis (via api.createCourse).
  // Le AddCoursePopup attend la résolution : reste ouvert + erreur si rejet, ferme si succès.
  const handleSaveCourse = async (course: NewCourse) => {
    const created = await api.createCourse(course);
    setDashboardPrograms((programs) =>
      programs.map((program) =>
        course.programIds.includes(program.id)
          ? { ...program, courses: [...program.courses, created] }
          : program
      )
    );
  };

  // Création d'un programme → ajouté à la liste (abonné d'office) via api.createProgram.
  const handleCreateProgram = async (program: NewProgram) => {
    const created = await api.createProgram(program);
    setDashboardPrograms((programs) => [...programs, created]);
  };

  // Adhésion → ajoute les programmes choisis du catalogue à la liste (via api.joinPrograms).
  const handleJoinPrograms = async (selection: JoinSelection) => {
    const catalog = await api.joinPrograms(selection);
    setDashboardPrograms((programs) => {
      const existing = new Set(programs.map((p) => p.id));
      const added = catalog
        .filter((p) => !existing.has(p.id))
        .map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          cohort: p.cohort,
          color: p.color,
          courses: [],
        }));
      return [...programs, ...added];
    });
  };

  // Loaders du AddSubscriptionPopup (GET) — délégués à la couche API.
  const loadCreateEstablishments = api.fetchEstablishmentsForCreate;
  const loadJoinEstablishments = api.fetchEstablishmentsForJoin;
  const loadEstablishmentPrograms = api.fetchEstablishmentPrograms;

  // Mise à jour d'un cours (admin) → code/titre dans le programme actif (via api.updateCourse).
  const handleUpdateCourse = async (courseId: number, update: CourseUpdate) => {
    await api.updateCourse(courseId, update);
    setDashboardPrograms((programs) =>
      mapProgramCourses(programs, activeProgramId, (course) =>
        course.id === courseId ? { ...course, code: update.code, title: update.title } : course
      )
    );
  };

  // Mise à jour d'un programme (admin) → nom/code/cohorte/couleur (via api.updateProgram).
  const handleUpdateProgram = async (programId: number, update: ProgramUpdate) => {
    await api.updateProgram(programId, update);
    setDashboardPrograms((programs) =>
      programs.map((program) =>
        program.id === programId
          ? {
              ...program,
              name: update.name,
              code: update.code,
              cohort: update.cohort,
              color: update.color,
            }
          : program
      )
    );
  };

  // Assignation/retrait d'un rôle ↔ utilisateur (admin) via api.changeRole. Le
  // RoleEditorPopup gère l'optimisme + rollback ; on ne fait que persister.
  const handleRoleChange = (change: RoleChange) => api.changeRole(change);

  // Quitter un programme (via api.leaveProgram). On ferme la confirmation puis on
  // affiche un overlay de chargement ; en cas d'échec, un ErrorPopup (sans retrait).
  // Au succès : retrait de la liste + bascule du programme actif s'il disparaît.
  const handleConfirmLeaveProgram = async (programId: number) => {
    setPopup(null);
    setLeaveError(null);
    setLeaveLoading(true);
    try {
      await api.leaveProgram(programId);
      if (programId === activeProgramId) {
        const fallback = dashboardPrograms.find((program) => program.id !== programId);
        setActiveProgramId(fallback?.id ?? -1);
        setSelectedCourseId(undefined);
        setSelectedChannelRef(undefined);
      }
      setDashboardPrograms((programs) => programs.filter((program) => program.id !== programId));
    } catch {
      setLeaveError('Impossible de quitter le programme. Réessaie.');
    } finally {
      setLeaveLoading(false);
    }
  };

  // Quitter un cours (via api.leaveCourse). Même flux que pour un programme : overlay
  // de chargement, ErrorPopup en cas d'échec. Au succès : retrait du cours du programme
  // actif + reset de la sélection si c'était le cours ouvert.
  const handleConfirmLeaveCourse = async (courseId: number) => {
    setPopup(null);
    setLeaveError(null);
    setLeaveLoading(true);
    try {
      await api.leaveCourse(courseId);
      if (courseId === effectiveSelectedCourseId) {
        setSelectedCourseId(undefined);
        setSelectedChannelRef(undefined);
      }
      setDashboardPrograms((programs) => removeCourse(programs, activeProgramId, courseId));
    } catch {
      setLeaveError('Impossible de quitter le cours. Réessaie.');
    } finally {
      setLeaveLoading(false);
    }
  };

  // Auteur des messages envoyés = utilisateur connecte (colonnes utiles de User_).
  const currentUserAuthor: ChannelMessageAuthor = {
    id: currentUser.id,
    username: currentUser.username,
    firstName: currentUser.firstName ?? '',
    lastName: currentUser.lastName ?? '',
  };

  // Envoi / édition / suppression de message : délégués à la couche API
  // (api.sendMessage doit RENVOYER le message persisté pour la réconciliation).
  const handleSendMessage = (
    channelId: number,
    content: string,
    parentId: number | null,
    clientMessageId: string
  ) => api.sendMessage(channelId, content, parentId, clientMessageId);

  const handleEditMessage = (messageId: number, content: string) =>
    api.editMessage(messageId, content);

  const handleDeleteMessage = (messageId: number) => api.deleteMessage(messageId);

  /* ───────────────────────────────────────────────────────────────────────────
   * FORUM ('Thread') — meme architecture API + temps reel que le chat.
   * À brancher : GET sujets, POST réponse, PATCH, DELETE, POST vote, WebSocket.
   * Déjà géré côté front : loading/erreur, rollback optimiste, dédup (clientPostId),
   * désabonnement au changement de forum. Scaffold WS : src/services/appSocket.ts.
   * ─────────────────────────────────────────────────────────────────────────── */

  const handleFetchThreads = (forumId: number) => api.fetchThreads(forumId);
  const handleFetchReplies = (postId: number) => api.fetchReplies(postId);
  const handleCreatePost = (
    forumId: number,
    content: string,
    parentId: number | null,
    clientPostId: string,
    title?: string
  ) => api.createPost(forumId, content, parentId, clientPostId, title);
  const handleEditPost = (postId: number, content: string) => api.editPost(postId, content);
  const handleDeletePost = (postId: number) => api.deletePost(postId);
  const handleVotePost = (postId: number, value: number) => api.votePost(postId, value);

  const activeProgram =
    dashboardPrograms.find((program) => program.id === activeProgramId) ?? null;
  // Programme passé à MainPanel selon l'avancement des fetchs (chaînage programmes → cours) :
  // - programmes pas prêts (chargement / erreur)            → null            → NoProgramState
  // - programme prêt mais cours en cours de chargement      → sans ses cours  → NoCourseState
  // - cours chargés                                         → programme réel  → EmptyCourseState / contenu
  const mainPanelProgram =
    !coursesEnabled || activeProgram == null
      ? null
      : coursesLoading
        ? { ...activeProgram, courses: [] }
        : activeProgram;
  const courses = activeProgram?.courses ?? [];
  const effectiveSelectedCourseId = getEffectiveSelectedCourseId(courses, selectedCourseId);
  const selectedCourse = getSelectedCourse(courses, effectiveSelectedCourseId);
  const selectedCourseChannels = selectedCourse
    ? normalizeCourseChannelsFromSources({
        channels: selectedCourse.channels,
        quizzes: selectedCourse.quizzes,
        forums: selectedCourse.forums,
      })
    : [];
  const selectedChannel =
    selectedCourseChannels.find((channel) => isSameChannel(channel, selectedChannelRef)) ?? null;

  // Charge l'historique d'un canal : entièrement délégué à api.fetchMessages.
  const handleFetchMessages = (channelId: number) => api.fetchMessages(channelId);

  const mobileUserInitial = getUserInitial(currentUser);

  // Section en cours de création (depuis un état vide du MainPanel) : sa définition
  // de type, pour ouvrir le SectionEditorPopup correspondant.
  const creatingSection: ChannelTypeDefinition | null = creatingSectionType
    ? (defaultTypeDefinitions.find((d) => d.type === creatingSectionType) ?? null)
    : null;
  // Programmes déjà suivis (préselectionnés dans la vue « rejoindre »).
  const subscribedProgramIds = dashboardPrograms.map((program) => program.id);
  // Programmes proposés dans AddCoursePopup / UpdateCoursePopup (forme attendue).
  const programChoices = dashboardPrograms.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    cohort: p.cohort,
    color: p.color,
  }));
  // Cours en cours d'édition (crayon du dropdown) : cherché dans le programme actif.
  const editingCourse =
    popup?.kind === 'editCourse'
      ? (activeProgram?.courses.find((course) => course.id === popup.courseId) ?? null)
      : null;
  // Cours ciblé par la confirmation « Quitter le cours » (dans le programme actif).
  const leavingCourse =
    popup?.kind === 'leaveCourse'
      ? (activeProgram?.courses.find((course) => course.id === popup.courseId) ?? null)
      : null;
  // Cours ciblé par la modale « Gestion MCP » (dans le programme actif).
  const mcpCourse =
    popup?.kind === 'mcp'
      ? (activeProgram?.courses.find((course) => course.id === popup.courseId) ?? null)
      : null;
  // Programme ciblé par un popup contextuel (édition / rôles / quitter).
  const popupProgram =
    popup && 'programId' in popup
      ? (dashboardPrograms.find((program) => program.id === popup.programId) ?? null)
      : null;

  return (
    <div className={styles.dashboardLayout}>
      <LeftMenuGroup
        mobileTitlePrefix={selectedChannel ? <ChannelTypeIcon type={selectedChannel.type} /> : undefined}
        mobileTitle={selectedChannel ? selectedChannel.name : undefined}
        mobileUserInitial={mobileUserInitial}
        mobileUserMenu={
          <UserMenu
            variant="compact"
            user={currentUser}
            loading={profileLoading}
            onEditProfile={handleEditProfile}
            onLogout={handleLogout}
          />
        }
        programMenu={
          <ProgramMenu
            programs={dashboardPrograms}
            activeProgramId={activeProgramId}
            onSelectProgram={(nextProgramId) => {
              setActiveProgramId(nextProgramId);
              setSelectedChannelRef(undefined);

              const nextProgram = dashboardPrograms.find((program) => program.id === nextProgramId);

              setSelectedCourseId(getEffectiveSelectedCourseId(nextProgram?.courses ?? [], undefined));
            }}
            onAddProgram={handleAddProgram}
            loading={programsLoading}
            loadError={programsError}
            onReload={reloadPrograms}
            isAdmin={isAdmin}
            onAddCourseToProgram={handleAddCourseToProgram}
            onEditProgram={handleEditProgram}
            onManageRoles={handleManageRoles}
            onJoinCourses={handleJoinCourses}
            onLeaveProgram={handleLeaveProgram}
          />
        }
        courseMenu={
          <CourseMenu
            activeProgram={activeProgram}
            // Tant que les programmes ne sont pas chargés (chaînage), on ne montre
            // pas les cours en cache : CourseMenu reste neutre jusqu'au fetch des cours.
            courses={coursesEnabled ? courses : []}
            currentUser={currentUser}
            userLoading={profileLoading}
            selectedCourseId={effectiveSelectedCourseId}
            onSelectCourse={(courseId) => {
              setSelectedCourseId(courseId);
              setSelectedChannelRef(undefined);
            }}
            selectedChannel={selectedChannelRef}
            onSelectChannel={setSelectedChannelRef}
            onOpenChannel={handleOpenChannel}
            onSectionChange={handleSectionChange}
            isAdmin={isAdmin}
            // CourseMenu ne reflète QUE le fetch des cours (qui n'a lieu qu'après
            // le succès du fetch programmes) → pas d'illusion de fetch parallèle.
            loading={coursesLoading}
            loadError={coursesError}
            onReloadCourses={reloadCourses}
            onAddCourse={handleAddCourse}
            onEditCourse={handleEditCourse}
            onOpenMcpManagement={handleOpenMcpManagement}
            onLeaveCourse={handleLeaveCourse}
            onEditProfile={handleEditProfile}
            onLogout={handleLogout}
            // Crayon section quiz → éditeur peuplé via le mock (cf. dashboardApi).
            quizHandlers={quizEditorHandlers}
            onQuizzesChange={handleQuizzesChange}
          />
        }
      />

      <MainPanel
        isAdmin={isAdmin}
        program={mainPanelProgram}
        selectedCourse={effectiveSelectedCourseId ?? null}
        selectedChannel={selectedChannelRef ?? null}
        currentUser={currentUserAuthor}
        onFetchMessages={handleFetchMessages}
        onSendMessage={handleSendMessage}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        // Une seule connexion WebSocket pour le chat ET le forum (mêmes rooms).
        socket={ws.channels}
        // ── Forum ('Thread') : API + temps reel (mirror du chat, meme connexion). ──
        onFetchThreads={handleFetchThreads}
        onFetchReplies={handleFetchReplies}
        onCreatePost={handleCreatePost}
        onEditPost={handleEditPost}
        onDeletePost={handleDeletePost}
        onVotePost={handleVotePost}
        forumSocket={ws.forums}
        onAddProgram={handleAddProgram}
        onAddCourse={handleAddCourse}
        onCreateChannel={handleCreateChannel}
        onCreateQuiz={handleCreateQuiz}
        onCreateForum={handleCreateForum}
        // ── Quiz : détail + soumission servis depuis le mock (cf. dashboardApi). ──
        onFetchQuiz={api.fetchQuiz}
        onSubmitQuiz={api.submitQuiz}
      />

      {/* Création d'un canal / quiz / forum depuis un état vide : même popup que
          l'édition d'une section dans le CourseMenu (réservé à l'admin via les
          boutons des états). */}
      {creatingSection && selectedCourse && (
        <CourseSectionEditor
          section={creatingSection}
          channels={selectedCourseChannels}
          onChange={(change) => handleSectionChange(selectedCourse.id, creatingSection.type, change)}
          onClose={() => setCreatingSectionType(null)}
          courseId={selectedCourse.id}
          quizzes={selectedCourse.quizzes ?? []}
          quizSubtitle={selectedCourse.code}
          quizHandlers={quizEditorHandlers}
          onQuizzesChange={(quizzes) => handleQuizzesChange(selectedCourse.id, quizzes)}
        />
      )}

      {/* Ajout d'un cours (admin) — programme courant préselectionné. */}
      {popup?.kind === 'addCourse' && (
        <AddCoursePopup
          onClose={() => setPopup(null)}
          programs={programChoices}
          initialProgramIds={popup.programId >= 0 ? [popup.programId] : []}
          onSave={handleSaveCourse}
        />
      )}

      {/* Modification d'un cours (admin) — crayon de la liste déroulante. */}
      {popup?.kind === 'editCourse' && editingCourse && (
        <UpdateCoursePopup
          onClose={() => setPopup(null)}
          programs={programChoices}
          course={{
            title: editingCourse.title ?? editingCourse.name ?? '',
            code: editingCourse.code ?? '',
            programIds: [activeProgramId],
          }}
          onSave={(update) => handleUpdateCourse(editingCourse.id, update)}
        />
      )}

      {/* Ajout / adhésion à un programme — création réservée à l'admin. */}
      {popup?.kind === 'addSubscription' && (
        <AddSubscriptionPopup
          onClose={() => setPopup(null)}
          onCreate={handleCreateProgram}
          onJoin={handleJoinPrograms}
          loadCreateEstablishments={loadCreateEstablishments}
          loadJoinEstablishments={loadJoinEstablishments}
          loadEstablishmentPrograms={loadEstablishmentPrograms}
          subscribedProgramIds={subscribedProgramIds}
          canCreateProgram={isAdmin}
        />
      )}

      {/* Modification du profil (menu du compte). */}
      {popup?.kind === 'editProfile' && (
        <EditProfilePopup
          onClose={() => setPopup(null)}
          user={{
            username: currentUser.username,
            firstName: currentUser.firstName ?? '',
            lastName: currentUser.lastName ?? '',
            avatarColor: currentUser.avatarColor,
          }}
          onSave={saveProfile}
        />
      )}

      {/* Modification d'un programme (admin) — menu contextuel. */}
      {popup?.kind === 'editProgram' && popupProgram && (
        <UpdateProgramPopup
          onClose={() => setPopup(null)}
          program={{
            name: popupProgram.name,
            code: popupProgram.code,
            cohort: popupProgram.cohort,
            color: popupProgram.color,
          }}
          existingCodes={dashboardPrograms
            .filter((p) => p.id !== popupProgram.id)
            .map((p) => p.code)}
          onSave={(update) => handleUpdateProgram(popupProgram.id, update)}
        />
      )}

      {/* Gestion des rôles d'un programme (admin) — menu contextuel.
          Données chargées à la demande (GET par programme) : spinner pendant le
          chargement, ErrorPopup en cas d'échec, sinon le RoleEditorPopup. */}
      {popup?.kind === 'manageRoles' && popupProgram && roleLoading && (
        <div className={styles.loadingOverlay} role="status" aria-live="polite" aria-busy="true">
          <Spinner size={36} />
        </div>
      )}
      {popup?.kind === 'manageRoles' && popupProgram && !roleLoading && roleError && (
        <ErrorPopup
          content={roleError}
          onClose={() => setPopup(null)}
        />
      )}
      {popup?.kind === 'manageRoles' && popupProgram && !roleLoading && !roleError && roleData && (
        <RoleEditorPopup
          onClose={() => setPopup(null)}
          roles={roleData.roles}
          users={roleData.users}
          onChange={handleRoleChange}
        />
      )}

      {/* Gestion MCP d'un cours (menu contextuel du sélecteur de cours, admin). */}
      {popup?.kind === 'mcp' && mcpCourse && (
        <McpManagementPopup
          courseId={mcpCourse.id}
          courseLabel={
            mcpCourse.code || mcpCourse.name || 'Cours'
          }
          loadAnalyses={() => api.fetchCourseAnalyses(mcpCourse.id)}
          loadAnalysis={(id) => api.fetchCourseAnalysis(id)}
          loadPending={() => api.fetchPendingAnalysis(mcpCourse.id)}
          subscribeCompletion={(handlers) =>
            ws.mcp.subscribe(mcpCourse.id, {
              onAnalysisCreated: handlers.onCreated,
              // Échec : ne réagit que si c'est l'utilisateur courant qui a lancé le job
              // (le verrou MCP est par (cours, user)).
              onAnalysisFailed: (launcherId, reason) => {
                if (launcherId === currentUser.id) handlers.onFailed(reason);
              },
              onResync: handlers.onResync,
            })
          }
          onAnalyze={() => api.requestCourseAnalysis(mcpCourse.id)}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Rejoindre des cours d'un programme (menu contextuel, tous les utilisateurs). */}
      {popup?.kind === 'joinCourses' && popupProgram && (
        <JoinCoursesPopup
          programName={popupProgram.name}
          programColor={popupProgram.color}
          loadCourses={() => api.fetchProgramCourses(popupProgram.id)}
          loadJoinedCourseIds={() => api.fetchJoinedCourseIds(popupProgram.id)}
          onJoin={(courseIds) => handleConfirmJoinCourses(popupProgram.id, courseIds)}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Quitter un programme — confirmation (menu contextuel). */}
      {popup?.kind === 'leaveProgram' && popupProgram && (
        <DeleteConfirmationPopup
          title="Quitter le programme ?"
          content={`Tu ne verras plus les cours, canaux et forums de « ${popupProgram.name} ». Tu pourras le rejoindre à nouveau plus tard.`}
          labels={{ confirm: 'Quitter' }}
          onDeleteConfirmation={() => handleConfirmLeaveProgram(popupProgram.id)}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Quitter un cours — confirmation (menu contextuel). */}
      {popup?.kind === 'leaveCourse' && leavingCourse && (
        <DeleteConfirmationPopup
          title="Quitter le cours ?"
          content={`Tu ne verras plus les canaux, quiz et forums de « ${leavingCourse.code ?? leavingCourse.title ?? 'ce cours'} ». Tu pourras le rejoindre à nouveau plus tard.`}
          labels={{ confirm: 'Quitter' }}
          onDeleteConfirmation={() => handleConfirmLeaveCourse(leavingCourse.id)}
          onClose={() => setPopup(null)}
        />
      )}

      {/* Sortie de programme en cours (DELETE) : overlay puis ErrorPopup si échec. */}
      {leaveLoading && (
        <div className={styles.loadingOverlay} role="status" aria-live="polite" aria-busy="true">
          <Spinner size={36} />
        </div>
      )}
      {leaveError && <ErrorPopup content={leaveError} onClose={() => setLeaveError(null)} />}
    </div>
  );
}

function getUserInitial(user: UserMenuUser): string {
  const display = user.firstName?.trim() || user.username?.trim() || 'U';
  return display[0].toUpperCase();
}

function getEffectiveSelectedCourseId(
  courses: Course[],
  selectedCourseId: number | undefined
): number | undefined {
  if (courses.length === 0) return undefined;

  const selectedCourseStillExists = courses.some((course) => course.id === selectedCourseId);

  return selectedCourseStillExists ? selectedCourseId : courses[0].id;
}

function getSelectedCourse(courses: Course[], selectedCourseId: number | undefined): Course | null {
  return courses.find((course) => course.id === selectedCourseId) ?? courses[0] ?? null;
}

/**
 * Renvoie une copie du cours avec la modification de section appliquée.
 * - 'quiz' agit sur les quiz ; 'text'/'forum' agissent sur le sous-ensemble de
 *   forums du fType correspondant ('Discussion' / 'Thread').
 * Les positions sont réattribuées séquentiellement après chaque changement.
 */
/** Applique une transformation aux cours d'un programme donné (immuable). */
function mapProgramCourses(
  programs: DemoProgram[],
  programId: number,
  mapCourse: (course: Course) => Course
): DemoProgram[] {
  return programs.map((program) =>
    program.id === programId
      ? { ...program, courses: program.courses.map(mapCourse) }
      : program
  );
}

/** Insère (ou met à jour si l'id existe déjà) un programme dans la liste de l'utilisateur. */
function upsertProgram(programs: DemoProgram[], program: Program): DemoProgram[] {
  const exists = programs.some((p) => p.id === program.id);
  if (exists) {
    // Met à jour les champs du programme ; conserve les cours déjà chargés
    // (sauf si l'évènement en fournit explicitement).
    return programs.map((p) =>
      p.id === program.id
        ? {
            ...p,
            name: program.name,
            code: program.code,
            cohort: program.cohort,
            color: program.color,
            courses: program.courses ?? p.courses,
          }
        : p
    );
  }
  return [
    ...programs,
    {
      id: program.id,
      name: program.name,
      code: program.code,
      cohort: program.cohort,
      color: program.color,
      courses: program.courses ?? [],
    },
  ];
}

/** Insère (ou remplace si l'id existe déjà) un cours dans un programme. */
function upsertCourse(programs: DemoProgram[], programId: number, course: Course): DemoProgram[] {
  return programs.map((program) => {
    if (program.id !== programId) return program;
    const exists = program.courses.some((c) => c.id === course.id);
    return {
      ...program,
      courses: exists
        ? program.courses.map((c) => (c.id === course.id ? course : c))
        : [...program.courses, course],
    };
  });
}

/** Retire un cours d'un programme. */
function removeCourse(programs: DemoProgram[], programId: number, courseId: number): DemoProgram[] {
  return programs.map((program) =>
    program.id === programId
      ? { ...program, courses: program.courses.filter((c) => c.id !== courseId) }
      : program
  );
}

function applySectionChange(course: Course, sectionType: string, change: ItemChange): Course {
  if (sectionType === 'quiz') {
    return { ...course, quizzes: applyToQuizzes(course.quizzes ?? [], change) };
  }
  const fType: ForumType = sectionType === 'text' ? 'Discussion' : 'Thread';
  return { ...course, forums: applyToForums(course.forums ?? [], fType, change) };
}

function applyToQuizzes(quizzes: QuizChannelSource[], change: ItemChange): QuizChannelSource[] {
  switch (change.type) {
    case 'rename':
      return reposition(
        quizzes.map((q) => (String(q.id) === change.id ? { ...q, title: change.name } : q))
      );
    case 'delete':
      return reposition(quizzes.filter((q) => String(q.id) !== change.id));
    case 'create':
      return reposition([...quizzes, { id: nextNumericId(quizzes), title: change.item.name }]);
    case 'reorder':
      return reposition(orderByIds(quizzes, change.orderedIds));
  }
}

function applyToForums(
  forums: ForumChannelSource[],
  fType: ForumType,
  change: ItemChange
): ForumChannelSource[] {
  const inSection = (f: ForumChannelSource) => (f.fType ?? 'Thread') === fType;
  switch (change.type) {
    case 'rename':
      return reposition(
        forums.map((f) =>
          inSection(f) && String(f.id) === change.id ? { ...f, title: change.name } : f
        )
      );
    case 'delete':
      return reposition(forums.filter((f) => !(inSection(f) && String(f.id) === change.id)));
    case 'create':
      return reposition([
        ...forums,
        { id: nextNumericId(forums), title: change.item.name, fType: fType },
      ]);
    case 'reorder': {
      // On réordonne uniquement le sous-ensemble du fType ; les autres forums
      // gardent leur ordre relatif (les sections sont affichées séparément).
      const reordered = orderByIds(forums.filter(inSection), change.orderedIds);
      const others = forums.filter((f) => !inSection(f));
      return reposition([...reordered, ...others]);
    }
  }
}

/** Réordonne `items` selon la liste d'ids (comparés en chaîne) émise par le popup. */
function orderByIds<T extends { id: number }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const ordered = orderedIds
    .map((id) => byId.get(id))
    .filter((item): item is T => item !== undefined);
  // Filet de sécurité : ré-ajoute les items éventuellement absents de orderedIds.
  const seen = new Set(orderedIds);
  return [...ordered, ...items.filter((item) => !seen.has(String(item.id)))];
}

/** Réattribue des positions séquentielles (0, 1, 2, …) dans l'ordre du tableau. */
function reposition<T extends { position?: number }>(items: T[]): T[] {
  return items.map((item, index) => ({ ...item, position: index }));
}

/** Prochain id numérique libre dans un tableau (max + 1). */
function nextNumericId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}
