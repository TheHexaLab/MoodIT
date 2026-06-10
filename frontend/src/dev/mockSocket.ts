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
/** Compteur d'id « serveur » simulés, partagé par la connexion. */
let serverSeq = 0;
/** Derniers elements simulés (cibles des simulate* Edit / Delete / Vote). */
let lastMessageId: number | null = null;
let lastPostId: number | null = null;

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

/** Un canal de discussion est-il abonne ? (active/desactive les actions du menu). */
export function hasActiveChannel(): boolean {
  return channelSub !== null;
}

/** Un forum 'Thread' est-il abonne ? */
export function hasActiveForum(): boolean {
  return forumSub !== null;
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
