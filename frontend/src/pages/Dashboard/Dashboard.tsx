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
import { AuditLogsPopup } from '../../components/AuditLogsPopup/AuditLogsPopup.tsx';
import { ErrorPopup } from '../../components/ErrorPopup/ErrorPopup.tsx';
import { ChannelTypeIcon } from '../../components/CourseChannelList/ChannelTypeIcon.tsx';
import { type ItemChange } from '../../components/SectionEditorPopup/types.ts';

// Client WebSocket réel : UNE seule connexion sert le chat, le forum, les cours et
// les programmes (quatre facades) — étape [5] du HANDOFF.
import { createAppSocket } from '../../services/appSocket.ts';
import { useCurrentUser } from '../../context/currentUserContext.ts';
import type { SavedLocation } from '../../helpers/userSettings.ts';
import { getProgramPermissions } from '../../helpers/permissions.ts';
import { ROLE } from '../../helpers/roles.ts';
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
import { type AttemptOutcome } from '../../components/MainPanel/QuizView/quizAttempt.ts';
import styles from './Dashboard.module.css';

/**
 * Câblage des callbacks de l'éditeur de quiz sur la couche API (`dashboardApi`).
 * Assemblage côté consommateur : l'éditeur reste « API-ready » (remplacer les corps
 * mock des fonctions `api.*` par des apiFetch suffit, sans toucher à ce mapping).
 */
const quizEditorHandlers: QuizEditorHandlers = {
  // Éditeur enseignant → détail AVEC correction (endpoint /edit, réservé aux admins).
  onFetchQuiz: api.fetchQuizForEdit,
  onFetchQuizzes: api.fetchQuizzes,
  onFetchLanguages: api.fetchLanguages,
  onFetchQuestionTypes: api.fetchQuestionTypes,
  onCreateQuiz: api.createQuiz,
  onUpdateQuiz: api.updateQuiz,
  onDeleteQuiz: api.deleteQuiz,
  onReorderQuizzes: api.reorderQuizzes,
  onEvaluateCode: api.evaluateCode,
  onRunCode: api.runCode,
};

/** Popup ouvert dans le Dashboard, avec le contexte nécessaire à son rendu. */
type PopupState =
  | { kind: 'addCourse'; programId: number } // programId = programme préselectionné
  | { kind: 'addSubscription'; view?: 'join' }
  | { kind: 'editCourse'; courseId: number }
  | { kind: 'editProfile' }
  | { kind: 'editProgram'; programId: number }
  | { kind: 'manageRoles'; programId: number }
  | { kind: 'manageGlobalRoles' } // gestion des administrateurs (rôles globaux / plateforme)
  | { kind: 'viewAuditLogs' } // journal d'audit (actions de gestion) — Gardien uniquement
  | { kind: 'leaveProgram'; programId: number }
  | { kind: 'deleteProgram'; programId: number }
  | { kind: 'leaveCourse'; courseId: number }
  | { kind: 'deleteCourse'; courseId: number }
  | { kind: 'joinCourses'; programId: number }
  | { kind: 'mcp'; courseId: number };

export default function Dashboard() {
  // Les programmes (et leurs cours/canaux) vivent dans un state : ainsi les
  // modifications de section (réordre, renommage, ajout, suppression) se reflètent
  // dans l'UI. La liste démarre vide et est remplie par api.fetchPrograms au montage.
  const [dashboardPrograms, setDashboardPrograms] = useState<DemoProgram[]>([]);
  // Profil connecté (GET/PATCH /api/me) : logique « API » extraite dans un hook dédié.
  const {
    currentUser,
    profileLoading,
    isAdmin,
    isGuardian,
    saveProfile,
    applyGlobalRoles,
    settings,
    saveSettings,
  } = useCurrentUser();
  // Aucun programme sélectionné au départ (-1) : une fois la liste chargée,
  // l'utilisateur doit choisir un programme avant que ses cours ne soient chargés.
  const [activeProgramId, setActiveProgramId] = useState<number>(-1);
  const [selectedCourseId, setSelectedCourseId] = useState<number | undefined>(undefined);
  // Permissions FRONT (cosmétiques : le backend ne re-vérifie pas) dérivées du rôle de
  // l'utilisateur DANS le programme visé (Program.roleName) combiné au rôle GLOBAL (isAdmin).
  const permsForProgram = (programId: number) =>
    getProgramPermissions(
      dashboardPrograms.find((program) => program.id === programId) ?? null,
      isAdmin
    );
  // Incrémenté à chaque mise à jour de quiz → remonte la vue de quiz ouverte (rechargement).
  const [quizRefreshKey, setQuizRefreshKey] = useState(0);
  // Id du quiz modifié à distance (WS) → rechargement si c'est le quiz ouvert.
  const [staleQuizId, setStaleQuizId] = useState<number | null>(null);
  // Dernier verdict PUSH (WS) d'une correction async de tentative → remonté à la vue de quiz.
  const [attemptOutcome, setAttemptOutcome] = useState<AttemptOutcome | null>(null);
  // Id du quiz actuellement ouvert (ref lisible depuis les closures WS, ex. resync).
  const openQuizIdRef = useRef<number | null>(null);
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
  // Données du gestionnaire des administrateurs (rôles GLOBAUX), chargées à l'ouverture.
  const [globalRoleData, setGlobalRoleData] = useState<{ roles: Role[]; users: User[] } | null>(
    null
  );
  const [globalRoleLoading, setGlobalRoleLoading] = useState(false);
  const [globalRoleError, setGlobalRoleError] = useState<string | null>(null);
  // Sortie d'un programme (async : overlay de chargement + ErrorPopup en cas d'échec).
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // ── Easter eggs « kiwi » / « twee » / « pacman » ─────────────────────────
  // Trois séquences secrètes basculent chacune un thème éphémère :
  //   ↑ ↑ ↓ ↓ ← → ← → B A  → « kiwi »   (tranches de kiwi + palette verte)
  //   frappe de « 8339! »   → « twee »   (canettes ailées + palette bleu/jaune)
  //   frappe de « pacman! »  → « pacman » (Pac-Man + fantômes + palette arcade)
  // Éphémère : on pose data-theme directement sur <html> SANS toucher au localStorage
  // — un rafraîchissement revient au thème normal. Actif uniquement tant que le
  // dashboard est monté ; on restaure au démontage.
  const themeBeforeEgg = useRef<string | null>(null);
  useEffect(() => {
    const KONAMI = [
      'ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight',
    ];
    const CODES = [
      { theme: 'kiwi', seq: [...KONAMI, 'b', 'a'] },
      { theme: 'twee', seq: ['8', '3', '3', '9', '!'] },
      { theme: 'pacman', seq: ['p', 'a', 'c', 'm', 'a', 'n', '!'] },
    ];
    const EGGS = CODES.map((c) => c.theme);
    const root = document.documentElement;
    const progress = CODES.map(() => 0);

    // Rétablit le thème d'avant l'easter egg (attribut absent = thème auto/OS).
    const restoreTheme = () => {
      if (themeBeforeEgg.current === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', themeBeforeEgg.current);
    };

    const toggle = (theme: string) => {
      const current = root.getAttribute('data-theme');
      if (current === theme) {
        restoreTheme();
      } else {
        // On ne mémorise le thème sous-jacent que s'il n'est pas déjà un easter egg
        // (ex. bascule directe kiwi → twee), pour pouvoir revenir au thème réel.
        if (!EGGS.includes(current ?? '')) themeBeforeEgg.current = current;
        root.setAttribute('data-theme', theme);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // On ignore les touches modificatrices seules : sinon le Shift tapé pour faire
      // « ! » (dernier caractère de 8339!) s'intercalerait et casserait la séquence.
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
        return;
      }
      // Lettres (A/B) comparées en minuscule ; les flèches gardent leur code exact.
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Chaque séquence avance indépendamment ; un faux pas repart de 0 — ou de 1 si
      // la touche correspond au tout début, pour ne pas rater un nouveau départ.
      CODES.forEach((code, i) => {
        progress[i] = key === code.seq[progress[i]] ? progress[i] + 1 : key === code.seq[0] ? 1 : 0;
        if (progress[i] === code.seq.length) {
          progress[i] = 0;
          toggle(code.theme);
        }
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // En quittant le dashboard, on ne laisse pas fuiter un thème easter egg ailleurs.
      if (EGGS.includes(root.getAttribute('data-theme') ?? '')) restoreTheme();
    };
  }, []);

  // UNE seule connexion WebSocket pour toute l'app (chat + forum + cours + programmes),
  // créée une fois au montage. L'authentification se fait au handshake via le cookie
  // HttpOnly `moodit_token` (envoyé automatiquement par le navigateur, même origine).
  // Les quatre facades (ws.channels / ws.forums / ws.courses / ws.programs) partagent
  // cette connexion ; ws.close() la ferme volontairement (sans reconnexion).
  const ws = useMemo(() => createAppSocket(), []);
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
      // Mon rôle DANS ce programme a changé → on met à jour son roleName ; les menus
      // d'actions administratives (permsForProgram) se re-gatent automatiquement.
      onProgramRoleChange: (programId, roleName) =>
        setDashboardPrograms((programs) =>
          programs.map((p) => (p.id === programId ? { ...p, roleName } : p))
        ),
      // Mes rôles GLOBAUX ont changé → on remplace ceux du profil ; isAdmin/isGuardian
      // se recalculent (bouton « Gérer les administrateurs », droits de suppression…).
      onGlobalRolesChange: (roles) => applyGlobalRoles(roles),
      // Correction ASYNCHRONE d'une de MES tentatives terminée / échouée (room user) : on remonte
      // le verdict à la vue de quiz ouverte, qui résout l'attente (résumé) ou invite à renvoyer.
      onQuizAttemptGraded: (quizId, attemptId) =>
        setAttemptOutcome({ quizId, attemptId, ok: true }),
      onQuizAttemptFailed: (quizId, attemptId, reason) =>
        setAttemptOutcome({ quizId, attemptId, ok: false, reason }),
    });
  }, [ws, currentUser.id, applyGlobalRoles]);

  // Abonnement temps réel de la liste des ADMINISTRATEURS (popup rôles globaux) : un autre admin
  // modifie une assignation → le serveur diffuse la liste à jour. On mappe `roles` → `role_ids`
  // (comme fetchGlobalRoles) avant de la livrer au RoleEditorPopup. Stable (dépend de `ws`).
  const subscribeAdminRoles = useCallback(
    (handler: (users: User[]) => void) =>
      ws.adminRoles.subscribe((users) =>
        handler(
          // Mapping explicite vers la forme `User` du RoleEditorPopup (le champ backend `roles`
          // porte des ids → `role_ids` ; on ne le recopie pas tel quel pour éviter le conflit de
          // type avec User.roles: Role[]).
          users.map((u) => ({
            id: u.id,
            username: u.username,
            firstName: u.firstName,
            lastName: u.lastName,
            email: u.email,
            avatarColor: u.avatarColor,
            role_ids: u.roles ?? [],
          }))
        )
      ),
    [ws]
  );

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
    // Recharge les quiz PUBLIÉS d'un cours dans la liste (ajout / modif / suppression).
    const refreshCourseQuizzes = (courseId: number) => {
      void api
        .fetchPublishedQuizzes(courseId)
        .then((quizzes) =>
          setDashboardPrograms((programs) =>
            mapProgramCourses(programs, activeProgramId, (course) =>
              course.id === courseId ? { ...course, quizzes } : course
            )
          )
        )
        .catch(() => {
          /* échec silencieux : la liste garde son état courant */
        });
    };
    return ws.courses.subscribe(activeProgramId, {
      onSectionChange: (courseId, sectionType, change) =>
        setDashboardPrograms((programs) =>
          mapProgramCourses(programs, activeProgramId, (course) =>
            course.id === courseId ? applySectionChange(course, sectionType, change) : course
          )
        ),
      // WS course:created/edited → mise à jour MÉTA d'un cours déjà présent uniquement.
      // On n'AJOUTE pas : un cours neuf (ou édité) auquel l'utilisateur n'est pas inscrit
      // ne doit pas apparaître dans sa sidebar (il l'ajoutera en le rejoignant).
      onCourseUpsert: (course) =>
        setDashboardPrograms((programs) => updateCourseMeta(programs, activeProgramId, course)),
      onCourseDelete: (courseId) =>
        setDashboardPrograms((programs) => removeCourse(programs, activeProgramId, courseId)),
      // Un quiz a été ajouté : il apparaît dans la liste (s'il est publié).
      onQuizCreated: (courseId) => refreshCourseQuizzes(courseId),
      // Un quiz a été modifié : on rafraîchit la liste, et la QuizView affiche une bannière
      // de rechargement si c'est le quiz actuellement ouvert (cf. quizStale).
      onQuizUpdated: (courseId, quizId) => {
        refreshCourseQuizzes(courseId);
        setStaleQuizId(quizId);
      },
      // Les quiz ont été réordonnés : on rafraîchit la liste (nouvel ordre, sans bannière).
      onQuizReordered: (courseId) => refreshCourseQuizzes(courseId),
      // Reconnexion : des évènements ont pu être manqués → on recharge les cours du
      // programme actif (canaux/quiz/forums resynchronisés) ET la vue de quiz ouverte
      // (rechargement en conservant la saisie, via le mécanisme staleQuizId).
      onResync: () => {
        void handleFetchCourses(activeProgramId);
        if (openQuizIdRef.current != null) setStaleQuizId(openQuizIdRef.current);
      },
      // Un quiz a été supprimé : il sort de la liste, on ferme sa vue si elle est ouverte,
      // et on efface une éventuelle bannière « modifié » le concernant.
      onQuizDeleted: (courseId, quizId) => {
        refreshCourseQuizzes(courseId);
        setSelectedChannelRef((prev) =>
          prev?.type === 'quiz' && prev.id === quizId ? undefined : prev
        );
        setStaleQuizId((prev) => (prev === quizId ? null : prev));
      },
    });
    // `handleFetchCourses` volontairement HORS deps : l'abonnement WS ne doit se refaire qu'au
    // changement de programme (l'inclure re-souscrirait à chaque rendu).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProgramId, ws]);

  // Ouverture d'un canal (navigation / rendu de vue à implémenter côté canaux).
  const handleOpenChannel = (channel: CourseChannel) => {
    console.log('[Dashboard] Ouverture du canal :', channel);
  };

  // Ouvre le AddSubscriptionPopup (création / adhésion à un programme).
  const handleAddProgram = () => setPopup({ kind: 'addSubscription' });
  // « Rejoindre un programme » (offert à tous depuis l'état « aucun programme ») : ouvre le même
  // popup DIRECTEMENT sur la vue d'adhésion (la création reste gatée par canCreateProgram).
  const handleJoinProgram = () => setPopup({ kind: 'addSubscription', view: 'join' });

  // Ouvre le AddCoursePopup avec le programme courant préselectionné (gestion contenu).
  const handleAddCourse = () => {
    if (permsForProgram(activeProgramId).canManageContent)
      setPopup({ kind: 'addCourse', programId: activeProgramId });
  };
  // Ouvre le UpdateCoursePopup pour le cours du crayon (gestion contenu du programme actif).
  const handleEditCourse = (courseId: number) => {
    if (permsForProgram(activeProgramId).canManageContent)
      setPopup({ kind: 'editCourse', courseId });
  };
  // « Gestion MCP — Feedback du cours » (menu contextuel, clic droit sur le sélecteur) :
  // ouvre la modale de gestion des analyses MCP du cours (gestion contenu).
  const handleOpenMcpManagement = (courseId: number) => {
    if (permsForProgram(activeProgramId).canManageContent) setPopup({ kind: 'mcp', courseId });
  };
  // « Quitter le cours » (menu contextuel) : ouvre la confirmation. La sortie réelle
  // est faite par handleConfirmLeaveCourse (via api.leaveCourse).
  const handleLeaveCourse = (courseId: number) => setPopup({ kind: 'leaveCourse', courseId });
  // « Supprimer le cours » (menu contextuel, gestion contenu) : ouvre la confirmation. La
  // suppression réelle est faite par handleConfirmDeleteCourse (via api.deleteCourse).
  const handleDeleteCourse = (courseId: number) => {
    if (permsForProgram(activeProgramId).canManageContent)
      setPopup({ kind: 'deleteCourse', courseId });
  };
  // Ouvre le EditProfilePopup (menu du compte).
  const handleEditProfile = () => setPopup({ kind: 'editProfile' });
  // Déconnexion (clear session + redirection login à implémenter).
  const handleLogout = () => console.log('[Dashboard] Déconnexion demandée.');

  // ── Gestion des administrateurs (rôles GLOBAUX / plateforme) ──
  // Charge rôles globaux + utilisateurs (via api.fetchGlobalRoles) et alimente le popup.
  const fetchGlobalRoles = async () => {
    setGlobalRoleData(null);
    setGlobalRoleError(null);
    setGlobalRoleLoading(true);
    try {
      setGlobalRoleData(await api.fetchGlobalRoles());
    } catch {
      setGlobalRoleError('Impossible de charger les administrateurs. Réessaie.');
    } finally {
      setGlobalRoleLoading(false);
    }
  };
  // Ouvre le gestionnaire des administrateurs (réservé aux admins globaux / gardiens).
  const handleManageAdmins = () => {
    if (!isAdmin) return;
    setPopup({ kind: 'manageGlobalRoles' });
    void fetchGlobalRoles();
  };
  // Persiste un changement de rôle GLOBAL (User_Role) via api.changeGlobalRole.
  const handleGlobalRoleChange = (change: RoleChange) => api.changeGlobalRole(change);

  // Ouvre le journal d'audit (réservé au Gardien ; le popup charge lui-même les entrées).
  const handleViewAuditLogs = () => {
    if (!isGuardian) return;
    setPopup({ kind: 'viewAuditLogs' });
  };

  // ── Menu contextuel d'un programme (clic droit dans ProgramMenu) ──
  // Ajout d'un cours au programme ciblé (admin) : préselectionne ce programme.
  const handleAddCourseToProgram = (programId: number) => {
    if (permsForProgram(programId).canManageContent) setPopup({ kind: 'addCourse', programId });
  };
  const handleEditProgram = (programId: number) => {
    if (permsForProgram(programId).canEditProgram) setPopup({ kind: 'editProgram', programId });
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
    if (!permsForProgram(programId).canManageRoles) return;
    setPopup({ kind: 'manageRoles', programId });
    void fetchProgramRoles(programId);
  };
  const handleLeaveProgram = (programId: number) => setPopup({ kind: 'leaveProgram', programId });
  // « Supprimer le programme » (menu contextuel, super-admin GLOBAL uniquement) : ouvre la
  // confirmation. La suppression réelle est faite par handleConfirmDeleteProgram (via api.deleteProgram).
  const handleDeleteProgram = (programId: number) => {
    if (permsForProgram(programId).canDeleteProgram) setPopup({ kind: 'deleteProgram', programId });
  };
  // Rejoindre des cours d'un programme (menu contextuel, TOUS les utilisateurs) : ouvre
  // le JoinCoursesPopup. L'adhésion réelle est faite par handleConfirmJoinCourses.
  const handleJoinCourses = (programId: number) => setPopup({ kind: 'joinCourses', programId });
  // Inscription aux cours choisis (via api.joinCourses). La sélection du popup REMPLACE
  // l'ensemble des cours du programme (décochés retirés, nouveaux ajoutés). On RECHARGE
  // ensuite les cours du programme (api.fetchCourses) pour que les cours fraîchement
  // rejoints arrivent avec leur contenu (canaux/quiz/forums) — joinCourses ne renvoie
  // que la méta. L'erreur remonte au popup (qui l'affiche).
  const handleConfirmJoinCourses = async (programId: number, courseIds: number[]) => {
    await api.joinCourses(programId, courseIds);
    const courses = await api.fetchCourses(programId);
    setDashboardPrograms((programs) =>
      programs.map((program) => (program.id === programId ? { ...program, courses } : program))
    );
  };
  // Création de canal / quiz / forum via le SectionEditorPopup du type concerné
  // (mêmes actions que l'édition d'une section). Réservé à l'administrateur.
  const handleCreateChannel = () => {
    if (permsForProgram(activeProgramId).canManageContent) setCreatingSectionType('text');
  };
  const handleCreateQuiz = () => {
    if (permsForProgram(activeProgramId).canManageContent) setCreatingSectionType('quiz');
  };
  const handleCreateForum = () => {
    if (permsForProgram(activeProgramId).canManageContent) setCreatingSectionType('forum');
  };
  // Persiste une modification de section (réordre/renommage/suppression/ajout) via
  // api.changeSection. Le state n'est appliqué qu'APRÈS succès (le rejet laisse la
  // sidebar inchangée) : on exerce ainsi spinner / rollback / ErrorPopup du popup.
  const handleSectionChange = async (courseId: number, sectionType: string, change: ItemChange) => {
    // Le backend renvoie le changement APPLIQUÉ (create → id RÉEL du forum) : on l'applique
    // lui, pas l'optimiste, pour que l'écho WS `section:changed` (même id) soit idempotent.
    const applied = await api.changeSection(courseId, sectionType, change);
    setDashboardPrograms((programs) =>
      programs.map((program) => ({
        ...program,
        courses: program.courses.map((course) =>
          course.id === courseId ? applySectionChange(course, sectionType, applied) : course
        ),
      }))
    );
    // Renvoyé au SectionEditorPopup : il réconcilie l'id RÉEL du forum créé dans son état
    // interne (sinon un renommage/suppression enchaîné enverrait l'id temporaire au backend).
    return applied;
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
    // Un quiz a changé → force le remontage de la vue de quiz ouverte (recharge le détail).
    setQuizRefreshKey((k) => k + 1);
  };

  // Création d'un cours (admin) → rattaché aux programmes choisis (via api.createCourse).
  // Le AddCoursePopup attend la résolution : reste ouvert + erreur si rejet, ferme si succès.
  const handleSaveCourse = async (course: NewCourse) => {
    const created = await api.createCourse(course);
    // upsert (pas append) : idempotent face à l'écho WS `course:created` de sa PROPRE
    // création (sinon le créateur verrait le cours en double si l'écho arrive pendant l'await).
    setDashboardPrograms((programs) =>
      course.programIds.reduce((acc, pid) => upsertCourse(acc, pid, created), programs)
    );
  };

  // Création d'un programme → ajouté à la liste (abonné d'office) via api.createProgram.
  const handleCreateProgram = async (program: NewProgram) => {
    const created = await api.createProgram(program);
    // upsert (pas append) : idempotent face à l'écho WS `subscription:added` de sa PROPRE
    // création (sinon le créateur verrait le programme en double).
    setDashboardPrograms((programs) => upsertProgram(programs, created));
  };

  // Adhésion → synchronise les programmes suivis (ajout ET désabonnement). `api.joinPrograms`
  // renvoie la liste à jour ; on la réconcilie en conservant les cours déjà chargés.
  const handleJoinPrograms = async (selection: JoinSelection) => {
    const updated = await api.joinPrograms(selection);
    setDashboardPrograms((programs) => {
      const byId = new Map(programs.map((p) => [p.id, p]));
      return updated.map((p) => byId.get(p.id) ?? p);
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

  // Assignation/retrait d'un rôle ↔ utilisateur DANS un programme via api.changeRole. Le
  // RoleEditorPopup ignore le programme : le Dashboard injecte le `programId` (celui du popup
  // « Gérer les rôles »). Le popup gère l'optimisme + rollback ; on ne fait que persister.
  const handleRoleChange = (programId: number, change: RoleChange) =>
    api.changeRole(programId, change);

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

  // Supprimer un programme (admin, via api.deleteProgram) — le retire pour TOUS. Même flux
  // que « quitter » : overlay de chargement, ErrorPopup en cas d'échec. Au succès : retrait
  // de la liste + bascule du programme actif s'il disparaît. Les autres clients le retirent
  // via l'écho WS `program:deleted` (onProgramRemove).
  const handleConfirmDeleteProgram = async (programId: number) => {
    setPopup(null);
    setLeaveError(null);
    setLeaveLoading(true);
    try {
      await api.deleteProgram(programId);
      if (programId === activeProgramId) {
        const fallback = dashboardPrograms.find((program) => program.id !== programId);
        setActiveProgramId(fallback?.id ?? -1);
        setSelectedCourseId(undefined);
        setSelectedChannelRef(undefined);
      }
      setDashboardPrograms((programs) => programs.filter((program) => program.id !== programId));
    } catch {
      setLeaveError('Impossible de supprimer le programme. Réessaie.');
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

  // Supprimer un cours (admin, via api.deleteCourse) — le retire pour TOUS. Même flux que
  // « quitter » : overlay de chargement, ErrorPopup en cas d'échec. Au succès : retrait du
  // cours du programme actif + reset de la sélection si c'était le cours ouvert. Les autres
  // clients le retirent via l'écho WS `course:deleted` (onCourseDelete).
  const handleConfirmDeleteCourse = async (courseId: number) => {
    setPopup(null);
    setLeaveError(null);
    setLeaveLoading(true);
    try {
      await api.deleteCourse(courseId);
      if (courseId === effectiveSelectedCourseId) {
        setSelectedCourseId(undefined);
        setSelectedChannelRef(undefined);
      }
      setDashboardPrograms((programs) => removeCourse(programs, activeProgramId, courseId));
    } catch {
      setLeaveError('Impossible de supprimer le cours. Réessaie.');
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
    avatarColor: currentUser.avatarColor,
    avatarUrl: currentUser.avatarUrl,
  };

  // Envoi / édition / suppression de message : délégués à la couche API
  // (api.sendMessage doit RENVOYER le message persisté pour la réconciliation).
  const handleSendMessage = (
    channelId: number,
    content: string,
    parentId: number | null,
    clientMessageId: string
  ) => api.sendMessage(channelId, content, parentId, clientMessageId);

  // L'édition/suppression porte sur un message du canal ACTUELLEMENT ouvert : l'API
  // route via /api/forums/{forumID}/posts/{id}, où forumID = l'id du canal sélectionné.
  const handleEditMessage = (messageId: number, content: string) =>
    api.editMessage(selectedChannelRef?.id ?? -1, messageId, content);

  const handleDeleteMessage = (messageId: number) =>
    api.deleteMessage(selectedChannelRef?.id ?? -1, messageId);

  /* ───────────────────────────────────────────────────────────────────────────
   * FORUM ('Thread') — meme architecture API + temps reel que le chat.
   * À brancher : GET sujets, POST réponse, PATCH, DELETE, POST vote, WebSocket.
   * Déjà géré côté front : loading/erreur, rollback optimiste, dédup (clientPostId),
   * désabonnement au changement de forum. Scaffold WS : src/services/appSocket.ts.
   * ─────────────────────────────────────────────────────────────────────────── */

  const handleFetchThreads = (forumId: number, before?: number, limit?: number) =>
    api.fetchThreads(forumId, before, limit);
  const handleFetchReplies = (forumId: number, postId: number) => api.fetchReplies(forumId, postId);
  const handleCreatePost = (
    forumId: number,
    content: string,
    parentId: number | null,
    clientPostId: string,
    title?: string
  ) => api.createPost(forumId, content, parentId, clientPostId, title);
  const handleEditPost = (postId: number, content: string, title?: string) =>
    api.editPost(selectedChannelRef?.id ?? -1, postId, content, title);
  const handleDeletePost = (postId: number) => api.deletePost(selectedChannelRef?.id ?? -1, postId);
  // Le vote porte sur un post du forum ACTUELLEMENT ouvert. `value` est la direction
  // cliquée (±1) fournie par useForumThreads — le backend gère l'annulation (toggle).
  const handleVotePost = (postId: number, value: number) =>
    api.votePost(selectedChannelRef?.id ?? -1, postId, value as 1 | -1);

  const activeProgram = dashboardPrograms.find((program) => program.id === activeProgramId) ?? null;
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
        quizzes: selectedCourse.quizzes,
        forums: selectedCourse.forums,
      })
    : [];
  const selectedChannel =
    selectedCourseChannels.find((channel) => isSameChannel(channel, selectedChannelRef)) ?? null;
  // Le quiz actuellement ouvert a-t-il été modifié à distance ? → rechargement de la vue.
  const openQuizId = selectedChannel?.type === 'quiz' ? selectedChannel.id : null;
  // La ref (lue depuis les closures WS, ex. resync) est synchronisée hors rendu :
  // muter une ref pendant le rendu est interdit (React 19 / react-hooks/refs).
  useEffect(() => {
    openQuizIdRef.current = openQuizId;
  }, [openQuizId]);
  const quizStale = staleQuizId != null && staleQuizId === openQuizId;

  // ── Persistance de la localisation (settings utilisateur) ──────────────────────
  // But : replacer l'utilisateur là où il était (programme → cours → canal) à la
  // session précédente. La restauration se fait en DEUX TEMPS car le chargement des
  // cours d'un programme est asynchrone : on sélectionne d'abord le programme, puis
  // le cours + le canal une fois ses cours chargés. Repli gracieux à chaque niveau
  // (le programme/cours/canal peut avoir disparu depuis — désinscription, suppression).
  const restoreStartedRef = useRef(false); // programme traité
  const restoreDoneRef = useRef(false); // cours + canal traités (débloque la sauvegarde)
  const restoreTargetRef = useRef<SavedLocation | null>(null);

  // Programme dont le chargement des cours s'est EFFECTIVEMENT terminé (transition
  // coursesLoading true→false). Indispensable pour l'étape 2 : juste après avoir posé le
  // programme, `coursesLoading` est encore `false` (le loader n'a pas encore basculé) alors
  // que la liste de cours est vide (fetchPrograms renvoie `courses: []`). Sans ce repère,
  // l'étape 2 verrait une liste vide et abandonnerait la restauration du cours/canal.
  const coursesLoadedForRef = useRef<number | null>(null);
  const prevCoursesLoadingRef = useRef(false);
  useEffect(() => {
    if (prevCoursesLoadingRef.current && !coursesLoading) {
      coursesLoadedForRef.current = activeProgramId;
    }
    prevCoursesLoadingRef.current = coursesLoading;
  }, [coursesLoading, activeProgramId]);

  // Étape 1 : sélectionner le programme sauvegardé, une fois la liste chargée.
  useEffect(() => {
    if (restoreStartedRef.current) return;
    if (profileLoading || currentUser.id < 0) return; // profil (donc settings) pas prêt
    if (programsLoading) return; // liste des programmes pas prête
    restoreStartedRef.current = true;

    const loc = settings.location;
    const programExists =
      loc?.programId != null && dashboardPrograms.some((p) => p.id === loc.programId);
    if (programExists) {
      restoreTargetRef.current = loc ?? null;
      // Synchronisation légitime d'un état PERSISTÉ (settings BD) → état React, une seule
      // fois après chargement asynchrone : pas dérivable au rendu.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveProgramId(loc!.programId!);
      // Le cours + le canal sont restaurés par l'étape 2 (après chargement des cours).
    } else {
      restoreDoneRef.current = true; // rien à restaurer → la sauvegarde peut démarrer
    }
  }, [profileLoading, currentUser.id, programsLoading, dashboardPrograms, settings]);

  // Étape 2 : sélectionner le cours + le canal une fois les cours du programme chargés.
  useEffect(() => {
    if (restoreDoneRef.current || !restoreStartedRef.current) return;
    const target = restoreTargetRef.current;
    if (!target || activeProgramId !== target.programId) return;
    // Attendre la FIN effective du chargement des cours de ce programme. On ne se fie PAS
    // au seul instantané `coursesLoading` (false pendant la fenêtre initiale) : on exige
    // qu'un chargement se soit terminé pour CE programme (coursesLoadedForRef).
    if (coursesLoading || coursesLoadedForRef.current !== activeProgramId) return;

    const courseList = dashboardPrograms.find((p) => p.id === activeProgramId)?.courses ?? [];
    if (target.courseId != null && courseList.some((c) => c.id === target.courseId)) {
      // Restauration one-shot d'un état persisté (cf. étape 1).
      setSelectedCourseId(target.courseId);
      // Canal restauré tel quel : la dérivation `selectedChannel` retombe sur `null`
      // si le canal n'existe plus (repli gracieux), sans casser l'affichage.
      if (target.channel) setSelectedChannelRef(target.channel);
    }
    restoreDoneRef.current = true;
  }, [activeProgramId, coursesLoading, dashboardPrograms]);

  // Sauvegarde debouncée à chaque changement de position (une fois la restauration
  // terminée, pour ne pas écraser la localisation sauvegardée par l'état par défaut).
  // On enregistre le cours EFFECTIVEMENT affiché (repli inclus) plutôt que la sélection
  // brute, pour restaurer exactement ce que l'utilisateur voyait.
  useEffect(() => {
    if (!restoreDoneRef.current) return;
    if (activeProgramId < 0) return; // pas de position réelle à mémoriser
    saveSettings({
      location: {
        programId: activeProgramId,
        courseId: effectiveSelectedCourseId,
        channel: selectedChannelRef,
      },
    });
  }, [activeProgramId, effectiveSelectedCourseId, selectedChannelRef, saveSettings]);

  // Charge l'historique d'un canal : entièrement délégué à api.fetchMessages.
  const handleFetchMessages = (channelId: number, before?: number, limit?: number) =>
    api.fetchMessages(channelId, before, limit);

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
  // Cours ciblé par la confirmation « Supprimer le cours » (dans le programme actif).
  const deletingCourse =
    popup?.kind === 'deleteCourse'
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
        mobileTitlePrefix={
          selectedChannel ? <ChannelTypeIcon type={selectedChannel.type} /> : undefined
        }
        mobileTitle={selectedChannel ? selectedChannel.name : undefined}
        mobileUserInitial={mobileUserInitial}
        mobileUserMenu={
          <UserMenu
            variant="compact"
            user={currentUser}
            loading={profileLoading}
            onEditProfile={handleEditProfile}
            onManageAdmins={isAdmin ? handleManageAdmins : undefined}
            onViewAuditLogs={isGuardian ? handleViewAuditLogs : undefined}
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

              setSelectedCourseId(
                getEffectiveSelectedCourseId(nextProgram?.courses ?? [], undefined)
              );
            }}
            onAddProgram={handleAddProgram}
            loading={programsLoading}
            loadError={programsError}
            onReload={reloadPrograms}
            isGlobalAdmin={isAdmin}
            onAddCourseToProgram={handleAddCourseToProgram}
            onEditProgram={handleEditProgram}
            onManageRoles={handleManageRoles}
            onDeleteProgram={handleDeleteProgram}
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
            // Gestion du contenu du programme actif (Enseignant / Administrateur / super-admin).
            isAdmin={permsForProgram(activeProgramId).canManageContent}
            // CourseMenu ne reflète QUE le fetch des cours (qui n'a lieu qu'après
            // le succès du fetch programmes) → pas d'illusion de fetch parallèle.
            loading={coursesLoading}
            loadError={coursesError}
            onReloadCourses={reloadCourses}
            onAddCourse={handleAddCourse}
            onEditCourse={handleEditCourse}
            onOpenMcpManagement={handleOpenMcpManagement}
            onLeaveCourse={handleLeaveCourse}
            onDeleteCourse={handleDeleteCourse}
            onEditProfile={handleEditProfile}
            onManageAdmins={isAdmin ? handleManageAdmins : undefined}
            onViewAuditLogs={isGuardian ? handleViewAuditLogs : undefined}
            onLogout={handleLogout}
            // Crayon section quiz → éditeur peuplé via le mock (cf. dashboardApi).
            quizHandlers={quizEditorHandlers}
            onQuizzesChange={handleQuizzesChange}
          />
        }
      />

      <MainPanel
        isAdmin={permsForProgram(activeProgramId).canManageContent}
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
        // Rejoindre un programme — offert à tous depuis l'état « aucun programme ».
        onJoinProgram={handleJoinProgram}
        onAddCourse={handleAddCourse}
        // Rejoindre un cours du programme actif — offert à tous depuis l'état « aucun cours ».
        onJoinCourse={() => handleJoinCourses(activeProgramId)}
        onCreateChannel={handleCreateChannel}
        onCreateQuiz={handleCreateQuiz}
        onCreateForum={handleCreateForum}
        // ── Quiz : détail + résultat (réhydratation) + soumission (cf. dashboardApi). ──
        onFetchQuiz={api.fetchQuiz}
        onFetchAttempts={api.fetchQuizAttempts}
        onFetchAttemptResult={api.fetchAttemptResult}
        onSubmitQuiz={api.submitQuiz}
        attemptOutcome={attemptOutcome}
        onRunCode={api.runCode}
        quizRefreshKey={quizRefreshKey}
        quizStale={quizStale}
        onReloadStale={() => setStaleQuizId(null)}
      />

      {/* Création d'un canal / quiz / forum depuis un état vide : même popup que
          l'édition d'une section dans le CourseMenu (réservé à l'admin via les
          boutons des états). */}
      {creatingSection && selectedCourse && (
        <CourseSectionEditor
          section={creatingSection}
          channels={selectedCourseChannels}
          onChange={(change) =>
            handleSectionChange(selectedCourse.id, creatingSection.type, change)
          }
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
          // Programmes chargés PAR ÉTABLISSEMENT, filtrés à ceux que l'utilisateur peut gérer
          // (admin/prof, ou tous si admin global/gardien). Le backend applique la même règle.
          loadEstablishments={api.fetchEstablishments}
          loadPrograms={api.fetchManageableProgramsInEstablishment}
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
          // 3e option du menu (gardien uniquement) : étape de gestion des établissements.
          canManageEstablishments={isGuardian}
          loadEstablishments={api.fetchEstablishments}
          onCreateEstablishment={api.createEstablishment}
          onUpdateEstablishment={api.updateEstablishment}
          onDeleteEstablishment={api.deleteEstablishment}
          // Temps réel : le nombre de programmes d'un établissement se met à jour LIVE dans le
          // popup (création de programme par soi ou un autre gardien). `ws` est stable (useMemo).
          subscribeEstablishmentUpdates={ws.establishments.subscribe}
          initialView={popup.view ?? 'menu'}
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
        <ErrorPopup content={roleError} onClose={() => setPopup(null)} />
      )}
      {popup?.kind === 'manageRoles' && popupProgram && !roleLoading && !roleError && roleData && (
        <RoleEditorPopup
          onClose={() => setPopup(null)}
          roles={roleData.roles}
          users={roleData.users}
          onChange={(change) => handleRoleChange(popupProgram.id, change)}
          // Candidats chargés côté SERVEUR (pagination 10 par 10 + recherche BD) parmi les
          // MEMBRES du programme (User_Program) n'ayant pas encore le rôle.
          loadCandidates={(roleId, search, page, size) =>
            api.fetchProgramRoleCandidates(popupProgram.id, roleId, search, page, size)
          }
        />
      )}

      {/* Gestion des ADMINISTRATEURS (rôles globaux / plateforme) — accès depuis le profil.
          Gating par rôle :
            - gardien : ajoute/retire admins généraux ET gardiens, sauf SON PROPRE
              rôle gardien (anti-lockout) ;
            - admin général : ajoute seulement des admins généraux, ne retire rien. */}
      {popup?.kind === 'manageGlobalRoles' && globalRoleLoading && (
        <div className={styles.loadingOverlay} role="status" aria-live="polite" aria-busy="true">
          <Spinner size={36} />
        </div>
      )}
      {popup?.kind === 'manageGlobalRoles' && !globalRoleLoading && globalRoleError && (
        <ErrorPopup content={globalRoleError} onClose={() => setPopup(null)} />
      )}
      {popup?.kind === 'manageGlobalRoles' &&
        !globalRoleLoading &&
        !globalRoleError &&
        globalRoleData && (
          <RoleEditorPopup
            onClose={() => setPopup(null)}
            roles={globalRoleData.roles}
            users={globalRoleData.users}
            onChange={handleGlobalRoleChange}
            // Candidats chargés côté SERVEUR (pagination 10 par 10 + recherche BD) : la liste
            // « tous les utilisateurs » peut être grande, on ne la charge pas d'un coup.
            loadCandidates={(roleId, search, page, size) =>
              api.fetchGlobalRoleCandidates(roleId, search, page, size)
            }
            // Temps réel : la liste se met à jour LIVE si un autre admin/gardien modifie une
            // assignation pendant que le popup est ouvert (room dédiée `adminRoles:0`).
            subscribeUpdates={subscribeAdminRoles}
            labels={{
              title: 'Gérer les administrateurs',
              subtitle: 'Administrateurs généraux et gardiens de la plateforme.',
            }}
            canAssign={(roleId) => {
              const name = globalRoleData.roles.find((r) => r.id === roleId)?.name;
              // Gardien : peut tout attribuer. Admin général : uniquement « Administrateur ».
              return isGuardian || name === ROLE.ADMIN;
            }}
            canUnassign={(roleId, userId) => {
              if (!isGuardian) return false; // l'admin général ne retire personne
              const name = globalRoleData.roles.find((r) => r.id === roleId)?.name;
              // Anti-lockout : un gardien ne peut pas retirer SON PROPRE rôle gardien.
              if (name === ROLE.GUARDIAN && userId === currentUser.id) return false;
              return true;
            }}
          />
        )}

      {/* Journal d'audit (actions de gestion) — réservé au Gardien. Le popup charge
          lui-même les entrées (spinner + ErrorPopup/réessayer intégrés). */}
      {popup?.kind === 'viewAuditLogs' && (
        <AuditLogsPopup onClose={() => setPopup(null)} load={(q) => api.fetchAuditLogs(q)} />
      )}

      {/* Gestion MCP d'un cours (menu contextuel du sélecteur de cours, admin). */}
      {popup?.kind === 'mcp' && mcpCourse && (
        <McpManagementPopup
          courseId={mcpCourse.id}
          courseLabel={mcpCourse.code || mcpCourse.name || 'Cours'}
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
              // Progression : idem, seul le lanceur (verrou par (cours, user)) l'affiche.
              onAnalysisProgress: (launcherId, step) => {
                if (launcherId === currentUser.id) handlers.onProgress(step);
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

      {/* Supprimer un programme — confirmation (menu contextuel, admin). Action DÉFINITIVE
          et pour TOUS : suppression en cascade (abonnements, liens cours, rôles). */}
      {popup?.kind === 'deleteProgram' && popupProgram && (
        <DeleteConfirmationPopup
          title="Supprimer le programme ?"
          content={`Le programme « ${popupProgram.name} » sera supprimé définitivement pour tous ses membres (abonnements et accès retirés). Les cours partagés avec d'autres programmes sont conservés. Cette action est irréversible.`}
          labels={{ confirm: 'Supprimer' }}
          onDeleteConfirmation={() => handleConfirmDeleteProgram(popupProgram.id)}
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

      {/* Supprimer un cours — confirmation (menu contextuel, admin). Action DÉFINITIVE et
          pour TOUS : suppression en cascade (sections, quiz, forums, inscriptions). */}
      {popup?.kind === 'deleteCourse' && deletingCourse && (
        <DeleteConfirmationPopup
          title="Supprimer le cours ?"
          content={`Le cours « ${deletingCourse.code ?? deletingCourse.title ?? 'ce cours'} » et tout son contenu (canaux, quiz, forums) seront supprimés définitivement pour tous les inscrits. Cette action est irréversible.`}
          labels={{ confirm: 'Supprimer' }}
          onDeleteConfirmation={() => handleConfirmDeleteCourse(deletingCourse.id)}
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
    program.id === programId ? { ...program, courses: program.courses.map(mapCourse) } : program
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
        ? // Cours existant → fusion META seulement (titre/code). Ses sections (quiz, canaux,
          // forums) ont leurs PROPRES events WS (quiz:*, section:changed) : un `course:edited`
          // ne doit PAS les écraser (son DTO ne les porte pas), sinon elles disparaîtraient.
          program.courses.map((c) =>
            c.id === course.id ? { ...c, title: course.title, code: course.code } : c
          )
        : [...program.courses, course],
    };
  });
}

/**
 * Met à jour la MÉTA (titre/code) d'un cours DÉJÀ présent dans un programme. N'AJOUTE
 * jamais de cours : les events WS `course:created`/`course:edited` sont diffusés à TOUS les
 * abonnés du programme, mais la sidebar ne liste que les cours où l'utilisateur est INSCRIT
 * (on n'y entre que par une inscription). Un cours absent (= non inscrit) → no-op, sinon un
 * cours fraîchement créé apparaîtrait comme « rejoint » chez des non-inscrits.
 */
function updateCourseMeta(programs: DemoProgram[], programId: number, course: Course): DemoProgram[] {
  return programs.map((program) =>
    program.id === programId
      ? {
          ...program,
          courses: program.courses.map((c) =>
            c.id === course.id ? { ...c, title: course.title, code: course.code } : c
          ),
        }
      : program
  );
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
    case 'create': {
      // id RÉEL fourni par le backend (via handleSectionChange / écho WS) → on l'utilise ;
      // à défaut un id temporaire. Dédup par id : l'écho WS de sa propre création (ou une
      // double réception) ne crée pas de doublon.
      const id =
        change.item.id != null && change.item.id !== ''
          ? Number(change.item.id)
          : nextNumericId(forums);
      if (forums.some((f) => f.id === id)) return reposition(forums);
      return reposition([...forums, { id, title: change.item.name, fType: fType }]);
    }
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
