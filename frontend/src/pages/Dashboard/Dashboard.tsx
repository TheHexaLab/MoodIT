import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProgramMenu, { type Program } from '../../components/ProgramMenu/ProgramMenu.tsx';
import { useProgramsLoader } from '../../components/ProgramMenu/useProgramsLoader.ts';
import CourseMenu, { type Course } from '../../components/CourseMenu/CourseMenu.tsx';
import { useCoursesLoader } from '../../components/CourseMenu/useCoursesLoader.ts';
import { CourseSectionEditor } from '../../components/CourseMenu/CourseSectionEditor.tsx';
import {
  type ChannelMessage,
  type ChannelMessageAuthor,
  type ChannelRef,
  type ChannelTypeDefinition,
  type CourseChannel,
  isSameChannel,
} from '../../components/CourseChannelList/CourseChannelList.tsx';
import { defaultTypeDefinitions } from '../../components/CourseChannelList/channelTypeDefinitions.ts';
import { AddCoursePopup, type NewCourse } from '../../components/AddCoursePopup/AddCoursePopup.tsx';
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
import {
  EditProfilePopup,
  type ProfileUpdate,
} from '../../components/EditProfilePopup/EditProfilePopup.tsx';
import {
  RoleEditorPopup,
  type Role,
  type RoleChange,
  type User,
} from '../../components/RoleEditorPopup/RoleEditorPopup.tsx';
import { DeleteConfirmationPopup } from '../../components/DeleteConfirmationPopup/DeleteConfirmationPopup.tsx';
import { ErrorPopup } from '../../components/ErrorPopup/ErrorPopup.tsx';
import {
  getCreateEstablishments,
  getEstablishmentPrograms,
  getJoinEstablishments,
} from '../../mocks/subscriptionData.ts';
import { getProgramRoles, getProgramUsers } from '../../mocks/roleData.ts';
import { getPrefixForType } from '../../components/CourseChannelList/channelTypePrefix.ts';
import { type ItemChange } from '../../components/SectionEditorPopup/types.ts';

// Client WebSocket réel : UNE seule connexion sert le chat, le forum, les cours et
// les programmes (quatre facades) — étape [5] du HANDOFF.
import { createAppSocket } from '../../services/appSocket.ts';
import { getToken } from '../../helpers/auth.ts';
import { getMe, updateMe } from '../../helpers/api.ts';
import {
  getMockForumReplies,
  getMockForumThreads,
  type ForumPost,
} from '../../components/MainPanel/ForumView/forumThreads.ts';
import UserMenu, { type UserMenuUser } from '../../components/UserMenu/UserMenu.tsx';
import LeftMenuGroup from '../../components/LeftMenuGroup/LeftMenuGroup.tsx';
import {
  normalizeCourseChannelsFromSources,
  type ForumChannelSource,
  type ForumType,
  type QuizChannelSource,
} from '../../components/CourseChannelList/courseChannelSources.ts';
import MainPanel from '../../components/MainPanel/MainPanel.tsx';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import { type DemoProgram } from '../../mocks/dashboardData.ts';
import styles from './Dashboard.module.css';

// Identité neutre affichée tant que GET /api/me n'a pas répondu : aucun faux nom.
// L'UI retombe sur 'Utilisateur' / 'U' (cf. getDisplayName / getUserInitial) jusqu'à
// ce que le vrai profil arrive et remplace cette valeur via setCurrentUser.
const loadingUser: UserMenuUser = {
  id: -1,
  username: '',
  firstName: '',
  lastName: '',
  avatarColor: '#0a5cc0',
};

// TODO : id mock pour l'abonnement temps réel (scope utilisateur). À remplacer par
// l'id réel issu de GET /api/me une fois la (re)souscription branchée sur currentUser.
const MOCK_REALTIME_USER_ID = 1;

// Nom du rôle global (table Role) qui accorde les droits d'édition (cours,
// programmes, sections, gestion des rôles). Les rôles enseignant PAR programme
// (User_Program_Role) ne sont pas encore gérés ici.
const ADMIN_ROLE_NAME = 'Administrateur';

// Mettre à true pour tester le chemin d'échec (rollback + ErrorPopup) des
// operations sur les messages : envoi, modification, suppression.
const SIMULATE_SEND_FAILURE = false;
const SIMULATE_DELAY = 100;
const SIMULATE_FETCH_FAILURE = false;

/* ─────────────────────────────────────────────────────────────────────────────
 * TODO — BRANCHEMENT BACKEND + TEMPS RÉEL DU CHAT
 * Détails complets : src/components/MainPanel/ChannelView/HANDOFF.md
 *
 * Ordre de développement conseillé (chaque étape est isolée et testable) :
 *   [1] GET    messages    → handleFetchMessages   (afficher l'historique d'abord)
 *   [2] POST   message     → handleSendMessage     (RENVOYER le message persisté + clientMsgId)
 *   [3] PATCH  message     → handleEditMessage
 *   [4] DELETE message     → handleDeleteMessage
 *   [5] WebSocket          → remplacer les mocks par `createAppSocket(...)` (UNE connexion
 *                            pour le chat ET le forum ; scaffold prêt : src/services/appSocket.ts)
 *
 * Déjà géré côté front (ne rien recoder) : états loading/erreur, rollback optimiste,
 * déduplication optimiste ↔ écho (clientMsgId), désabonnement au changement de canal.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Popup ouvert dans le Dashboard, avec le contexte nécessaire à son rendu. */
type PopupState =
  | { kind: 'addCourse'; programId: number } // programId = programme préselectionné
  | { kind: 'addSubscription' }
  | { kind: 'editCourse'; courseId: number }
  | { kind: 'editProfile' }
  | { kind: 'editProgram'; programId: number }
  | { kind: 'manageRoles'; programId: number }
  | { kind: 'leaveProgram'; programId: number };

export default function Dashboard() {
  // Les programmes (et leurs cours/canaux) vivent dans un state : ainsi les
  // modifications de section (réordre, renommage, ajout, suppression) se
  // reflètent dans l'UI. Le mock ne sert que de valeur initiale.
  const [dashboardPrograms, setDashboardPrograms] = useState<DemoProgram[]>(getDashboardPrograms);
  // Utilisateur connecté dans un state : les modifications de profil (nom, couleur)
  // se reflètent dans la barre de profil. Le mock ne sert que de valeur initiale.
  const [currentUser, setCurrentUser] = useState<UserMenuUser>(loadingUser);
  // Profil en cours de chargement (GET /api/me) : pilote le skeleton du UserMenu.
  const [profileLoading, setProfileLoading] = useState(true);
  // Droits d'édition dérivés des rôles globaux réels (false tant que /api/me n'a pas
  // répondu → aucun bouton d'édition ne « flashe » pendant le chargement).
  const isAdmin = currentUser.roles?.some((role) => role.name === ADMIN_ROLE_NAME) ?? false;
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

  // Profil réel de l'utilisateur connecté (GET /api/me). Remplace l'identité neutre
  // `loadingUser` dès la réponse. En cas d'échec autre que 401 (déjà géré par apiFetch
  // → /login), on conserve la valeur de chargement plutôt que de bloquer l'UI.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (!cancelled) setCurrentUser(user);
      })
      .catch(() => {
        // 401 → redirection gérée par apiFetch ; autres erreurs : on garde la valeur
        // de chargement (skeleton retiré quand même pour ne pas figer l'UI).
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refs vers l'état courant : permettent au handler du socket programmes (abonné
  // une seule fois) de lire la liste / le programme actif sans capture périmée.
  const programsRef = useRef(dashboardPrograms);
  const activeProgramIdRef = useRef(activeProgramId);
  useEffect(() => {
    programsRef.current = dashboardPrograms;
    activeProgramIdRef.current = activeProgramId;
  });

  // GET de la liste des programmes de l'utilisateur. Mock-as-cache (délai + échec
  // simulés) : on n'expose que loading/erreur, la liste vit dans dashboardPrograms.
  // TODO : remplacer par un vrai GET /me/programs → setDashboardPrograms.
  const handleFetchPrograms = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des programmes)');
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
    const userId = MOCK_REALTIME_USER_ID;
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
  }, [ws]);
  // GET des cours du programme actif. Mock pour l'instant (délai + échec optionnel) :
  // le state `dashboardPrograms` fait office de cache, on n'expose que loading/erreur.
  // TODO [1] : remplacer par un vrai GET /programs/:id/courses → setDashboardPrograms.
  // (reçoit programId du hook ; ignoré ici car le mock utilise le state comme cache.)
  const handleFetchCourses = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des cours)');
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

  // TODO : remplacer par une navigation ou un rendu de vue lors de l'implémentation des canaux.
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
  // Ouvre le EditProfilePopup (menu du compte).
  const handleEditProfile = () => setPopup({ kind: 'editProfile' });
  // TODO : déconnecter l'utilisateur (clear session + redirection login).
  const handleLogout = () => console.log('[Dashboard] Déconnexion demandée.');

  // ── Menu contextuel d'un programme (clic droit dans ProgramMenu) ──
  // Ajout d'un cours au programme ciblé (admin) : préselectionne ce programme.
  const handleAddCourseToProgram = (programId: number) => {
    if (isAdmin) setPopup({ kind: 'addCourse', programId });
  };
  const handleEditProgram = (programId: number) => {
    if (isAdmin) setPopup({ kind: 'editProgram', programId });
  };
  // GET rôles + membres d'un programme (API-ready : délai + échec simulés).
  // TODO : GET /programs/:id/roles + /programs/:id/members.
  const fetchProgramRoles = async (programId: number) => {
    setRoleData(null);
    setRoleError(null);
    setRoleLoading(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
      if (SIMULATE_FETCH_FAILURE) throw new Error('fetch roles failed');
      setRoleData({ roles: getProgramRoles(), users: getProgramUsers(programId) });
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
  // Persiste une modification de section (réordre/renommage/suppression/ajout).
  // Branché sur l'API simulée (délai + échec optionnel) comme les handlers de
  // messages : on exerce ainsi le spinner, le rollback optimiste et l'ErrorPopup
  // du SectionEditorPopup. Le state n'est appliqué qu'après succès, pour que le
  // rejet laisse la sidebar inchangée. TODO : POST/PATCH/DELETE backend + refetch.
  const handleSectionChange = async (
    courseId: number,
    sectionType: string,
    change: ItemChange
  ) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de section)');
    setDashboardPrograms((programs) =>
      programs.map((program) => ({
        ...program,
        courses: program.courses.map((course) =>
          course.id === courseId ? applySectionChange(course, sectionType, change) : course
        ),
      }))
    );
  };

  // POST d'un nouveau cours (admin) → rattaché aux programmes choisis. Async
  // (délai + échec simulé) : le AddCoursePopup attend la résolution, reste ouvert
  // et affiche une erreur si ça rejette, et se ferme via onClose en cas de succès.
  // TODO : POST /courses (title, code, program_ids) puis refetch / setState.
  const handleSaveCourse = async (course: NewCourse) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (ajout de cours)');
    setDashboardPrograms((programs) =>
      programs.map((program) =>
        course.programIds.includes(program.id)
          ? {
              ...program,
              courses: [
                ...program.courses,
                {
                  id: nextNumericId(program.courses),
                  code: course.code,
                  title: course.title,
                  channels: [],
                  quizzes: [],
                  forums: [],
                },
              ],
            }
          : program
      )
    );
  };

  // POST création d'un programme → ajouté à la liste de l'utilisateur (abonné d'office).
  // TODO : POST /programs (+ abonnement) puis refetch / setState.
  const handleCreateProgram = async (program: NewProgram) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (création de programme)');
    setDashboardPrograms((programs) => [
      ...programs,
      {
        id: nextNumericId(programs),
        name: program.name,
        code: program.code,
        cohort: program.cohort,
        color: program.color,
        courses: [],
      },
    ]);
  };

  // POST adhésion → ajoute les programmes choisis du catalogue à la liste de l'utilisateur.
  // TODO : POST /subscriptions (program_ids) puis refetch / setState.
  const handleJoinPrograms = async (selection: JoinSelection) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (adhésion au programme)');
    setDashboardPrograms((programs) => {
      const existing = new Set(programs.map((p) => p.id));
      const added = getEstablishmentPrograms(selection.establishmentId)
        .filter((p) => selection.programIds.includes(p.id) && !existing.has(p.id))
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

  // Loaders du AddSubscriptionPopup (GET, API-ready ; respectent SIMULATE_FETCH_FAILURE).
  const loadCreateEstablishments = async () => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (établissements)');
    return getCreateEstablishments();
  };
  const loadJoinEstablishments = async () => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (établissements)');
    return getJoinEstablishments();
  };
  const loadEstablishmentPrograms = async (establishmentId: number) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (programmes de l’établissement)');
    return getEstablishmentPrograms(establishmentId);
  };

  // PATCH d'un cours (admin) → met à jour code/titre dans le programme actif.
  // TODO : PATCH /courses/:id (+ program_course pour le rattachement many-to-many).
  const handleUpdateCourse = async (courseId: number, update: CourseUpdate) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de cours)');
    setDashboardPrograms((programs) =>
      mapProgramCourses(programs, activeProgramId, (course) =>
        course.id === courseId ? { ...course, code: update.code, title: update.title } : course
      )
    );
  };

  // PATCH d'un programme (admin) → met à jour nom/code/cohorte/couleur.
  // TODO : PATCH /programs/:id.
  const handleUpdateProgram = async (programId: number, update: ProgramUpdate) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de programme)');
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

  // PATCH /api/me : prénom, nom, couleur. Si onSave rejette, EditProfilePopup garde
  // le popup ouvert et affiche l'erreur. Au succès, on applique le profil renvoyé
  // par le backend (source de vérité) → la barre de profil se met à jour.
  // TODO : upload de la photo (multipart) — non géré côté backend pour l'instant.
  const handleSaveProfile = async (profile: ProfileUpdate) => {
    const updated = await updateMe({
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatarColor: profile.avatarColor,
    });
    setCurrentUser(updated);
  };

  // INSERT/DELETE d'une assignation rôle ↔ utilisateur (admin). Le RoleEditorPopup
  // gère l'optimisme + rollback ; on ne fait que persister (mock).
  // TODO : POST/DELETE /programs/:id/roles (assign / unassign).
  const handleRoleChange = async (change: RoleChange) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (assignation de rôle)');
    console.log('[Dashboard] Changement de rôle :', change);
  };

  // Quitter un programme (async, API-ready). On ferme la confirmation puis on
  // affiche un overlay de chargement ; en cas d'échec, un ErrorPopup (sans retrait).
  // Au succès : retrait de la liste + bascule du programme actif s'il disparaît.
  // TODO : DELETE /subscriptions/:programId.
  const handleConfirmLeaveProgram = async (programId: number) => {
    setPopup(null);
    setLeaveError(null);
    setLeaveLoading(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
      if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (quitter le programme)');
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

  // Auteur des messages envoyés = utilisateur connecte (colonnes utiles de User_).
  const currentUserAuthor: ChannelMessageAuthor = {
    id: currentUser.id,
    username: currentUser.username,
    firstName: currentUser.firstName ?? '',
    lastName: currentUser.lastName ?? '',
  };

  // TODO [2] — API POST du message (postParentId si réponse).
  // ⚠ RENVOYER le message persisté (id réel) pour la réconciliation, et stocker le
  //   clientMessageId pour que le broadcast WS le renvoie (dédup). Voir HANDOFF.md.
  const handleSendMessage = async (
    content: string,
    parentId: number | null,
    clientMessageId: string
  ) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (envoi de message)');
    console.log(
      '[Dashboard] Envoi de message :',
      content,
      '(postParentId =',
      parentId,
      ', clientMsgId =',
      clientMessageId,
      ')'
    );
  };

  // TODO [3] — API PATCH du message. Simulation pour l'instant.
  const handleEditMessage = async (messageId: number, content: string) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de message)');
    console.log('[Dashboard] Modification du message', messageId, ':', content);
  };

  // TODO [4] — API DELETE du message. Simulation pour l'instant.
  const handleDeleteMessage = async (messageId: number) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (suppression de message)');
    console.log('[Dashboard] Suppression du message', messageId);
  };

  /* ───────────────────────────────────────────────────────────────────────────
   * FORUM ('Thread') — meme architecture API + temps reel que le chat.
   * À brancher : GET sujets, POST réponse, PATCH, DELETE, POST vote, WebSocket.
   * Déjà géré côté front : loading/erreur, rollback optimiste, dédup (clientPostId),
   * désabonnement au changement de forum. Scaffold WS : src/services/appSocket.ts.
   * ─────────────────────────────────────────────────────────────────────────── */

  // GET sujets RACINES d'un forum (sans leurs réponses : chargement paresseux).
  const handleFetchThreads = async (forumId: number): Promise<ForumPost[]> => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des sujets)');
    return getMockForumThreads(forumId);
  };

  // GET réponses DIRECTES d'un post (enfants immédiats), au dépliage d'un fil.
  const handleFetchReplies = async (postId: number): Promise<ForumPost[]> => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des réponses)');
    return getMockForumReplies(postId);
  };

  // POST réponse (postParentId si réponse à un post). ⚠ RENVOYER le post persisté
  // (id réel + meme clientPostId) pour la réconciliation optimiste ↔ écho WS.
  const handleCreatePost = async (
    content: string,
    parentId: number | null,
    clientPostId: string,
    title?: string
  ) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (publication)');
    console.log(
      '[Dashboard] Publication :',
      title ? `« ${title} » — ` : '',
      content,
      '(parent =',
      parentId,
      ', clientPostId =',
      clientPostId,
      ')'
    );
  };

  // PATCH post.
  const handleEditPost = async (postId: number, content: string) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (modification de post)');
    console.log('[Dashboard] Modification du post', postId, ':', content);
  };

  // DELETE post (cascade du sous-fil côté BD).
  const handleDeletePost = async (postId: number) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (suppression de post)');
    console.log('[Dashboard] Suppression du post', postId);
  };

  // POST/DELETE vote (value ∈ {-1, 0, 1} ; 0 = retrait).
  const handleVotePost = async (postId: number, value: number) => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_SEND_FAILURE) throw new Error('Échec simulé (vote)');
    console.log('[Dashboard] Vote sur le post', postId, ':', value);
  };

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

  // TODO [1] — API GET charger l'historique du canal.
  // Simulation pour l'instant : petit délai pour montrer l'état « Chargement… »,
  // puis on renvoie les messages mock du canal demandé.
  const handleFetchMessages = async (channelId: number): Promise<ChannelMessage[]> => {
    await new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));
    if (SIMULATE_FETCH_FAILURE) throw new Error('Échec simulé (chargement des messages)');
    return selectedChannel?.id === channelId ? (selectedChannel.messages ?? []) : [];
  };

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
  // Programme ciblé par un popup contextuel (édition / rôles / quitter).
  const popupProgram =
    popup && 'programId' in popup
      ? (dashboardPrograms.find((program) => program.id === popup.programId) ?? null)
      : null;

  return (
    <div className={styles.dashboardLayout}>
      <LeftMenuGroup
        mobileTitlePrefix={selectedChannel ? getPrefixForType(selectedChannel.type) : undefined}
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
            onEditProfile={handleEditProfile}
            onLogout={handleLogout}
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
          onSave={handleSaveProfile}
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
        <div className={styles.loadingOverlay} role="status" aria-live="polite">
          <span className={styles.loadingSpinner} aria-hidden="true" />
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

      {/* Sortie de programme en cours (DELETE) : overlay puis ErrorPopup si échec. */}
      {leaveLoading && (
        <div className={styles.loadingOverlay} role="status" aria-live="polite">
          <span className={styles.loadingSpinner} aria-hidden="true" />
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
