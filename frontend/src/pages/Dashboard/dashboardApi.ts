// Couche « API » du Dashboard, regroupée ici pour un seul point de bascule vers le
// vrai backend. POUR L'INSTANT chaque fonction simule l'appel réseau (latence +
// échec optionnel) et renvoie des données mock — mais la signature est déjà celle
// attendue. Le Dashboard se contente d'orchestrer l'état autour.
//
// TODO (global) : remplacer le corps de chaque fonction `simulate*` ci-dessous
// par un vrai apiFetch(...) (cf. src/helpers/api.ts), sans toucher au Dashboard.

import type { NewCourse } from '../../components/AddCoursePopup/types.ts';
import type { JoinSelection, NewProgram } from '../../components/AddSubscriptionPopup/types.ts';
import type { CourseUpdate } from '../../components/UpdateCoursePopup/types.ts';
import type { ProgramUpdate } from '../../components/UpdateProgramPopup/types.ts';
import type { RoleChange } from '../../components/RoleEditorPopup/types.ts';
import type { ItemChange } from '../../components/SectionEditorPopup/types.ts';
import type { ChannelMessage } from '../../types/domain.ts';
import {
  getMockForumReplies,
  getMockForumThreads,
} from '../../components/MainPanel/ForumView/forumThreads.ts';
import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import type { Course, McpResponse, McpResponseSummary } from '../../types/domain.ts';
import {
  clearAnalysisPending,
  generateMcpResponse,
  getMcpResponse,
  getMcpResponseSummaries,
  isAnalysisPending,
  markAnalysisPending,
} from '../../mocks/mcpData.ts';
import { getEstablishmentPrograms } from '../../mocks/subscriptionData.ts';
import { getProgramRoles, getProgramUsers } from '../../mocks/roleData.ts';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import type { DemoProgram } from '../../mocks/dashboardData.ts';
import { apiFetch } from '../../helpers/api.ts';
import type { JoinableCourse } from '../../components/JoinCoursesPopup/types.ts';
// Ré-exporté pour que le Dashboard n'ait pas à dépendre du dossier mock.
export type { DemoProgram };

// ── Simulation réseau (à retirer au branchement réel) ──────────────────────────
const SIMULATE_DELAY = 100;
const SIMULATE_SEND_FAILURE: boolean = false;
const SIMULATE_FETCH_FAILURE: boolean = false;
// Durée simulée d'un job MCP (génération) avant le push de complétion.
const MOCK_MCP_JOB_MS = 2500;

const wait = () => new Promise((resolve) => setTimeout(resolve, SIMULATE_DELAY));

/** Latence + échec simulés d'une LECTURE (GET). */
async function simulateFetch(errorMessage: string): Promise<void> {
  await wait();
  if (SIMULATE_FETCH_FAILURE) throw new Error(errorMessage);
}

/** Latence + échec simulés d'une ÉCRITURE (POST/PATCH/DELETE). */
async function simulateWrite(errorMessage: string): Promise<void> {
  await wait();
  if (SIMULATE_SEND_FAILURE) throw new Error(errorMessage);
}

// Ids « serveur » simulés pour les entités créées (démarrés haut pour ne pas heurter
// les ids des mocks). À terme, c'est le backend qui attribue l'id, on le retirera.

/**
 * Id de l'utilisateur courant. MOCK : lu dans localStorage (comme fetchPrograms).
 * RÉEL : le backend le dérive du JWT — la signature des fonctions n'a donc pas besoin
 * de le porter (il n'apparaît pas dans le contrat public).
 */
function currentUserId(): number {
  return Number(localStorage.getItem('moodit_user_id')) || 0;
}

// ── Programmes / cours (chargement) ────────────────────────────────────────────

/**
 * TODO — Récupérer la liste des programmes auxquels l'utilisateur est abonné. Les
 * cours sont chargés séparément (fetchCourses) à l'entrée dans un programme : on
 * renvoie donc ici les programmes SANS leurs cours.
 * DONE
 */
export async function fetchPrograms(): Promise<DemoProgram[]> {
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/users/${userId}/programs`);
  if (!res.ok) throw new Error('Échec chargement des programmes');
  const data = await res.json();
  return data.map((p: DemoProgram) => ({ ...p, courses: [] }));
}

/** TODO — Récupérer les cours d'un programme (avec leurs canaux/quiz/forums). */

export async function fetchCourses(programId: number): Promise<Course[]> {
  const res = await apiFetch(`/api/programs/${programId}/courses`);

  if (!res.ok) {
    throw new Error('Échec chargement des cours');
  }

  const data = await res.json();

  return (data.courses ?? []).map((course: Course) => ({
    ...course,
  }));
}

/**
 * TODO — Charger les données du gestionnaire de rôles d'un programme :
 * la liste des rôles attribuables ET la liste des membres avec le rôle de chacun. Alimente le
 * RoleEditorPopup.
 */
export async function fetchProgramRoles(programId: number) {
  await simulateFetch('fetch roles failed');
  return { roles: getProgramRoles(), users: getProgramUsers(programId) };
}

// ── Établissements / catalogue (AddSubscriptionPopup) ──────────────────────────

/**
 * TODO — Lister les établissements dans lesquels l'utilisateur peut CRÉER un
 * programme (1re étape du AddSubscriptionPopup en mode création).
 */
export async function fetchEstablishmentsForCreate() {
  const res = await apiFetch('/api/establishments');
  if (!res.ok) throw new Error('Échec chargement des établissements');
  return res.json();
}

/**
 * TODO — Lister les établissements dont l'utilisateur peut REJOINDRE des programmes
 * existants (1re étape du AddSubscriptionPopup en mode adhésion).
 */
export async function fetchEstablishmentsForJoin() {
  const res = await apiFetch('/api/establishments');

  if (!res.ok) {
    throw new Error('Échec chargement des établissements (adhésion)');
  }

  return await res.json();
}

/**
 * TODO — Lister le catalogue des programmes existants d'un établissement
 * pour que l'utilisateur choisisse ceux qu'il veut rejoindre.
 */
export async function fetchEstablishmentPrograms(establishmentId: number) {
  await simulateFetch('Échec simulé (programmes de l’établissement)');
  return getEstablishmentPrograms(establishmentId);
}

/**
 * TODO — Lister les cours rejoignables d'un programme.
 * Alimente le JoinCoursesPopup (menu contextuel d'un programme).
 */
export async function fetchProgramCourses(programId: number): Promise<JoinableCourse[]> {
  await simulateFetch('Échec simulé (cours rejoignables du programme)');
  // Mock : on liste les VRAIS cours du programme (mêmes ids/codes que partout ailleurs)
  // pour que le popup retrouve, et pré-coche, les cours déjà rejoints.
  const program = getDashboardPrograms().find((p) => p.id === programId);
  return (program?.courses ?? []).map((course) => ({
    id: course.id,
    code: course.code ?? '',
    title: course.title ?? '',
  }));
}

/**
 * TODO — Lister les ids des cours d'un programme auxquels l'utilisateur est DÉJÀ rattaché (ses inscriptions).
 * Sert à pré-cocher le JoinCoursesPopup, indépendamment
 * de l'état (lazy-loaded) du Dashboard. Mock : tous les cours du programme.
 */
export async function fetchJoinedCourseIds(programId: number): Promise<number[]> {
  const userId = localStorage.getItem('moodit_user_id');
  const res = await apiFetch(`/api/users/${userId}/programs/${programId}/enrollments`);
  if (!res.ok) throw new Error('Échec chargement des inscriptions');
  const data: { courseId: number }[] = await res.json();
  return data.map((e) => e.courseId);
}

/**
 * TODO — Historique des analyses MCP d'un cours : RÉSUMÉS (sans contenu), tri récent →
 * ancien. Tout est renvoyé d'un coup. Le détail est chargé à la demande via
 * fetchCourseAnalysis(id).
 */
export async function fetchCourseAnalyses(courseId: number): Promise<McpResponseSummary[]> {
  await simulateFetch('Échec simulé (historique des analyses MCP)');
  return getMcpResponseSummaries(courseId);
}

/**
 * TODO — Détail complet d'une analyse MCP (table MCP_Response, avec `content`), chargé
 * au clic sur une entrée de l'historique.
 */
export async function fetchCourseAnalysis(id: number): Promise<McpResponse> {
  await simulateFetch('Échec simulé (détail de l’analyse MCP)');
  const response = getMcpResponse(id);
  if (!response) throw new Error('Analyse introuvable');
  return response;
}

/**
 * TODO — L'utilisateur courant a-t-il une analyse MCP EN COURS pour ce cours ? Permet
 * de réhydrater l'état « en cours » du popup (survit à un rechargement de page). Le
 * lien est (cours, utilisateur) : côté réel, l'utilisateur vient du JWT.
 */
export async function fetchPendingAnalysis(courseId: number): Promise<boolean> {
  await simulateFetch('Échec simulé (statut de l’analyse MCP)');
  return isAnalysisPending(courseId, currentUserId());
}

// ── Programmes / cours (écriture) ──────────────────────────────────────────────

/**
 * TODO — Créer un cours (titre, code) et le rattacher aux programmes choisis
 * (`programIds`). Renvoie le cours persisté (id attribué par le « serveur ») pour
 * que le Dashboard l'insère dans sa liste.
 */
export async function createCourse(course: NewCourse): Promise<Course> {
  const res = await apiFetch('/api/programs/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(course),
  });
  if (!res.ok) throw new Error('Échec création du cours');
  const data = await res.json();
  return {
    ...data,
    channels: [],
    quizzes: [],
    forums: [],
  };
}

/**
 * TODO — Créer un nouveau programme et y abonner l'utilisateur d'office. Renvoie le
 * programme persisté (id attribué par le « serveur ») pour l'ajouter à la liste.
 */
export async function createProgram(program: NewProgram): Promise<DemoProgram> {
  const res = await apiFetch('/api/establishments/programs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(program),
  });
  if (!res.ok) throw new Error('Échec création du programme');
  const data = await res.json();

  const userId = localStorage.getItem('moodit_user_id');
  await apiFetch('/api/programs/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: Number(userId), programIds: [data.id] }),
  });

  return { ...data, courses: [] };
}

/**
 * TODO — Abonner l'utilisateur aux programmes sélectionnés du catalogue. Renvoie les
 * programmes ajoutés ; le Dashboard les dédoublonne contre sa liste avant insertion.
 */
export async function joinPrograms(selection: JoinSelection) {
  await simulateWrite('Échec simulé (adhésion au programme)');
  console.log(selection);
  return getEstablishmentPrograms(selection.establishmentId).filter((p) =>
    selection.programIds.includes(p.id)
  );
}

/**
 * TODO — Mettre à jour un cours (code, titre) et, le cas échéant, son rattachement
 * aux programmes (relation many-to-many program_course).
 */
export async function updateCourse(courseId: number, update: CourseUpdate): Promise<void> {
  await simulateWrite('Échec simulé (modification de cours)');
  console.log(courseId, update);
}

/** TODO — Mettre à jour les champs d'un programme : nom, code, cohorte, couleur. */
export async function updateProgram(programId: number, update: ProgramUpdate): Promise<void> {
  await simulateWrite('Échec simulé (modification de programme)');
  console.log(programId, update);
}

/** TODO — Désabonner l'utilisateur d'un programme (le retirer de sa liste). */
export async function leaveProgram(programId: number): Promise<void> {
  await simulateWrite('Échec simulé (quitter le programme)');
  console.log(programId);
}

/** TODO — Retirer l'utilisateur d'un cours (le retirer de sa liste de cours). */
export async function leaveCourse(courseId: number): Promise<void> {
  await simulateWrite('Échec simulé (quitter le cours)');
  console.log(courseId);
}

/**
 * TODO — Déclencher une analyse MCP d'un cours (« Analyser mon cours »). ASYNCHRONE : le
 * serveur ACCEPTE le job (202) et marque (cours, user) « en cours » ; il ne renvoie PAS
 * le résultat. Celui-ci arrive plus tard par WebSocket (cf. subscribeCourseAnalyses).
 */
export async function requestCourseAnalysis(courseId: number): Promise<void> {
  await simulateWrite('Échec simulé (analyse MCP)');
  const userId = currentUserId();
  markAnalysisPending(courseId, userId);
  // Simulation du job serveur : après un délai, il persiste la réponse et libère le verrou.
  // En prod, c'est le backend qui le fait PUIS pousse `mcp:analysis-created` par WebSocket
  // (ws.mcp, cf. Dashboard) — le push live n'est PAS simulé ici (nécessite core-service).
  setTimeout(() => {
    generateMcpResponse(courseId, userId);
    clearAnalysisPending(courseId, userId);
  }, MOCK_MCP_JOB_MS);
}

/**
 * TODO — Inscrire l'utilisateur aux cours choisis d'un programme. Renvoie les cours
 * rejoints (forme `Course`, sans canaux) pour que le Dashboard les fusionne dans le
 * programme. `courseIds` ⊆ des ids renvoyés par fetchProgramCourses(programId).
 */
export async function joinCourses(programId: number, courseIds: number[]): Promise<Course[]> {
  await simulateWrite('Échec simulé (adhésion aux cours)');
  const program = getDashboardPrograms().find((p) => p.id === programId);
  console.log(programId, courseIds);
  return (program?.courses ?? [])
    .filter((course) => courseIds.includes(course.id))
    .map((course) => ({
      id: course.id,
      code: course.code,
      title: course.title,
      channels: [],
      quizzes: [],
      forums: [],
    }));
}

/**
 * TODO — Persister une modification de la structure d'un cours : ajout, renommage,
 * suppression ou réordonnancement d'une section (canal, quiz ou forum). `change`
 * décrit l'opération exacte ; `sectionType` indique la famille de section visée.
 */
export async function changeSection(
  courseId: number,
  sectionType: string,
  change: ItemChange
): Promise<void> {
  await simulateWrite('Échec simulé (modification de section)');
  console.log(courseId, sectionType, change);
}

/**
 * TODO — Attribuer ou retirer un rôle à un membre dans un programme (le RoleEditorPopup
 * gère l'optimisme + rollback : on ne fait que persister le changement).
 */
export async function changeRole(change: RoleChange): Promise<void> {
  await simulateWrite('Échec simulé (assignation de rôle)');
  console.log('[api] Changement de rôle :', change);
}

// ── Chat ('Discussion') ────────────────────────────────────────────────────────

/**
 * TODO — Charger l'historique des messages d'un canal de chat. Le mock recherche le
 * canal dans les programmes mock (par id) et renvoie ses messages.
 */
export async function fetchMessages(channelId: number): Promise<ChannelMessage[]> {
  await simulateFetch('Échec simulé (chargement des messages)');
  for (const program of getDashboardPrograms()) {
    for (const course of program.courses) {
      const channels = normalizeCourseChannelsFromSources({
        channels: course.channels,
        quizzes: course.quizzes,
        forums: course.forums,
      });
      // Les messages vivent sur les canaux TEXTE (Discussion). Un quiz ou un forum
      // peut partager l'id d'un canal texte (id_ uniques seulement PAR type) : on
      // filtre donc par type avant de chercher par id, sinon on tomberait sur le
      // quiz (sans messages) et le canal texte renverrait vide.
      const channel = channels.find((c) => c.type === 'text' && c.id === channelId);
      if (channel) return channel.messages ?? [];
    }
  }
  return [];
}

/**
 * TODO — Publier un message dans un canal (réponse à un autre si `parentId`). Devra
 * RENVOYER le message persisté (id réel) en conservant le `clientMessageId`, afin de
 * réconcilier l'affichage optimiste et de dédupliquer l'écho reçu par WebSocket.
 */
export async function sendMessage(
  content: string,
  parentId: number | null,
  clientMessageId: string
): Promise<void> {
  await simulateWrite('Échec simulé (envoi de message)');
  console.log(
    '[api] Envoi de message :',
    content,
    '(parent =',
    parentId,
    ', clientMsgId =',
    clientMessageId,
    ')'
  );
}

/** TODO — Modifier le contenu d'un message existant. */
export async function editMessage(messageId: number, content: string): Promise<void> {
  await simulateWrite('Échec simulé (modification de message)');
  console.log('[api] Modification du message', messageId, ':', content);
}

/** TODO — Supprimer un message. */
export async function deleteMessage(messageId: number): Promise<void> {
  await simulateWrite('Échec simulé (suppression de message)');
  console.log('[api] Suppression du message', messageId);
}

// ── Forum ('Thread') ───────────────────────────────────────────────────────────

/**
 * TODO — Charger les sujets RACINES d'un forum, SANS leurs réponses (chargement
 * paresseux : les réponses sont récupérées à la demande via fetchReplies).
 */
export async function fetchThreads(forumId: number) {
  await simulateFetch('Échec simulé (chargement des sujets)');
  return getMockForumThreads(forumId);
}

/**
 * TODO — Charger les réponses DIRECTES (enfants immédiats) d'un post, au moment où
 * l'utilisateur déplie le fil.
 */
export async function fetchReplies(postId: number) {
  await simulateFetch('Échec simulé (chargement des réponses)');
  return getMockForumReplies(postId);
}

/**
 * TODO — Publier un sujet ou une réponse dans un forum (réponse si `parentId`, avec
 * un `title` pour un sujet racine). Devra RENVOYER le post persisté (id réel) en
 * conservant le `clientPostId` pour la réconciliation optimiste ↔ écho WebSocket.
 */
export async function createPost(
  content: string,
  parentId: number | null,
  clientPostId: string,
  title?: string
): Promise<void> {
  await simulateWrite('Échec simulé (publication)');
  console.log(
    '[api] Publication :',
    title ? `« ${title} » — ` : '',
    content,
    '(parent =',
    parentId,
    ', clientPostId =',
    clientPostId,
    ')'
  );
}

/** TODO — Modifier le contenu d'un post. */
export async function editPost(postId: number, content: string): Promise<void> {
  await simulateWrite('Échec simulé (modification de post)');
  console.log('[api] Modification du post', postId, ':', content);
}

/** TODO — Supprimer un post ainsi que tout son sous-fil (cascade côté base). */
export async function deletePost(postId: number): Promise<void> {
  await simulateWrite('Échec simulé (suppression de post)');
  console.log('[api] Suppression du post', postId);
}

/**
 * TODO — Enregistrer le vote de l'utilisateur sur un post. `value` ∈ {-1, 0, 1} où
 * 0 = retrait du vote (un seul vote par utilisateur et par post).
 */
export async function votePost(postId: number, value: number): Promise<void> {
  await simulateWrite('Échec simulé (vote)');
  console.log('[api] Vote sur le post', postId, ':', value);
}
