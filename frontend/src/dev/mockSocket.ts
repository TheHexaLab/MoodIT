import { type ChannelMessage } from '../components/CourseChannelList/CourseChannelList';
import {
  type ChannelSocket,
  type IncomingMessageHandlers,
} from '../components/MainPanel/ChannelView/useChannelMessages';
import { type ForumPost } from '../components/MainPanel/ForumView/forumThreads';
import {
  type ForumSocket,
  type IncomingForumHandlers,
} from '../components/MainPanel/ForumView/useForumThreads';
import {
  type Course,
  type CourseChannelsSocket,
  type IncomingCourseHandlers,
} from '../components/CourseMenu/CourseMenu';
import {
  type Program,
  type IncomingProgramHandlers,
  type ProgramsSocket,
} from '../components/ProgramMenu/ProgramMenu';

/**
 * Outil de DEV : UNE SEULE connexion temps reel simulée, partagée par le chat
 * (canaux) ET le forum, exactement comme le vrai client (une connexion WebSocket,
 * plusieurs « rooms »). Les deux facades exposees ci-dessous (`mockMessageSocket`
 * et `mockForumSocket`) s'appuient sur le meme etat de module.
 *
 * À REMPLACER par le vrai client unique : voir src/services/appSocket.ts
 * (`createAppSocket(...)` renvoie les deux memes facades sur une seule connexion).
 *
 * Pilote a la demande par le menu contextuel (clic droit sur l'icone de l'app).
 */

/** Abonnement canal courant (un seul canal/forum ouvert a la fois cote UI). */
let channelSub: { channelId: number; handlers: IncomingMessageHandlers } | null = null;
/** Abonnement forum courant. */
let forumSub: { forumId: number; handlers: IncomingForumHandlers } | null = null;
/** Abonnement programme courant (liste des cours + sections). */
let courseSub: { programId: number; handlers: IncomingCourseHandlers } | null = null;
/** Abonnement utilisateur courant (liste des programmes / abonnements). */
let programSub: { userId: number; handlers: IncomingProgramHandlers } | null = null;
/** Compteur d'id « serveur » simulés, partagé par la connexion. */
let serverSeq = 0;
/** Derniers elements simulés (cibles des simulate* Edit / Delete / Vote). */
let lastMessageId: number | null = null;
let lastPostId: number | null = null;
/** Dernier cours simulé (cible des simulate* cours / section). */
let lastCourseId: number | null = null;
/** Dernier programme simulé (cible des simulate* programme). */
let lastProgramId: number | null = null;

// ─── Facade « canaux » (chat) ───
export const mockMessageSocket: ChannelSocket = {
  subscribe(channelId, handlers) {
    channelSub = { channelId, handlers };
    serverSeq = Math.max(serverSeq, 9000 + channelId * 100);
    lastMessageId = null;
    return () => {
      if (channelSub?.handlers === handlers) channelSub = null;
    };
  },
};

// ─── Facade « forums » (Thread) ───
export const mockForumSocket: ForumSocket = {
  subscribe(forumId, handlers) {
    forumSub = { forumId, handlers };
    serverSeq = Math.max(serverSeq, 8000 + forumId * 100);
    lastPostId = null;
    return () => {
      if (forumSub?.handlers === handlers) forumSub = null;
    };
  },
};

// ─── Facade « cours » (liste des cours + sections d'un programme) ───
export const mockCourseSocket: CourseChannelsSocket = {
  subscribe(programId, handlers) {
    courseSub = { programId, handlers };
    serverSeq = Math.max(serverSeq, 7000 + programId * 100);
    lastCourseId = null;
    return () => {
      if (courseSub?.handlers === handlers) courseSub = null;
    };
  },
};

/** Un canal de discussion est-il abonne ? (active/desactive les actions du menu). */
export function hasActiveChannel(): boolean {
  return channelSub !== null;
}

/** Un forum 'Thread' est-il abonne ? */
export function hasActiveForum(): boolean {
  return forumSub !== null;
}

/** Un programme est-il abonne ? (liste des cours en temps reel). */
export function hasActiveProgram(): boolean {
  return courseSub !== null;
}

// ─── Facade « programmes » (liste des abonnements d'un utilisateur) ───
export const mockProgramsSocket: ProgramsSocket = {
  subscribe(userId, handlers) {
    programSub = { userId, handlers };
    serverSeq = Math.max(serverSeq, 6000 + userId * 100);
    lastProgramId = null;
    return () => {
      if (programSub?.handlers === handlers) programSub = null;
    };
  },
};

/** La liste des programmes (utilisateur) est-elle abonnee ? */
export function hasActiveProgramsList(): boolean {
  return programSub !== null;
}

// ─── Simulations CHAT ───

/** Simule la reception d'un nouveau message (d'un autre utilisateur). */
export function simulateIncomingMessage(): void {
  if (!channelSub) return;
  serverSeq += 1;
  lastMessageId = serverSeq;
  const incoming: ChannelMessage = {
    id: serverSeq,
    content: `(temps réel) Nouveau message reçu par WebSocket 👋 [#${serverSeq}]`,
    created_at: new Date().toISOString(),
    author: {
      id: 2,
      username: 'rosie1234',
      first_name: 'Rosie',
      last_name: 'HG',
      avatar_color: '#0a5cc0',
    },
  };
  channelSub.handlers.onMessage(incoming);
}

/** Simule la modification distante du dernier message simule. */
export function simulateIncomingEdit(): void {
  if (!channelSub || lastMessageId === null) return;
  channelSub.handlers.onEdit(lastMessageId, `(modifié à distance) message #${lastMessageId}`);
}

/** Simule la suppression distante du dernier message simule. */
export function simulateIncomingDelete(): void {
  if (!channelSub || lastMessageId === null) return;
  channelSub.handlers.onDelete(lastMessageId);
  lastMessageId = null;
}

// ─── Simulations FORUM ───

/** Simule la reception d'un nouveau sujet racine (d'un autre utilisateur). */
export function simulateIncomingForumPost(): void {
  if (!forumSub) return;
  serverSeq += 1;
  lastPostId = serverSeq;
  const post: ForumPost = {
    id: serverSeq,
    content: `(temps réel) Nouveau sujet reçu par WebSocket 👋 [#${serverSeq}]`,
    created_at: new Date().toISOString(),
    author: {
      id: 2,
      username: 'rosie1234',
      first_name: 'Rosie',
      last_name: 'HG',
      avatar_color: '#0a5cc0',
    },
    votes: [],
    replies: [],
  };
  forumSub.handlers.onPost(post, null); // sujet racine (parentId = null)
}

/** Simule un vote distant (+1) sur le dernier sujet simule. */
export function simulateIncomingForumVote(): void {
  if (!forumSub || lastPostId === null) return;
  forumSub.handlers.onVote(lastPostId, 2, 1); // rosie (id 2) upvote
}

/** Simule la modification distante du dernier sujet simule. */
export function simulateIncomingForumEdit(): void {
  if (!forumSub || lastPostId === null) return;
  forumSub.handlers.onEdit(lastPostId, `(modifié à distance) sujet #${lastPostId}`);
}

/** Simule la suppression distante du dernier sujet simule. */
export function simulateIncomingForumDelete(): void {
  if (!forumSub || lastPostId === null) return;
  forumSub.handlers.onDelete(lastPostId);
  lastPostId = null;
}

// ─── Simulations COURS / SECTIONS (scope programme) ───

/** Simule l'ajout distant d'un cours dans le programme abonne. */
export function simulateIncomingCourse(): void {
  if (!courseSub) return;
  serverSeq += 1;
  lastCourseId = serverSeq;
  const course: Course = {
    id: serverSeq,
    code: `WS-${serverSeq}`,
    title: `Cours temps réel #${serverSeq}`,
    channels: [],
    quizzes: [],
    forums: [],
  };
  courseSub.handlers.onCourseUpsert(course);
}

/** Simule le renommage distant du dernier cours simule. */
export function simulateRenameLastCourse(): void {
  if (!courseSub || lastCourseId === null) return;
  courseSub.handlers.onCourseUpsert({
    id: lastCourseId,
    code: `WS-${lastCourseId}`,
    title: `(renommé à distance) cours #${lastCourseId}`,
    channels: [],
    quizzes: [],
    forums: [],
  });
}

/** Simule l'ajout distant d'un canal texte dans le dernier cours simule. */
export function simulateIncomingSectionChange(): void {
  if (!courseSub || lastCourseId === null) return;
  courseSub.handlers.onSectionChange(lastCourseId, 'text', {
    type: 'create',
    item: { id: crypto.randomUUID(), name: `canal-ws-${serverSeq}` },
  });
}

/** Simule la suppression distante du dernier cours simule. */
export function simulateRemoveLastCourse(): void {
  if (!courseSub || lastCourseId === null) return;
  courseSub.handlers.onCourseDelete(lastCourseId);
  lastCourseId = null;
}

// ─── Simulations PROGRAMMES (scope utilisateur) ───

/** Simule l'adhésion / l'ajout distant d'un programme à la liste de l'utilisateur. */
export function simulateIncomingProgram(): void {
  if (!programSub) return;
  serverSeq += 1;
  lastProgramId = serverSeq;
  const program: Program = {
    id: serverSeq,
    name: `Programme temps réel #${serverSeq}`,
    code: `WS${serverSeq}`,
    cohort: 'WS',
    color: '#7c3aed',
    courses: [],
  };
  programSub.handlers.onProgramUpsert(program);
}

/** Simule le renommage distant du dernier programme simulé. */
export function simulateRenameLastProgram(): void {
  if (!programSub || lastProgramId === null) return;
  programSub.handlers.onProgramUpsert({
    id: lastProgramId,
    name: `(renommé à distance) programme #${lastProgramId}`,
    code: `WS${lastProgramId}`,
    cohort: 'WS',
    color: '#7c3aed',
    courses: [],
  });
}

/** Simule la suppression / le désabonnement distant du dernier programme simulé. */
export function simulateRemoveLastProgram(): void {
  if (!programSub || lastProgramId === null) return;
  programSub.handlers.onProgramRemove(lastProgramId);
  lastProgramId = null;
}
