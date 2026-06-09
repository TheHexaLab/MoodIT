import { type ChannelMessage } from '../components/CourseChannelList/CourseChannelList';
import {
  type ChannelSocket,
  type IncomingMessageHandlers,
} from '../components/MainPanel/ChannelView/useChannelMessages';

/**
 * SCAFFOLD du vrai client WebSocket (à finir le jour du branchement temps réel).
 * Il implémente l'interface `ChannelSocket` attendue par `useChannelMessages` :
 * une seule connexion persistante, partagée par tous les canaux ; `subscribe`
 * ne fait que rejoindre/quitter une room.
 *
 * Pour l'activer : dans Dashboard, remplacer `socket={mockMessageSocket}` par
 *   const socket = useMemo(() => createChannelSocket(import.meta.env.VITE_WS_URL, getAuthToken), []);
 *   …
 *   <MainPanel socket={socket} … />
 *
 * À ALIGNER avec le backend : l'URL, le format des messages serveur (`ServerEvent`)
 * et les commandes `join` / `leave`.
 */

/** Évènements poussés par le serveur (à aligner avec le backend). */
type ServerEvent =
  | { type: 'message:created'; channelId: number; message: ChannelMessage }
  | { type: 'message:edited'; channelId: number; messageId: number; content: string }
  | { type: 'message:deleted'; channelId: number; messageId: number };

export function createChannelSocket(url: string, getToken: () => string): ChannelSocket {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  /** Abonnements actifs : channelId -> handlers (on peut être dans plusieurs rooms). */
  const subscriptions = new Map<number, IncomingMessageHandlers>();

  const send = (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  function connect() {
    ws = new WebSocket(`${url}?token=${encodeURIComponent(getToken())}`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      // (Re)joindre toutes les rooms actives — utile après une reconnexion.
      for (const channelId of subscriptions.keys()) send({ type: 'join', channelId });
      // TODO reconnexion : refetcher les messages manqués « depuis le dernier vu »
      //      pour chaque canal abonné (sinon trou pendant la coupure).
    };

    ws.onmessage = (event) => {
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data) as ServerEvent;
      } catch {
        return;
      }
      const handlers = subscriptions.get(data.channelId);
      if (!handlers) return; // évènement d'un canal auquel on n'est pas abonné
      switch (data.type) {
        case 'message:created':
          // La dédup optimiste ↔ écho est gérée par le hook (via client_msg_id).
          handlers.onMessage(data.message);
          break;
        case 'message:edited':
          handlers.onEdit(data.messageId, data.content);
          break;
        case 'message:deleted':
          handlers.onDelete(data.messageId);
          break;
      }
    };

    ws.onclose = () => {
      // Reconnexion avec backoff exponentiel plafonné.
      // TODO : distinguer une fermeture VOLONTAIRE (logout / unmount app) pour ne
      //        pas reconnecter dans ce cas.
      window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    };

    ws.onerror = () => ws?.close();
  }

  connect();

  return {
    subscribe(channelId, handlers) {
      subscriptions.set(channelId, handlers);
      send({ type: 'join', channelId }); // rejoindre la room

      // ← Ce return est appelé par le hook au changement de canal / démontage.
      return () => {
        subscriptions.delete(channelId);
        send({ type: 'leave', channelId }); // quitter la room
      };
    },
  };
}
