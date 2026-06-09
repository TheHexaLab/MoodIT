import { type ChannelMessage } from '../components/CourseChannelList/CourseChannelList';
import {
  type ChannelSocket,
  type IncomingMessageHandlers,
} from '../components/MainPanel/ChannelView/useChannelMessages';

/**
 * Outil de DEV : mock d'un socket temps reel, pilote à la demande par le menu
 * contextuel (clic droit sur l'icone de l'app). À REMPLACER par un vrai client
 * (WebSocket natif, socket.io, …) : seul le corps de `subscribe` changera.
 *
 * Le mock retient l'abonnement actif (le canal ouvert) dans une variable de
 * module ; les fonctions `simulate*` poussent alors des evenements dans ce canal.
 */

/** Abonnement courant (canal ouvert). Null si aucun canal de discussion affiche. */
let active: { channelId: number; handlers: IncomingMessageHandlers } | null = null;
/** Compteur d'id « serveur » simulés (sans collision avec les mocks / optimistes). */
let serverSeq = 0;
/** Dernier message simule recu (cible de simulateIncomingEdit / Delete). */
let lastId: number | null = null;

export const mockMessageSocket: ChannelSocket = {
  subscribe(channelId, handlers) {
    active = { channelId, handlers };
    serverSeq = 9000 + channelId * 100; // plage distincte par canal
    lastId = null;
    return () => {
      // Ne se desabonne que si c'est toujours le meme abonnement.
      if (active?.handlers === handlers) active = null;
    };
  },
};

/** Un canal de discussion est-il abonne ? (active/desactive les actions du menu). */
export function hasActiveChannel(): boolean {
  return active !== null;
}

/** Simule la reception d'un nouveau message (d'un autre utilisateur). */
export function simulateIncomingMessage(): void {
  if (!active) return;
  serverSeq += 1;
  lastId = serverSeq;
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
  active.handlers.onMessage(incoming);
}

/** Simule la modification distante du dernier message simule. */
export function simulateIncomingEdit(): void {
  if (!active || lastId === null) return;
  active.handlers.onEdit(lastId, `(modifié à distance) message #${lastId}`);
}

/** Simule la suppression distante du dernier message simule. */
export function simulateIncomingDelete(): void {
  if (!active || lastId === null) return;
  active.handlers.onDelete(lastId);
  lastId = null;
}
