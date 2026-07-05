import { type ChannelMessage } from '../types/domain.ts';
import {
  type ChannelSocket,
  type IncomingMessageHandlers,
} from '../components/MainPanel/ChannelView/useChannelMessages';
import { type ForumPost } from '../types/domain.ts';
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
import { type ItemChange } from '../components/SectionEditorPopup/types.ts';
import {
  type Program,
  type IncomingProgramHandlers,
  type ProgramsSocket,
} from '../components/ProgramMenu/ProgramMenu';
import {
  type IncomingMcpHandlers,
  type McpResponseSummary,
  type McpSocket,
} from '../components/McpManagementPopup/types.ts';
import {
  type IncomingQuizGradeHandlers,
  type QuizGradingSocket,
} from '../components/MainPanel/QuizView/quizAttempt';
import { type QuestionResult } from '../components/MainPanel/QuizView/quizAttempt';

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
  | { type: 'quiz:created'; programId: number; courseId: number; quizId: number }
  | { type: 'quiz:updated'; programId: number; courseId: number; quizId: number }
  | { type: 'quiz:reordered'; programId: number; courseId: number }
  | { type: 'quiz:deleted'; programId: number; courseId: number; quizId: number }
  // Programmes / abonnements (scope = utilisateur)
  | { type: 'program:created'; userId: number; program: Program }
  | { type: 'program:updated'; userId: number; program: Program }
  | { type: 'program:deleted'; userId: number; programId: number }
  | { type: 'subscription:added'; userId: number; program: Program }
  | { type: 'subscription:removed'; userId: number; programId: number }
  // Analyses MCP (scope = cours) : poussé quand un job d'analyse se termine (succès / échec).
  | { type: 'mcp:analysis-created'; courseId: number; analysis: McpResponseSummary }
  | { type: 'mcp:analysis-failed'; courseId: number; userId: number; reason?: string }
  | { type: 'mcp:analysis-progress'; courseId: number; userId: number; step: string }
  | { type: 'quiz:code-graded'; userId: number; attemptId: number; questions: QuestionResult[] };

export interface AppSocket {
  channels: ChannelSocket;
  forums: ForumSocket;
  courses: CourseChannelsSocket;
  programs: ProgramsSocket;
  mcp: McpSocket;
  quizGrading: QuizGradingSocket;
  /** Ouvre (ou rouvre) la connexion. Idempotent. À appeler au montage. */
  open: () => void;
  /** Ferme volontairement la connexion (logout / démontage) : pas de reconnexion. */
  close: () => void;
}

/**
 * URL du WebSocket. Par défaut : même origine que la page, en ws/wss selon http/https,
 * sur le chemin `/ws` (proxifié par Vite en dev, par le gateway en prod). Surchargeable
 * via `VITE_WS_URL` (ex. connexion directe au core-service sans passer par le gateway).
 */
export function defaultWebSocketUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function createAppSocket(
  url: string = defaultWebSocketUrl(),
  getToken: () => string = () => ''
): AppSocket {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  /** Fermeture demandée par le client : empêche la reconnexion automatique. */
  let closedByClient = false;
  let reconnectTimer: number | null = null;
  /**
   * Passe à true au 1er `onopen`. Permet de distinguer la connexion INITIALE (les abonnés
   * viennent de fetcher au montage) d'une RECONNEXION (events potentiellement manqués →
   * resync). Persiste entre les sockets successifs (closure de createAppSocket).
   */
  let everConnected = false;
  /** Rooms actives (on peut être abonné a plusieurs canaux / forums / programmes). */
  const channelSubs = new Map<number, IncomingMessageHandlers>();
  const forumSubs = new Map<number, IncomingForumHandlers>();
  const courseSubs = new Map<number, IncomingCourseHandlers>();
  const programSubs = new Map<number, IncomingProgramHandlers>();
  const mcpSubs = new Map<number, IncomingMcpHandlers>();
  // Correction de code (scope user, room "user:<id>") : Map SÉPARÉE de programSubs pour que
  // QuizView et le menu Programmes puissent s'abonner au même scope sans se piétiner.
  const quizGradeSubs = new Map<number, IncomingQuizGradeHandlers>();

  const send = (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  function connect() {
    closedByClient = false;
    // Référence locale : permet d'ignorer les évènements d'un socket périmé (ex. un
    // ancien socket fermé par le double-montage StrictMode pendant qu'un nouveau s'ouvre).
    const socket = new WebSocket(`${url}?token=${encodeURIComponent(getToken())}`);
    ws = socket;

    socket.onopen = () => {
      reconnectDelay = 1000;
      const reconnected = everConnected;
      everConnected = true;
      // (Re)joindre toutes les rooms actives — utile après une reconnexion.
      for (const channelId of channelSubs.keys()) send({ type: 'join', scope: 'channel', id: channelId });
      for (const forumId of forumSubs.keys()) send({ type: 'join', scope: 'forum', id: forumId });
      for (const programId of courseSubs.keys()) send({ type: 'join', scope: 'program', id: programId });
      for (const userId of programSubs.keys()) send({ type: 'join', scope: 'user', id: userId });
      for (const courseId of mcpSubs.keys()) send({ type: 'join', scope: 'mcp', id: courseId });
      for (const userId of quizGradeSubs.keys()) send({ type: 'join', scope: 'user', id: userId });

      // Resync à la RECONNEXION uniquement : prévient les abonnés que des events ont pu
      // être manqués pendant la coupure (le rejoin ne rejoue pas l'historique). Branché
      // pour MCP ; généralisable aux autres scopes en ajoutant `onResync?` à leurs
      // handlers + une boucle ici (cf. mcpSubs).
      if (reconnected) {
        for (const handlers of mcpSubs.values()) handlers.onResync?.();
        for (const handlers of courseSubs.values()) handlers.onResync?.();
      }
    };

    socket.onmessage = (event) => {
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
          // La dédup optimiste ↔ écho est gérée par le hook (clientMsgId / clientPostId).
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
        case 'quiz:created':
          courseSubs.get(data.programId)?.onQuizCreated?.(data.courseId, data.quizId);
          break;
        case 'quiz:updated':
          courseSubs.get(data.programId)?.onQuizUpdated?.(data.courseId, data.quizId);
          break;
        case 'quiz:reordered':
          courseSubs.get(data.programId)?.onQuizReordered?.(data.courseId);
          break;
        case 'quiz:deleted':
          courseSubs.get(data.programId)?.onQuizDeleted?.(data.courseId, data.quizId);
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
        case 'mcp:analysis-created':
          mcpSubs.get(data.courseId)?.onAnalysisCreated(data.analysis);
          break;
        case 'mcp:analysis-failed':
          mcpSubs.get(data.courseId)?.onAnalysisFailed?.(data.userId, data.reason);
          break;
        case 'mcp:analysis-progress':
          mcpSubs.get(data.courseId)?.onAnalysisProgress?.(data.userId, data.step);
          break;
        case 'quiz:code-graded':
          quizGradeSubs.get(data.userId)?.onCodeGraded(data.attemptId, data.questions);
          break;
      }
    };

    socket.onclose = () => {
      // Fermeture volontaire (logout / démontage), ou socket déjà remplacé par un
      // nouveau (StrictMode) : on ne reconnecte pas.
      if (closedByClient || ws !== socket) return;
      // Sinon, reconnexion avec backoff exponentiel plafonné.
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
    };

    socket.onerror = () => socket.close();
  }

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
    mcp: {
      subscribe(courseId, handlers) {
        mcpSubs.set(courseId, handlers);
        send({ type: 'join', scope: 'mcp', id: courseId });
        return () => {
          mcpSubs.delete(courseId);
          send({ type: 'leave', scope: 'mcp', id: courseId });
        };
      },
    },
    quizGrading: {
      subscribe(userId, handlers) {
        quizGradeSubs.set(userId, handlers);
        send({ type: 'join', scope: 'user', id: userId });
        return () => {
          quizGradeSubs.delete(userId);
          // Pas de 'leave' : la room "user" est aussi tenue par l'abonnement Programmes
          // (toujours actif tant que connecté) — envoyer leave le couperait.
        };
      },
    },
    open() {
      // Idempotent : ne rouvre pas si une connexion est déjà en cours / établie.
      if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
      connect();
    },
    close() {
      closedByClient = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const socket = ws;
      ws = null;
      if (!socket) return;
      if (socket.readyState === WebSocket.CONNECTING) {
        // Fermer un socket encore en cours de connexion fait râler Chrome
        // ("closed before the connection is established") — fréquent au double-montage
        // StrictMode. On neutralise ses handlers et on ne le ferme qu'une fois OUVERT,
        // ce qui est une fermeture propre (sans warning). Il ne rejoint aucune room.
        socket.onopen = () => socket.close();
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
      } else {
        socket.close();
      }
    },
  };
}
