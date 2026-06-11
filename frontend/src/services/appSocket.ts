import { type ChannelMessage } from '../components/CourseChannelList/CourseChannelList';
import {
  type ChannelSocket,
  type IncomingMessageHandlers,
} from '../components/MainPanel/ChannelView/useChannelMessages';
import { type ForumPost } from '../components/MainPanel/ForumView/forumThreads';
import {
  type ForumSocket,
  type IncomingForumHandlers,
  type VoteValue,
} from '../components/MainPanel/ForumView/useForumThreads';
import {
  type Course,
  type CourseChannelsSocket,
  type IncomingCourseHandlers,
} from '../components/CourseMenu/CourseMenu';
import { type ItemChange } from '../components/SectionEditorPopup/SectionEditorPopup';
import {
  type Program,
  type IncomingProgramHandlers,
  type ProgramsSocket,
} from '../components/ProgramMenu/ProgramMenu';

/**
 * SCAFFOLD du vrai client WebSocket (à finir le jour du branchement temps réel).
 *
 * UNE SEULE connexion persistante pour toute l'app, partagée par le chat et le
 * forum (plusieurs « rooms »). `createAppSocket` renvoie deux facades :
 *   - `channels` : `ChannelSocket` attendu par `useChannelMessages`
 *   - `forums`   : `ForumSocket`   attendu par `useForumThreads`
 *
 * Pour l'activer : dans Dashboard, remplacer les mocks par
 *   const ws = useMemo(() => createAppSocket(import.meta.env.VITE_WS_URL, getAuthToken), []);
 *   …
 *   <MainPanel socket={ws.channels} forumSocket={ws.forums} … />
 *   <CourseMenu … />  // via Dashboard : ws.courses (liste des cours + sections)
 *
 * À ALIGNER avec le backend : l'URL, le format des évènements (`ServerEvent`) et
 * les commandes `join` / `leave` (avec un `scope` canal / forum / programme).
 */

/** Évènements poussés par le serveur (à aligner avec le backend). */
type ServerEvent =
  // Chat
  | { type: 'message:created'; channelId: number; message: ChannelMessage }
  | { type: 'message:edited'; channelId: number; messageId: number; content: string }
  | { type: 'message:deleted'; channelId: number; messageId: number }
  // Forum
  | { type: 'post:created'; forumId: number; post: ForumPost; parentId: number | null }
  | { type: 'post:edited'; forumId: number; postId: number; content: string }
  | { type: 'post:deleted'; forumId: number; postId: number }
  | { type: 'post:voted'; forumId: number; postId: number; userId: number; value: VoteValue }
  // Cours / sections (scope = programme)
  | { type: 'course:created'; programId: number; course: Course }
  | { type: 'course:edited'; programId: number; course: Course }
  | { type: 'course:deleted'; programId: number; courseId: number }
  | {
      type: 'section:changed';
      programId: number;
      courseId: number;
      sectionType: string;
      change: ItemChange;
    }
  // Programmes / abonnements (scope = utilisateur)
  | { type: 'program:created'; userId: number; program: Program }
  | { type: 'program:updated'; userId: number; program: Program }
  | { type: 'program:deleted'; userId: number; programId: number }
  | { type: 'subscription:added'; userId: number; program: Program }
  | { type: 'subscription:removed'; userId: number; programId: number };

export interface AppSocket {
  channels: ChannelSocket;
  forums: ForumSocket;
  courses: CourseChannelsSocket;
  programs: ProgramsSocket;
}

export function createAppSocket(url: string, getToken: () => string): AppSocket {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  /** Rooms actives (on peut être abonné a plusieurs canaux / forums / programmes). */
  const channelSubs = new Map<number, IncomingMessageHandlers>();
  const forumSubs = new Map<number, IncomingForumHandlers>();
  const courseSubs = new Map<number, IncomingCourseHandlers>();
  const programSubs = new Map<number, IncomingProgramHandlers>();

  const send = (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  function connect() {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(getToken())}`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      // (Re)joindre toutes les rooms actives — utile après une reconnexion.
      for (const channelId of channelSubs.keys()) send({ type: 'join', scope: 'channel', id: channelId });
      for (const forumId of forumSubs.keys()) send({ type: 'join', scope: 'forum', id: forumId });
      for (const programId of courseSubs.keys()) send({ type: 'join', scope: 'program', id: programId });
      for (const userId of programSubs.keys()) send({ type: 'join', scope: 'user', id: userId });
      // TODO reconnexion : refetcher les éléments manqués « depuis le dernier vu ».
    };

    ws.onmessage = (event) => {
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      switch (data.type) {
        case 'message:created':
          channelSubs.get(data.channelId)?.onMessage(data.message);
          break;
        case 'message:edited':
          channelSubs.get(data.channelId)?.onEdit(data.messageId, data.content);
          break;
        case 'message:deleted':
          channelSubs.get(data.channelId)?.onDelete(data.messageId);
          break;
        case 'post:created':
          // La dédup optimiste ↔ écho est gérée par le hook (client_msg_id / client_post_id).
          forumSubs.get(data.forumId)?.onPost(data.post, data.parentId);
          break;
        case 'post:edited':
          forumSubs.get(data.forumId)?.onEdit(data.postId, data.content);
          break;
        case 'post:deleted':
          forumSubs.get(data.forumId)?.onDelete(data.postId);
          break;
        case 'post:voted':
          forumSubs.get(data.forumId)?.onVote(data.postId, data.userId, data.value);
          break;
        case 'course:created':
        case 'course:edited':
          courseSubs.get(data.programId)?.onCourseUpsert(data.course);
          break;
        case 'course:deleted':
          courseSubs.get(data.programId)?.onCourseDelete(data.courseId);
          break;
        case 'section:changed':
          courseSubs.get(data.programId)?.onSectionChange(data.courseId, data.sectionType, data.change);
          break;
        case 'program:created':
        case 'program:updated':
        case 'subscription:added':
          programSubs.get(data.userId)?.onProgramUpsert(data.program);
          break;
        case 'program:deleted':
        case 'subscription:removed':
          programSubs.get(data.userId)?.onProgramRemove(data.programId);
          break;
      }
    };

    ws.onclose = () => {
      // Reconnexion avec backoff exponentiel plafonné.
      // TODO : ne pas reconnecter si fermeture VOLONTAIRE (logout / unmount app).
      window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    };

    ws.onerror = () => ws?.close();
  }

  connect();

  return {
    channels: {
      subscribe(channelId, handlers) {
        channelSubs.set(channelId, handlers);
        send({ type: 'join', scope: 'channel', id: channelId });
        return () => {
          channelSubs.delete(channelId);
          send({ type: 'leave', scope: 'channel', id: channelId });
        };
      },
    },
    forums: {
      subscribe(forumId, handlers) {
        forumSubs.set(forumId, handlers);
        send({ type: 'join', scope: 'forum', id: forumId });
        return () => {
          forumSubs.delete(forumId);
          send({ type: 'leave', scope: 'forum', id: forumId });
        };
      },
    },
    courses: {
      subscribe(programId, handlers) {
        courseSubs.set(programId, handlers);
        send({ type: 'join', scope: 'program', id: programId });
        return () => {
          courseSubs.delete(programId);
          send({ type: 'leave', scope: 'program', id: programId });
        };
      },
    },
    programs: {
      subscribe(userId, handlers) {
        programSubs.set(userId, handlers);
        send({ type: 'join', scope: 'user', id: userId });
        return () => {
          programSubs.delete(userId);
          send({ type: 'leave', scope: 'user', id: userId });
        };
      },
    },
  };
}
