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
 *
 * À ALIGNER avec le backend : l'URL, le format des évènements (`ServerEvent`) et
 * les commandes `join` / `leave` (avec un `scope` canal/forum).
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
  | { type: 'post:voted'; forumId: number; postId: number; userId: number; value: VoteValue };

export interface AppSocket {
  channels: ChannelSocket;
  forums: ForumSocket;
}

export function createAppSocket(url: string, getToken: () => string): AppSocket {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  /** Rooms actives (on peut être abonné a plusieurs canaux / forums). */
  const channelSubs = new Map<number, IncomingMessageHandlers>();
  const forumSubs = new Map<number, IncomingForumHandlers>();

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
  };
}
