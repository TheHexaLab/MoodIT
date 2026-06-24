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
import type { Course } from '../../types/domain.ts';
import {
  getCreateEstablishments,
  getEstablishmentPrograms,
  getJoinEstablishments,
} from '../../mocks/subscriptionData.ts';
import { getProgramRoles, getProgramUsers } from '../../mocks/roleData.ts';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import type { DemoProgram } from '../../mocks/dashboardData.ts';
import { apiFetch } from '../../helpers/api.ts';
// Ré-exporté pour que le Dashboard n'ait pas à dépendre du dossier mock.
export type { DemoProgram };

// ── Simulation réseau (à retirer au branchement réel) ──────────────────────────
const SIMULATE_DELAY = 100;
const SIMULATE_SEND_FAILURE: boolean = false;
const SIMULATE_FETCH_FAILURE: boolean = false;

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
let mockIdSeq = 9000;
const nextMockId = () => ++mockIdSeq;

// ── Programmes / cours (chargement) ────────────────────────────────────────────

/**
 * TODO — Récupérer la liste des programmes auxquels l'utilisateur est abonné. Les
 * cours sont chargés séparément (fetchCourses) à l'entrée dans un programme : on
 * renvoie donc ici les programmes SANS leurs cours.
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
  await simulateFetch('Échec simulé (chargement des cours)');
  return getDashboardPrograms().find((program) => program.id === programId)?.courses ?? [];
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
  await simulateFetch('Échec simulé (établissements)');
  return getCreateEstablishments();
}

/**
 * TODO — Lister les établissements dont l'utilisateur peut REJOINDRE des programmes
 * existants (1re étape du AddSubscriptionPopup en mode adhésion).
 */
export async function fetchEstablishmentsForJoin() {
  await simulateFetch('Échec simulé (établissements)');
  return getJoinEstablishments();
}

/**
 * TODO — Lister le catalogue des programmes existants d'un établissement, pour que
 * l'utilisateur choisisse ceux qu'il veut rejoindre.
 */
export async function fetchEstablishmentPrograms(establishmentId: number) {
  await simulateFetch('Échec simulé (programmes de l’établissement)');
  return getEstablishmentPrograms(establishmentId);
}

// ── Programmes / cours (écriture) ──────────────────────────────────────────────

/**
 * TODO — Créer un cours (titre, code) et le rattacher aux programmes choisis
 * (`programIds`). Renvoie le cours persisté (id attribué par le « serveur ») pour
 * que le Dashboard l'insère dans sa liste.
 */
export async function createCourse(course: NewCourse): Promise<Course> {
  await simulateWrite('Échec simulé (ajout de cours)');
  return {
    id: nextMockId(),
    code: course.code,
    title: course.title,
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
  await simulateWrite('Échec simulé (création de programme)');
  return {
    id: nextMockId(),
    name: program.name,
    code: program.code,
    cohort: program.cohort,
    color: program.color,
    courses: [],
  };
}

/**
 * TODO — Abonner l'utilisateur aux programmes sélectionnés du catalogue. Renvoie les
 * programmes ajoutés ; le Dashboard les dédoublonne contre sa liste avant insertion.
 */
export async function joinPrograms(selection: JoinSelection) {
  await simulateWrite('Échec simulé (adhésion au programme)');
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
