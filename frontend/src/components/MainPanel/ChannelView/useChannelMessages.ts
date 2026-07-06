import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ChannelMessage,
  type ChannelMessageAuthor,
} from '../../CourseChannelList/CourseChannelList';
import { type AuthorUpdate } from '../../../types/domain.ts';

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Callback d'envoi d'un message (API-ready). Reçoit l'id du canal (Forum 'Discussion')
 * cible, le contenu, l'id du message parent (`postParentId`, null si racine) et le
 * `clientMessageId` (nonce). Le parent persiste (POST) ; il peut renvoyer le message
 * persiste (id reel cote serveur, et le meme `clientMsgId`) qui remplacera l'optimiste.
 */
export type SendMessageHandler = (
  channelId: number,
  content: string,
  parentId: number | null,
  clientMessageId: string
) => MaybePromise<ChannelMessage | void>;

/**
 * Callback de modification d'un message (API-ready). Reçoit l'id et le nouveau
 * contenu ; peut renvoyer le message persiste (contenu cote serveur fait foi).
 */
export type EditMessageHandler = (
  messageId: number,
  content: string
) => MaybePromise<ChannelMessage | void>;

/** Callback de suppression d'un message (API-ready). Reçoit l'id du message. */
export type DeleteMessageHandler = (messageId: number) => MaybePromise<unknown>;

/** Handlers d'evenements temps reel pousses par le socket pour un canal. */
export interface IncomingMessageHandlers {
  /** Un message a ete cree (par soi ou un autre utilisateur). */
  onMessage: (message: ChannelMessage) => void;
  /** Un message a ete modifie. */
  onEdit: (messageId: number, content: string) => void;
  /** Un message a ete supprime. */
  onDelete: (messageId: number) => void;
  /** Un utilisateur a modifie son profil (GLOBAL) : maj de l'auteur des messages, par id. */
  onUserUpdate?: (user: AuthorUpdate) => void;
}

/**
 * Contrat minimal d'un socket temps reel. Une seule methode : s'abonner aux
 * evenements d'un canal. L'implementation (WebSocket natif, socket.io, mock…)
 * est fournie par le parent ; le hook ne connait que cette interface.
 */
export interface ChannelSocket {
  /** S'abonne aux evenements du canal ; renvoie la fonction de desabonnement. */
  subscribe: (channelId: number, handlers: IncomingMessageHandlers) => () => void;
}

interface UseChannelMessagesParams {
  /** Id du canal courant (pour le chargement et l'abonnement temps reel). */
  channelId: number;
  /** Messages de depart (cache / SSR / mock). Affiches immediatement. */
  initialMessages: ChannelMessage[];
  /** Utilisateur connecte : auteur des envois optimistes. */
  currentUser: ChannelMessageAuthor;
  /**
   * Chargement d'une PAGE de messages (API-ready, GET). `before` = id du plus ancien message
   * déjà chargé (absent = page la plus récente) ; `limit` = taille de page. Appelé au montage
   * (page récente) puis à chaque « charger plus ancien » (infinite scroll). Absent → mode mock.
   */
  onFetchMessages?: (
    channelId: number,
    before?: number,
    limit?: number
  ) => MaybePromise<ChannelMessage[]>;
  /** Persistance (API). Optionnels : sans eux, le hook reste purement optimiste. */
  onSendMessage?: SendMessageHandler;
  onEditMessage?: EditMessageHandler;
  onDeleteMessage?: DeleteMessageHandler;
  /** Socket temps reel (optionnel) : sans lui, pas de reception live. */
  socket?: ChannelSocket;
}

export interface ChannelMessagesApi {
  /** Source de verite unique : la liste affichée, triée chronologiquement. */
  messages: ChannelMessage[];
  /** Chargement initial de l'historique en cours. */
  loading: boolean;
  /** Erreur de chargement initial (null = aucune) ; voir `reload`. */
  loadError: string | null;
  /** Relance le chargement de l'historique (bouton « Réessayer »). */
  reload: () => void;
  /** Reste-t-il des messages plus ANCIENS à charger ? (dernière page pleine). */
  hasMore: boolean;
  /** Chargement d'une page de messages plus anciens en cours (infinite scroll). */
  loadingOlder: boolean;
  /** Charge la page de messages plus ANCIENS (avant le plus ancien déjà chargé). */
  loadOlder: () => void;
  /** Envoi async en cours ? (désactive le bouton d'envoi). */
  pending: boolean;
  /** Message d'erreur de la dernière opération (null = aucune). */
  error: string | null;
  /** Efface l'erreur courante. */
  clearError: () => void;

  // ── Actions utilisateur : optimiste + rollback + persistance via les callbacks.
  /** Envoie un message ; resout a `true` en cas de succès, `false` si échec. */
  sendMessage: (content: string, parentId: number | null) => Promise<boolean>;
  /** Modifie un message (optimiste). */
  editMessage: (messageId: number, content: string) => void;
  /** Supprime un message (optimiste). */
  deleteMessage: (messageId: number) => void;

  // ── Événements ENTRANTS : à brancher sur la couche WebSocket.
  /** Insère (ou réconcilie, via `clientMsgId`/`id`) un message recu en temps reel. */
  applyIncomingMessage: (message: ChannelMessage) => void;
  /** Applique une modification distante. */
  applyIncomingEdit: (messageId: number, content: string) => void;
  /** Applique une suppression distante. */
  applyIncomingDelete: (messageId: number) => void;
}

/** Taille d'une page de messages (chargement initial + « plus ancien »). */
const MESSAGES_PAGE_SIZE = 30;

/** Tri chronologique (createdAt puis id pour départager). */
function chronological(a: ChannelMessage, b: ChannelMessage): number {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  return a.id - b.id;
}

function sortedInsert(list: ChannelMessage[], message: ChannelMessage): ChannelMessage[] {
  return [...list, message].sort(chronological);
}

/** Génère un identifiant client (nonce) pour réconcilier optimiste ↔ echo serveur. */
function generateClientId(seq: number): string {
  return globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${seq}`;
}

/**
 * Source de verite unique des messages d'un canal : une seule liste qui agrégé
 * l'historique, les envois optimistes (avec rollback) et — une fois branche — les
 * événements WebSocket entrants. C'est le point d'intégration WS + API.
 *
 * (Le composant est remonté via une `key` au changement de canal, donc l'état
 * est réinitialisé depuis `initialMessages` à chaque canal.)
 */
export function useChannelMessages({
  channelId,
  initialMessages,
  currentUser,
  onFetchMessages,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  socket,
}: UseChannelMessagesParams): ChannelMessagesApi {
  const [messages, setMessages] = useState<ChannelMessage[]>(() =>
    [...initialMessages].sort(chronological)
  );
  // On charge si un fetch est fourni (sinon on reste sur initialMessages).
  const [loading, setLoading] = useState<boolean>(Boolean(onFetchMessages));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Reste-t-il des messages plus anciens à charger ? (dernière page reçue pleine). */
  const [hasMore, setHasMore] = useState(false);
  /** Chargement d'une page plus ancienne en cours (verrou anti double-déclenchement). */
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Verrou synchrone du chargement « plus ancien » (l'état est asynchrone). */
  const loadingOlderRef = useRef(false);

  /** Composant monte ? Ignore les réponses async revenant apres démontage. */
  const mountedRef = useRef(true);
  /** Compteur monotone pour les id temporaires et les nonces. */
  const seqRef = useRef(0);
  /** Derniere version du fetch (ref → l'effet de chargement ne se relance pas si
   *  la fonction parente est recreee a chaque render). */
  const fetchRef = useRef(onFetchMessages);
  useEffect(() => {
    fetchRef.current = onFetchMessages;
  });
  /** Dernière liste de messages (ref stable → loadOlder lit sans se recréer). */
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Charge (ou recharge) la page LA PLUS RÉCENTE du canal via `onFetchMessages`. */
  const reload = useCallback(async () => {
    const fetchMessages = fetchRef.current;
    if (!fetchMessages) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await fetchMessages(channelId, undefined, MESSAGES_PAGE_SIZE);
      if (!mountedRef.current) return;
      setMessages([...fetched].sort(chronological));
      // Page pleine → il reste probablement des messages plus anciens.
      setHasMore(fetched.length >= MESSAGES_PAGE_SIZE);
    } catch {
      if (!mountedRef.current) return;
      setLoadError('Impossible de charger les messages. Réessayez.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [channelId]);

  /**
   * Charge la page de messages PLUS ANCIENS (curseur = plus petit id RÉEL déjà chargé, en
   * ignorant les optimistes à id négatif). Fusionne sans doublon ; met à jour `hasMore`.
   */
  const loadOlder = useCallback(async () => {
    const fetchMessages = fetchRef.current;
    // Verrou SYNCHRONE via ref : l'état loadingOlder est asynchrone, pas fiable pour l'anti-doublon.
    if (!fetchMessages || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);

    try {
      // Plus ancien id réel (positif) actuellement affiché = curseur.
      const oldestId = messagesRef.current
        .filter((m) => m.id > 0)
        .reduce((min, m) => (m.id < min ? m.id : min), Number.POSITIVE_INFINITY);
      const before = Number.isFinite(oldestId) ? oldestId : undefined;

      const older = await fetchMessages(channelId, before, MESSAGES_PAGE_SIZE);
      if (!mountedRef.current) return;
      setMessages((prev) => {
        const known = new Set(prev.map((m) => m.id));
        const merged = [...prev, ...older.filter((m) => !known.has(m.id))];
        return merged.sort(chronological);
      });
      setHasMore(older.length >= MESSAGES_PAGE_SIZE);
    } catch {
      // Silencieux : on n'affiche pas d'erreur bloquante pour un chargement d'historique.
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }, [channelId]);

  // Chargement initial au montage (= a chaque canal, grace au remount par `key`).
  useEffect(() => {
    void reload();
  }, [reload]);

  const clearError = useCallback(() => setError(null), []);

  /** Joue une mutation async avec garde anti-démontage ; rollback + erreur si échec. */
  async function runMutation(
    perform: () => MaybePromise<unknown>,
    rollback: () => void,
    errorMessage: string
  ) {
    setError(null);
    try {
      await perform();
    } catch {
      if (!mountedRef.current) return;
      rollback();
      setError(errorMessage);
    }
  }

  async function sendMessage(content: string, parentId: number | null): Promise<boolean> {
    const trimmed = content.trim();
    if (!trimmed) return false;

    const clientId = generateClientId(++seqRef.current);
    const tempId = -seqRef.current; // id temporaire négatif, unique pour la cle React
    const optimistic: ChannelMessage = {
      id: tempId,
      clientMsgId: clientId,
      content: trimmed,
      createdAt: new Date().toISOString(),
      author: currentUser,
      postParentId: parentId,
    };
    setMessages((prev) => sortedInsert(prev, optimistic));

    setError(null);
    setPending(true);
    try {
      const saved = onSendMessage
        ? await onSendMessage(channelId, trimmed, parentId, clientId)
        : undefined;
      if (!mountedRef.current) return true;
      // Réconciliation : on remplace l'optimiste par la version persistante.
      if (saved) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.clientMsgId === clientId || m.id === tempId);
          if (idx < 0) return sortedInsert(prev, saved);
          const next = [...prev];
          next[idx] = saved;
          return next.sort(chronological);
        });
      }
      return true;
    } catch {
      if (!mountedRef.current) return false;
      setMessages((prev) => prev.filter((m) => m.id !== tempId)); // rollback
      setError("Le message n'a pas pu être envoyé. Réessayez.");
      return false;
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  function editMessage(messageId: number, content: string) {
    const trimmed = content.trim();
    // id temporaire négatif = message pas encore confirmé côté serveur : on bloque.
    if (messageId < 0) return;
    const target = messages.find((m) => m.id === messageId);
    if (!target || !trimmed || trimmed === target.content) return;

    const previousContent = target.content;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content: trimmed } : m)));

    runMutation(
      async () => {
        const saved = onEditMessage ? await onEditMessage(messageId, trimmed) : undefined;
        // Le serveur fait foi sur le contenu final.
        if (saved && mountedRef.current) {
          setMessages((prev) => prev.map((m) => (m.id === messageId ? saved : m)));
        }
      },
      () =>
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content: previousContent } : m))
        ),
      "La modification n'a pas pu être enregistrée. Réessayez."
    );
  }

  function deleteMessage(messageId: number) {
    // id temporaire négatif = message pas encore confirmé côté serveur : on bloque.
    if (messageId < 0) return;
    const target = messages.find((m) => m.id === messageId);
    if (!target) return;

    setMessages((prev) => prev.filter((m) => m.id !== messageId));

    runMutation(
      () => (onDeleteMessage ? onDeleteMessage(messageId) : undefined),
      () => setMessages((prev) => sortedInsert(prev, target)),
      "Le message n'a pas pu être supprimé. Réessayez."
    );
  }

  // ── Entrants WebSocket : refs stables pour pouvoir s'abonner dans un effet.
  const applyIncomingMessage = useCallback((message: ChannelMessage) => {
    setMessages((prev) => {
      const idx = prev.findIndex(
        (m) =>
          m.id === message.id ||
          (message.clientMsgId != null && m.clientMsgId === message.clientMsgId)
      );
      if (idx < 0) return sortedInsert(prev, message);
      const next = [...prev];
      next[idx] = message; // réconcilie l'optimiste (ou met à jour le doublon)
      return next.sort(chronological);
    });
  }, []);

  const applyIncomingEdit = useCallback((messageId: number, content: string) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content } : m)));
  }, []);

  const applyIncomingDelete = useCallback((messageId: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  // Profil modifie (GLOBAL) : on remplace prenom/nom/couleur/username de l'auteur sur
  // tous les messages de cet utilisateur deja charges.
  const applyIncomingUserUpdate = useCallback((user: AuthorUpdate) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.author.id === user.id
          ? {
              ...m,
              author: {
                ...m.author,
                username: user.username,
                firstName: user.firstName,
                lastName: user.lastName,
                avatarColor: user.avatarColor,
              },
            }
          : m
      )
    );
  }, []);

  // Abonnement temps reel : on branche les evenements du socket sur la liste.
  // Le desabonnement (cleanup) se declenche au demontage / changement de canal.
  useEffect(() => {
    if (!socket) return;
    return socket.subscribe(channelId, {
      onMessage: applyIncomingMessage,
      onEdit: applyIncomingEdit,
      onDelete: applyIncomingDelete,
      onUserUpdate: applyIncomingUserUpdate,
    });
  }, [
    socket,
    channelId,
    applyIncomingMessage,
    applyIncomingEdit,
    applyIncomingDelete,
    applyIncomingUserUpdate,
  ]);

  return {
    messages,
    loading,
    loadError,
    reload: () => void reload(),
    hasMore,
    loadingOlder,
    loadOlder: () => void loadOlder(),
    pending,
    error,
    clearError,
    sendMessage,
    editMessage,
    deleteMessage,
    applyIncomingMessage,
    applyIncomingEdit,
    applyIncomingDelete,
  };
}
