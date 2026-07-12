import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAppSocket, type AppSocket } from './appSocket';

/**
 * Tests unitaires EXHAUSTIFS du client WebSocket de l'app (createAppSocket).
 *
 * On MOCKE la classe WebSocket globale via une FakeWebSocket qui :
 *   - capture les handlers (onopen/onmessage/onclose/onerror) et l'URL,
 *   - enregistre tous les payloads envoyés (send, désérialisés en objets),
 *   - permet de simuler onopen() / onmessage({ data }) / onclose() depuis les tests.
 *
 * On peut ainsi vérifier : l'ouverture idempotente, les join/leave des facades,
 * le DISPATCH de chaque ServerEvent vers le bon handler abonné, le resync à la
 * reconnexion, le heartbeat, et le fait que close() ne reconnecte pas.
 */

// ── FakeWebSocket ───────────────────────────────────────────────────────────

/** Constantes de readyState (identiques à la vraie API WebSocket). */
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Toutes les instances créées pendant un test, dans l'ordre de création. */
let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  url: string;
  readyState: number = CONNECTING;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  /** Payloads envoyés (JSON désérialisé), dans l'ordre. */
  sent: unknown[] = [];
  /** Nombre d'appels à close(). */
  closeCount = 0;

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = CLOSED;
    this.onclose?.();
  }

  // ── Helpers de simulation (pilotés par les tests) ──────────────────────────

  /** Simule l'établissement de la connexion (transition CONNECTING → OPEN). */
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Simule la réception d'un message (objet sérialisé en JSON). */
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  /** Simule la réception d'un message brut (chaîne non parsée). */
  emitRaw(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  /** Simule une fermeture côté serveur (sans passer par close() côté client). */
  simulateServerClose(): void {
    this.readyState = CLOSED;
    this.onclose?.();
  }

  /** Simule une erreur réseau. */
  simulateError(): void {
    this.onerror?.();
  }

  /** Toutes les commandes envoyées d'un type donné. */
  sentOfType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter(
      (m): m is Record<string, unknown> =>
        typeof m === 'object' && m !== null && (m as { type?: unknown }).type === type
    );
  }
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Le dernier socket créé (celui actuellement actif). */
function last(): FakeWebSocket {
  return sockets[sockets.length - 1];
}

/** Ouvre l'app socket et amène la connexion à l'état OPEN. */
function openAndConnect(app: AppSocket): FakeWebSocket {
  app.open();
  const s = last();
  s.simulateOpen();
  return s;
}

// ── open() ────────────────────────────────────────────────────────────────────

describe('createAppSocket · open()', () => {
  it("ouvre une connexion WebSocket sur l'URL fournie (auth par cookie, pas de token en query)", () => {
    const app = createAppSocket('ws://test/ws');
    app.open();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('ws://test/ws');
  });

  it("est idempotent : n'ouvre pas de 2e socket si CONNECTING", () => {
    const app = createAppSocket('ws://test/ws');
    app.open();
    app.open();
    expect(sockets).toHaveLength(1);
  });

  it("est idempotent : n'ouvre pas de 2e socket si déjà OPEN", () => {
    const app = createAppSocket('ws://test/ws');
    openAndConnect(app);
    app.open();
    expect(sockets).toHaveLength(1);
  });

  it("n'ajoute jamais de query string à l'URL (aucune fuite de token)", () => {
    const app = createAppSocket('ws://test/ws');
    app.open();
    expect(last().url).not.toContain('token=');
    expect(last().url).not.toContain('?');
  });
});

// ── Facades subscribe/unsubscribe : join / leave ──────────────────────────────

describe('createAppSocket · facades join/leave', () => {
  const noopChannel = { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() };
  const noopForum = {
    onPost: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onVote: vi.fn(),
  };
  const noopCourse = {
    onSectionChange: vi.fn(),
    onCourseUpsert: vi.fn(),
    onCourseDelete: vi.fn(),
  };
  const noopProgram = { onProgramUpsert: vi.fn(), onProgramRemove: vi.fn() };
  const noopMcp = { onAnalysisCreated: vi.fn() };

  it('channels.subscribe envoie join channel + unsubscribe envoie leave', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off = app.channels.subscribe(42, noopChannel);
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'channel', id: 42 });
    off();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'channel', id: 42 });
  });

  it('forums.subscribe envoie join forum + unsubscribe envoie leave', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off = app.forums.subscribe(7, noopForum);
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'forum', id: 7 });
    off();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'forum', id: 7 });
  });

  it('courses.subscribe envoie join program + unsubscribe envoie leave', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off = app.courses.subscribe(3, noopCourse);
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'program', id: 3 });
    off();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'program', id: 3 });
  });

  it('programs.subscribe envoie join user + unsubscribe envoie leave', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off = app.programs.subscribe(99, noopProgram);
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'user', id: 99 });
    off();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'user', id: 99 });
  });

  it('mcp.subscribe envoie join mcp + unsubscribe envoie leave', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off = app.mcp.subscribe(11, noopMcp);
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'mcp', id: 11 });
    off();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'mcp', id: 11 });
  });

  it('establishments : join id 0 au 1er abonné, leave au dernier seulement', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off1 = app.establishments.subscribe(vi.fn());
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'establishment', id: 0 });
    // 2e abonné : PAS de nouveau join.
    const off2 = app.establishments.subscribe(vi.fn());
    expect(s.sentOfType('join').filter((m) => m.scope === 'establishment')).toHaveLength(1);
    // 1er désabonnement : PAS de leave (il reste un abonné).
    off1();
    expect(s.sentOfType('leave')).not.toContainEqual({ type: 'leave', scope: 'establishment', id: 0 });
    // dernier désabonnement : leave.
    off2();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'establishment', id: 0 });
  });

  it('adminRoles : join id 0 au 1er abonné, leave au dernier seulement', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const off1 = app.adminRoles.subscribe(vi.fn());
    expect(s.sentOfType('join')).toContainEqual({ type: 'join', scope: 'adminRoles', id: 0 });
    const off2 = app.adminRoles.subscribe(vi.fn());
    expect(s.sentOfType('join').filter((m) => m.scope === 'adminRoles')).toHaveLength(1);
    off1();
    expect(s.sentOfType('leave')).not.toContainEqual({ type: 'leave', scope: 'adminRoles', id: 0 });
    off2();
    expect(s.sentOfType('leave')).toContainEqual({ type: 'leave', scope: 'adminRoles', id: 0 });
  });

  it("n'envoie rien si on s'abonne avant l'ouverture (socket non OPEN)", () => {
    const app = createAppSocket('ws://test/ws');
    // Pas de open() : send() ne fait rien (ws null).
    app.channels.subscribe(1, noopChannel);
    expect(sockets).toHaveLength(0);
  });
});

// ── Dispatch des ServerEvent : chat ───────────────────────────────────────────

describe('createAppSocket · dispatch chat', () => {
  function setup() {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = {
      onMessage: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onUserUpdate: vi.fn(),
    };
    app.channels.subscribe(10, h);
    return { s, h };
  }

  it('message:created → onMessage(message)', () => {
    const { s, h } = setup();
    const message = { id: 1 } as never;
    s.emit({ type: 'message:created', channelId: 10, message });
    expect(h.onMessage).toHaveBeenCalledWith(message);
  });

  it('message:edited → onEdit(messageId, content)', () => {
    const { s, h } = setup();
    s.emit({ type: 'message:edited', channelId: 10, messageId: 5, content: 'x' });
    expect(h.onEdit).toHaveBeenCalledWith(5, 'x');
  });

  it('message:deleted → onDelete(messageId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'message:deleted', channelId: 10, messageId: 5 });
    expect(h.onDelete).toHaveBeenCalledWith(5);
  });

  it("ne route pas vers un canal non abonné (channelId différent)", () => {
    const { s, h } = setup();
    s.emit({ type: 'message:created', channelId: 999, message: { id: 1 } as never });
    expect(h.onMessage).not.toHaveBeenCalled();
  });
});

// ── Dispatch : forum ──────────────────────────────────────────────────────────

describe('createAppSocket · dispatch forum', () => {
  function setup() {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = {
      onPost: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onVote: vi.fn(),
      onUserUpdate: vi.fn(),
    };
    app.forums.subscribe(20, h);
    return { s, h };
  }

  it('post:created → onPost(post, parentId)', () => {
    const { s, h } = setup();
    const post = { id: 1 } as never;
    s.emit({ type: 'post:created', forumId: 20, post, parentId: null });
    expect(h.onPost).toHaveBeenCalledWith(post, null);
  });

  it('post:edited → onEdit(postId, content, title)', () => {
    const { s, h } = setup();
    s.emit({ type: 'post:edited', forumId: 20, postId: 3, content: 'c', title: 'T' });
    expect(h.onEdit).toHaveBeenCalledWith(3, 'c', 'T');
  });

  it('post:deleted → onDelete(postId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'post:deleted', forumId: 20, postId: 3 });
    expect(h.onDelete).toHaveBeenCalledWith(3);
  });

  it('post:voted → onVote(postId, userId, value)', () => {
    const { s, h } = setup();
    s.emit({ type: 'post:voted', forumId: 20, postId: 3, userId: 8, value: 1 });
    expect(h.onVote).toHaveBeenCalledWith(3, 8, 1);
  });
});

// ── Dispatch : cours / sections / quiz (scope program) ────────────────────────

describe('createAppSocket · dispatch cours/sections/quiz', () => {
  function setup() {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = {
      onSectionChange: vi.fn(),
      onCourseUpsert: vi.fn(),
      onCourseDelete: vi.fn(),
      onQuizCreated: vi.fn(),
      onQuizUpdated: vi.fn(),
      onQuizReordered: vi.fn(),
      onQuizDeleted: vi.fn(),
      onResync: vi.fn(),
    };
    app.courses.subscribe(30, h);
    return { s, h };
  }

  it('course:created → onCourseUpsert(course)', () => {
    const { s, h } = setup();
    const course = { id: 1 } as never;
    s.emit({ type: 'course:created', programId: 30, course });
    expect(h.onCourseUpsert).toHaveBeenCalledWith(course);
  });

  it('course:edited → onCourseUpsert(course)', () => {
    const { s, h } = setup();
    const course = { id: 2 } as never;
    s.emit({ type: 'course:edited', programId: 30, course });
    expect(h.onCourseUpsert).toHaveBeenCalledWith(course);
  });

  it('course:deleted → onCourseDelete(courseId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'course:deleted', programId: 30, courseId: 77 });
    expect(h.onCourseDelete).toHaveBeenCalledWith(77);
  });

  it('section:changed → onSectionChange(courseId, sectionType, change)', () => {
    const { s, h } = setup();
    const change = { kind: 'added' } as never;
    s.emit({ type: 'section:changed', programId: 30, courseId: 5, sectionType: 'channel', change });
    expect(h.onSectionChange).toHaveBeenCalledWith(5, 'channel', change);
  });

  it('quiz:created → onQuizCreated(courseId, quizId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:created', programId: 30, courseId: 5, quizId: 9 });
    expect(h.onQuizCreated).toHaveBeenCalledWith(5, 9);
  });

  it('quiz:updated → onQuizUpdated(courseId, quizId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:updated', programId: 30, courseId: 5, quizId: 9 });
    expect(h.onQuizUpdated).toHaveBeenCalledWith(5, 9);
  });

  it('quiz:reordered → onQuizReordered(courseId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:reordered', programId: 30, courseId: 5 });
    expect(h.onQuizReordered).toHaveBeenCalledWith(5);
  });

  it('quiz:deleted → onQuizDeleted(courseId, quizId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:deleted', programId: 30, courseId: 5, quizId: 9 });
    expect(h.onQuizDeleted).toHaveBeenCalledWith(5, 9);
  });

  it('handlers quiz optionnels absents : pas de crash', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    app.courses.subscribe(30, {
      onSectionChange: vi.fn(),
      onCourseUpsert: vi.fn(),
      onCourseDelete: vi.fn(),
    });
    expect(() =>
      s.emit({ type: 'quiz:created', programId: 30, courseId: 5, quizId: 9 })
    ).not.toThrow();
  });
});

// ── Dispatch : programmes / abonnements / rôles (scope user) ──────────────────

describe('createAppSocket · dispatch programmes/abonnements', () => {
  function setup() {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = {
      onProgramUpsert: vi.fn(),
      onProgramRemove: vi.fn(),
      onProgramRoleChange: vi.fn(),
      onGlobalRolesChange: vi.fn(),
      onQuizAttemptGraded: vi.fn(),
      onQuizAttemptFailed: vi.fn(),
    };
    app.programs.subscribe(50, h);
    return { s, h };
  }

  it('program:created → onProgramUpsert(program)', () => {
    const { s, h } = setup();
    const program = { id: 1 } as never;
    s.emit({ type: 'program:created', userId: 50, program });
    expect(h.onProgramUpsert).toHaveBeenCalledWith(program);
  });

  it('program:updated → onProgramUpsert(program)', () => {
    const { s, h } = setup();
    const program = { id: 2 } as never;
    s.emit({ type: 'program:updated', userId: 50, program });
    expect(h.onProgramUpsert).toHaveBeenCalledWith(program);
  });

  it('subscription:added → onProgramUpsert(program)', () => {
    const { s, h } = setup();
    const program = { id: 3 } as never;
    s.emit({ type: 'subscription:added', userId: 50, program });
    expect(h.onProgramUpsert).toHaveBeenCalledWith(program);
  });

  it('program:deleted → onProgramRemove(programId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'program:deleted', userId: 50, programId: 4 });
    expect(h.onProgramRemove).toHaveBeenCalledWith(4);
  });

  it('subscription:removed → onProgramRemove(programId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'subscription:removed', userId: 50, programId: 4 });
    expect(h.onProgramRemove).toHaveBeenCalledWith(4);
  });

  it('program:roleChanged → onProgramRoleChange(programId, roleName)', () => {
    const { s, h } = setup();
    s.emit({ type: 'program:roleChanged', userId: 50, programId: 4, roleName: 'Enseignant' });
    expect(h.onProgramRoleChange).toHaveBeenCalledWith(4, 'Enseignant');
  });

  it('program:roleChanged avec roleName null', () => {
    const { s, h } = setup();
    s.emit({ type: 'program:roleChanged', userId: 50, programId: 4, roleName: null });
    expect(h.onProgramRoleChange).toHaveBeenCalledWith(4, null);
  });

  it('user:globalRolesChanged → onGlobalRolesChange(roles)', () => {
    const { s, h } = setup();
    const roles = [{ id: 1 }] as never;
    s.emit({ type: 'user:globalRolesChanged', userId: 50, roles });
    expect(h.onGlobalRolesChange).toHaveBeenCalledWith(roles);
  });

  it('quiz:attempt-graded → onQuizAttemptGraded(quizId, attemptId)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:attempt-graded', userId: 50, quizId: 12, attemptId: 88 });
    expect(h.onQuizAttemptGraded).toHaveBeenCalledWith(12, 88);
  });

  it('quiz:attempt-failed → onQuizAttemptFailed(quizId, attemptId, reason)', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:attempt-failed', userId: 50, quizId: 12, attemptId: 88, reason: 'boom' });
    expect(h.onQuizAttemptFailed).toHaveBeenCalledWith(12, 88, 'boom');
  });

  it('quiz:attempt-failed sans reason → reason undefined', () => {
    const { s, h } = setup();
    s.emit({ type: 'quiz:attempt-failed', userId: 50, quizId: 12, attemptId: 88 });
    expect(h.onQuizAttemptFailed).toHaveBeenCalledWith(12, 88, undefined);
  });
});

// ── Dispatch : MCP (scope cours) ──────────────────────────────────────────────

describe('createAppSocket · dispatch MCP', () => {
  function setup() {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = {
      onAnalysisCreated: vi.fn(),
      onAnalysisFailed: vi.fn(),
      onAnalysisProgress: vi.fn(),
      onResync: vi.fn(),
    };
    app.mcp.subscribe(60, h);
    return { s, h };
  }

  it('mcp:analysis-created → onAnalysisCreated(analysis)', () => {
    const { s, h } = setup();
    const analysis = { id: 1 } as never;
    s.emit({ type: 'mcp:analysis-created', courseId: 60, analysis });
    expect(h.onAnalysisCreated).toHaveBeenCalledWith(analysis);
  });

  it('mcp:analysis-failed → onAnalysisFailed(userId, reason)', () => {
    const { s, h } = setup();
    s.emit({ type: 'mcp:analysis-failed', courseId: 60, userId: 7, reason: 'x' });
    expect(h.onAnalysisFailed).toHaveBeenCalledWith(7, 'x');
  });

  it('mcp:analysis-progress → onAnalysisProgress(userId, step)', () => {
    const { s, h } = setup();
    s.emit({ type: 'mcp:analysis-progress', courseId: 60, userId: 7, step: 'collect' });
    expect(h.onAnalysisProgress).toHaveBeenCalledWith(7, 'collect');
  });
});

// ── Dispatch GLOBAL : user:updated (tous canaux + forums) ─────────────────────

describe('createAppSocket · dispatch user:updated (global)', () => {
  it('notifie onUserUpdate de TOUS les canaux et forums abonnés', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const c1 = { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onUserUpdate: vi.fn() };
    const c2 = { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), onUserUpdate: vi.fn() };
    const f1 = {
      onPost: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onVote: vi.fn(),
      onUserUpdate: vi.fn(),
    };
    app.channels.subscribe(1, c1);
    app.channels.subscribe(2, c2);
    app.forums.subscribe(3, f1);

    const user = { id: 5 } as never;
    s.emit({ type: 'user:updated', user });

    expect(c1.onUserUpdate).toHaveBeenCalledWith(user);
    expect(c2.onUserUpdate).toHaveBeenCalledWith(user);
    expect(f1.onUserUpdate).toHaveBeenCalledWith(user);
  });

  it('ne crashe pas si onUserUpdate est absent (optionnel)', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    app.channels.subscribe(1, { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() });
    expect(() => s.emit({ type: 'user:updated', user: { id: 5 } as never })).not.toThrow();
  });
});

// ── Dispatch : établissements (global) ────────────────────────────────────────

describe('createAppSocket · dispatch établissements', () => {
  it('establishment:updated → handler({ kind: "catalog", ... })', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const handler = vi.fn();
    app.establishments.subscribe(handler);
    const programs = [{ id: 1 }] as never;
    s.emit({ type: 'establishment:updated', establishmentId: 4, programs });
    expect(handler).toHaveBeenCalledWith({ kind: 'catalog', establishmentId: 4, programs });
  });

  it('establishment:upserted → handler({ kind: "upserted", ... })', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const handler = vi.fn();
    app.establishments.subscribe(handler);
    s.emit({
      type: 'establishment:upserted',
      id: 4,
      name: 'ETS',
      domainEmail: 'ets.ca',
      programCount: 2,
      programCodes: ['A', 'B'],
    });
    expect(handler).toHaveBeenCalledWith({
      kind: 'upserted',
      id: 4,
      name: 'ETS',
      domainEmail: 'ets.ca',
      programCount: 2,
      programCodes: ['A', 'B'],
    });
  });

  it('establishment:deleted → handler({ kind: "deleted", ... })', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const handler = vi.fn();
    app.establishments.subscribe(handler);
    s.emit({ type: 'establishment:deleted', establishmentId: 4 });
    expect(handler).toHaveBeenCalledWith({ kind: 'deleted', establishmentId: 4 });
  });

  it('notifie TOUS les abonnés établissements', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h1 = vi.fn();
    const h2 = vi.fn();
    app.establishments.subscribe(h1);
    app.establishments.subscribe(h2);
    s.emit({ type: 'establishment:deleted', establishmentId: 9 });
    expect(h1).toHaveBeenCalledWith({ kind: 'deleted', establishmentId: 9 });
    expect(h2).toHaveBeenCalledWith({ kind: 'deleted', establishmentId: 9 });
  });
});

// ── Dispatch : adminRoles ─────────────────────────────────────────────────────

describe('createAppSocket · dispatch adminRoles', () => {
  it('adminRoles:changed → handler(users)', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const handler = vi.fn();
    app.adminRoles.subscribe(handler);
    const users = [{ id: 1, username: 'a' }] as never;
    s.emit({ type: 'adminRoles:changed', users });
    expect(handler).toHaveBeenCalledWith(users);
  });
});

// ── JSON invalide / types inconnus ────────────────────────────────────────────

describe('createAppSocket · robustesse du dispatch', () => {
  it('ignore un JSON invalide sans crasher', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    const h = { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() };
    app.channels.subscribe(1, h);
    expect(() => s.emitRaw('{ pas du json }')).not.toThrow();
    expect(h.onMessage).not.toHaveBeenCalled();
  });

  it('ignore un type inconnu sans crasher', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    expect(() => s.emit({ type: 'inconnu:xyz', foo: 1 })).not.toThrow();
  });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('createAppSocket · heartbeat', () => {
  it('envoie un ping toutes les 30 s après ouverture', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    expect(s.sentOfType('ping')).toHaveLength(0);
    vi.advanceTimersByTime(30_000);
    expect(s.sentOfType('ping')).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(s.sentOfType('ping')).toHaveLength(2);
  });

  it("arrête le heartbeat à la fermeture (plus de ping après close)", () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    vi.advanceTimersByTime(30_000);
    expect(s.sentOfType('ping')).toHaveLength(1);
    app.close();
    vi.advanceTimersByTime(60_000);
    expect(s.sentOfType('ping')).toHaveLength(1);
  });
});

// ── Reconnexion + resync ──────────────────────────────────────────────────────

describe('createAppSocket · reconnexion et resync', () => {
  it('reconnecte après une fermeture serveur (nouveau socket via backoff)', () => {
    const app = createAppSocket('ws://test/ws');
    const s1 = openAndConnect(app);
    s1.simulateServerClose();
    // Backoff initial : 1000 ms.
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('re-join toutes les rooms actives à la reconnexion', () => {
    const app = createAppSocket('ws://test/ws');
    const s1 = openAndConnect(app);
    app.channels.subscribe(1, { onMessage: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn() });
    app.forums.subscribe(2, {
      onPost: vi.fn(),
      onEdit: vi.fn(),
      onDelete: vi.fn(),
      onVote: vi.fn(),
    });
    app.courses.subscribe(3, {
      onSectionChange: vi.fn(),
      onCourseUpsert: vi.fn(),
      onCourseDelete: vi.fn(),
    });
    app.programs.subscribe(4, { onProgramUpsert: vi.fn(), onProgramRemove: vi.fn() });
    app.mcp.subscribe(5, { onAnalysisCreated: vi.fn() });
    app.establishments.subscribe(vi.fn());
    app.adminRoles.subscribe(vi.fn());

    // Coupure + reconnexion.
    s1.simulateServerClose();
    vi.advanceTimersByTime(1000);
    const s2 = last();
    s2.simulateOpen();

    const joins = s2.sentOfType('join');
    expect(joins).toContainEqual({ type: 'join', scope: 'channel', id: 1 });
    expect(joins).toContainEqual({ type: 'join', scope: 'forum', id: 2 });
    expect(joins).toContainEqual({ type: 'join', scope: 'program', id: 3 });
    expect(joins).toContainEqual({ type: 'join', scope: 'user', id: 4 });
    expect(joins).toContainEqual({ type: 'join', scope: 'mcp', id: 5 });
    expect(joins).toContainEqual({ type: 'join', scope: 'establishment', id: 0 });
    expect(joins).toContainEqual({ type: 'join', scope: 'adminRoles', id: 0 });
  });

  it('appelle onResync (mcp + courses) à la RECONNEXION uniquement', () => {
    const app = createAppSocket('ws://test/ws');
    const s1 = openAndConnect(app);
    const mcp = { onAnalysisCreated: vi.fn(), onResync: vi.fn() };
    const course = {
      onSectionChange: vi.fn(),
      onCourseUpsert: vi.fn(),
      onCourseDelete: vi.fn(),
      onResync: vi.fn(),
    };
    app.mcp.subscribe(5, mcp);
    app.courses.subscribe(3, course);

    // 1re connexion : PAS de resync.
    expect(mcp.onResync).not.toHaveBeenCalled();
    expect(course.onResync).not.toHaveBeenCalled();

    // Reconnexion.
    s1.simulateServerClose();
    vi.advanceTimersByTime(1000);
    last().simulateOpen();

    expect(mcp.onResync).toHaveBeenCalledTimes(1);
    expect(course.onResync).toHaveBeenCalledTimes(1);
  });

  it('applique un backoff exponentiel plafonné et le réinitialise à la reconnexion', () => {
    const app = createAppSocket('ws://test/ws');
    const s1 = openAndConnect(app);

    // 1re coupure : reconnexion après 1000 ms.
    s1.simulateServerClose();
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    // 2e socket ne s'ouvre PAS puis se ferme : backoff monte à 2000 ms.
    last().simulateServerClose();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    // Un onopen réussi réinitialise le délai à 1000 ms.
    last().simulateOpen();
    last().simulateServerClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
  });
});

// ── close() ───────────────────────────────────────────────────────────────────

describe('createAppSocket · close()', () => {
  it('ferme le socket et NE reconnecte PAS', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    app.close();
    expect(s.closeCount).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('sur un socket encore CONNECTING : neutralise les handlers et ne rejoint aucune room', () => {
    const app = createAppSocket('ws://test/ws');
    app.open();
    const s = last();
    expect(s.readyState).toBe(CONNECTING);
    app.close();
    // Handlers onmessage/onclose/onerror neutralisés ; onopen ferme le socket.
    expect(s.onmessage).toBeNull();
    expect(s.onclose).toBeNull();
    expect(s.onerror).toBeNull();
    // Quand le socket finit par s'ouvrir, il se ferme proprement sans join.
    s.readyState = OPEN;
    s.onopen?.();
    expect(s.closeCount).toBe(1);
    expect(s.sentOfType('join')).toHaveLength(0);
  });

  it("est sûr d'appeler close() sans socket ouvert", () => {
    const app = createAppSocket('ws://test/ws');
    expect(() => app.close()).not.toThrow();
    expect(sockets).toHaveLength(0);
  });

  it('après close(), open() rouvre une nouvelle connexion', () => {
    const app = createAppSocket('ws://test/ws');
    openAndConnect(app);
    app.close();
    app.open();
    expect(sockets).toHaveLength(2);
  });
});

// ── onerror ───────────────────────────────────────────────────────────────────

describe('createAppSocket · onerror', () => {
  it('ferme le socket en cas d\'erreur', () => {
    const app = createAppSocket('ws://test/ws');
    const s = openAndConnect(app);
    s.simulateError();
    expect(s.closeCount).toBe(1);
  });
});
