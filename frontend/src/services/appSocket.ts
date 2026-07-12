import { type AuthorUpdate, type ChannelMessage, type Role } from '../types/domain.ts';
import { type ProgramRoleName } from '../helpers/roles.ts';
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

/**
 * SCAFFOLD du vrai client WebSocket (à finir le jour du branchement temps réel).
 *
 * UNE SEULE connexion persistante pour toute l'app, partagée par le chat et le
 * forum (plusieurs « rooms »). `createAppSocket` renvoie deux facades :
 *   - `channels` : `ChannelSocket` attendu par `useChannelMessages`
 *   - `forums`   : `ForumSocket`   attendu par `useForumThreads`
 *
 * Authentification : le handshake s'appuie sur le cookie HttpOnly `moodit_token`, envoyé
 * automatiquement par le navigateur (même origine). Aucun token n'est passé côté JS.
 *
 * Pour l'activer : dans Dashboard, remplacer les mocks par
 *   const ws = useMemo(() => createAppSocket(), []);
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
  | { type: 'post:edited'; forumId: number; postId: number; content: string; title?: string | null }
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
  // Le rôle de l'utilisateur DANS un programme a changé (User_Program_Role) → ses menus
  // d'actions administratives se re-gatent. `roleName` = rôle le plus élevé restant, ou null.
  | {
      type: 'program:roleChanged';
      userId: number;
      programId: number;
      roleName: ProgramRoleName | null;
    }
  // Les rôles GLOBAUX de l'utilisateur (User_Role) ont changé → il re-dérive ses droits
  // plateforme (admin général / Gardien). `roles` = liste globale à jour.
  | { type: 'user:globalRolesChanged'; userId: number; roles: Role[] }
  | { type: 'subscription:added'; userId: number; program: Program }
  | { type: 'subscription:removed'; userId: number; programId: number }
  // Correction ASYNCHRONE d'une tentative de quiz (scope = utilisateur) : poussé à l'auteur quand
  // le job de correction se termine (succès → résultat consultable ; échec → tentative supprimée).
  | { type: 'quiz:attempt-graded'; userId: number; quizId: number; attemptId: number }
  | { type: 'quiz:attempt-failed'; userId: number; quizId: number; attemptId: number; reason?: string }
  // Analyses MCP (scope = cours) : poussé quand un job d'analyse se termine (succès / échec).
  | { type: 'mcp:analysis-created'; courseId: number; analysis: McpResponseSummary }
  | { type: 'mcp:analysis-failed'; courseId: number; userId: number; reason?: string }
  | { type: 'mcp:analysis-progress'; courseId: number; userId: number; step: string }
  // Profil utilisateur mis à jour (scope GLOBAL) : l'auteur des messages/posts change
  // partout. Appliqué à TOUS les canaux et forums abonnés (pas de room précise).
  | { type: 'user:updated'; user: AuthorUpdate }
  // Catalogue d'un établissement mis à jour (scope GLOBAL) : LISTE à jour de ses programmes.
  // Le popup « Ajouter un programme » (s'il est ouvert) met à jour l'établissement par id
  // (nombre, codes, et liste détaillée si elle est affichée).
  | { type: 'establishment:updated'; establishmentId: number; programs: Program[] }
  // Établissement créé / modifié (nom, domaine) — scope GLOBAL.
  | {
      type: 'establishment:upserted';
      id: number;
      name: string;
      domainEmail: string;
      programCount: number;
      programCodes: string[];
    }
  // Établissement supprimé — scope GLOBAL.
  | { type: 'establishment:deleted'; establishmentId: number }
  // Rôles ADMINISTRATEURS (User_Role) modifiés — room dédiée `adminRoles:0`. Porte la LISTE À JOUR
  // des utilisateurs ayant un rôle global ; le popup « Gérer les administrateurs » remplace sa liste.
  | { type: 'adminRoles:changed'; users: GlobalRoleUser[] };

/** Évènement temps réel sur le catalogue d'établissements (scope GLOBAL). */
export type EstablishmentEvent =
  | { kind: 'catalog'; establishmentId: number; programs: Program[] }
  | {
      kind: 'upserted';
      id: number;
      name: string;
      domainEmail: string;
      programCount: number;
      programCodes: string[];
    }
  | { kind: 'deleted'; establishmentId: number };

/** Facade « établissements » : s'abonner aux évènements GLOBAUX du catalogue. */
export interface EstablishmentsSocket {
  /** S'abonne ; renvoie la fonction de désabonnement. */
  subscribe: (handler: (event: EstablishmentEvent) => void) => () => void;
}

/**
 * Utilisateur avec ses rôles globaux, tel que sérialisé par le backend (UserDTO). Le champ `roles`
 * = ids des rôles globaux ; le consommateur le mappe vers `role_ids` (cf. RoleEditorPopup).
 */
export interface GlobalRoleUser {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  avatarColor: string;
  roles: number[];
}

/** Facade « administrateurs » : liste À JOUR des porteurs d'un rôle global (popup admins). */
export interface AdminRolesSocket {
  /** S'abonne ; chaque évènement porte la liste complète. Renvoie la fonction de désabonnement. */
  subscribe: (handler: (users: GlobalRoleUser[]) => void) => () => void;
}

export interface AppSocket {
  channels: ChannelSocket;
  forums: ForumSocket;
  courses: CourseChannelsSocket;
  programs: ProgramsSocket;
  mcp: McpSocket;
  establishments: EstablishmentsSocket;
  adminRoles: AdminRolesSocket;
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

export function createAppSocket(url: string = defaultWebSocketUrl()): AppSocket {
  let ws: WebSocket | null = null;
  let reconnectDelay = 1000;
  /** Fermeture demandée par le client : empêche la reconnexion automatique. */
  let closedByClient = false;
  let reconnectTimer: number | null = null;
  // Heartbeat : ping applicatif périodique pour garder la connexion active (le serveur ignore les
  // types inconnus). Évite qu'un proxy/NAT ferme une WebSocket inactive → reconnexion + resync qui
  // rechargerait la vue quiz toute seule.
  let heartbeatTimer: number | null = null;
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
  /** Abonnés aux évènements GLOBAUX du catalogue d'établissements (popup ouvert). */
  const establishmentSubs = new Set<(event: EstablishmentEvent) => void>();
  const adminRoleSubs = new Set<(users: GlobalRoleUser[]) => void>();
  const programSubs = new Map<number, IncomingProgramHandlers>();
  const mcpSubs = new Map<number, IncomingMcpHandlers>();

  const send = (data: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };

  function connect() {
    closedByClient = false;
    // Référence locale : permet d'ignorer les évènements d'un socket périmé (ex. un
    // ancien socket fermé par le double-montage StrictMode pendant qu'un nouveau s'ouvre).
    // Le cookie HttpOnly `moodit_token` est envoyé automatiquement au handshake (même
    // origine) ; le gateway l'y valide. Plus de token en query string.
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      reconnectDelay = 1000;
      const reconnected = everConnected;
      everConnected = true;
      // Ping toutes les 30 s tant que la socket est ouverte (garde la connexion vivante).
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
      heartbeatTimer = window.setInterval(() => send({ type: 'ping' }), 30_000);
      // (Re)joindre toutes les rooms actives — utile après une reconnexion.
      for (const channelId of channelSubs.keys()) send({ type: 'join', scope: 'channel', id: channelId });
      for (const forumId of forumSubs.keys()) send({ type: 'join', scope: 'forum', id: forumId });
      for (const programId of courseSubs.keys()) send({ type: 'join', scope: 'program', id: programId });
      for (const userId of programSubs.keys()) send({ type: 'join', scope: 'user', id: userId });
      for (const courseId of mcpSubs.keys()) send({ type: 'join', scope: 'mcp', id: courseId });
      // Room UNIQUE du catalogue d'établissements (id 0), si le popup est ouvert.
      if (establishmentSubs.size > 0) send({ type: 'join', scope: 'establishment', id: 0 });
      if (adminRoleSubs.size > 0) send({ type: 'join', scope: 'adminRoles', id: 0 });

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
          forumSubs.get(data.forumId)?.onEdit(data.postId, data.content, data.title);
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
        case 'program:roleChanged':
          programSubs.get(data.userId)?.onProgramRoleChange?.(data.programId, data.roleName);
          break;
        case 'user:globalRolesChanged':
          programSubs.get(data.userId)?.onGlobalRolesChange?.(data.roles);
          break;
        case 'quiz:attempt-graded':
          programSubs.get(data.userId)?.onQuizAttemptGraded?.(data.quizId, data.attemptId);
          break;
        case 'quiz:attempt-failed':
          programSubs.get(data.userId)?.onQuizAttemptFailed?.(data.quizId, data.attemptId, data.reason);
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
        case 'user:updated':
          // Évènement GLOBAL : on ne connaît pas les rooms où l'auteur apparaît → on
          // notifie TOUS les canaux et forums abonnés, qui mettent à jour l'auteur par id.
          for (const handlers of channelSubs.values()) handlers.onUserUpdate?.(data.user);
          for (const handlers of forumSubs.values()) handlers.onUserUpdate?.(data.user);
          break;
        case 'establishment:updated':
          // Évènement GLOBAL : on notifie les abonnés (popup « Ajouter un programme » ouvert).
          for (const handler of establishmentSubs)
            handler({ kind: 'catalog', establishmentId: data.establishmentId, programs: data.programs });
          break;
        case 'establishment:upserted':
          for (const handler of establishmentSubs)
            handler({
              kind: 'upserted',
              id: data.id,
              name: data.name,
              domainEmail: data.domainEmail,
              programCount: data.programCount,
              programCodes: data.programCodes,
            });
          break;
        case 'establishment:deleted':
          for (const handler of establishmentSubs)
            handler({ kind: 'deleted', establishmentId: data.establishmentId });
          break;
        case 'adminRoles:changed':
          for (const handler of adminRoleSubs) handler(data.users);
          break;
      }
    };

    socket.onclose = () => {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
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
    establishments: {
      // Room UNIQUE « establishment » (id 0) : on la rejoint au 1er abonné, on la quitte au
      // dernier (évite de diffuser à toutes les sessions inutilement).
      subscribe(handler) {
        const wasEmpty = establishmentSubs.size === 0;
        establishmentSubs.add(handler);
        if (wasEmpty) send({ type: 'join', scope: 'establishment', id: 0 });
        return () => {
          establishmentSubs.delete(handler);
          if (establishmentSubs.size === 0) send({ type: 'leave', scope: 'establishment', id: 0 });
        };
      },
    },
    adminRoles: {
      // Room UNIQUE `adminRoles:0` : rejointe au 1er abonné (popup admins ouvert), quittée au dernier.
      subscribe(handler) {
        const wasEmpty = adminRoleSubs.size === 0;
        adminRoleSubs.add(handler);
        if (wasEmpty) send({ type: 'join', scope: 'adminRoles', id: 0 });
        return () => {
          adminRoleSubs.delete(handler);
          if (adminRoleSubs.size === 0) send({ type: 'leave', scope: 'adminRoles', id: 0 });
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
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
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
