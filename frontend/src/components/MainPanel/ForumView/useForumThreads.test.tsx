import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useForumThreads } from './useForumThreads';
import type { IncomingForumHandlers, ForumSocket } from './useForumThreads';
import type { ForumPost, ForumAuthor } from './forumThreads';

afterEach(cleanup);

const user: ForumAuthor = {
  id: 1,
  username: 'jean',
  firstName: 'Jean',
  lastName: 'D.',
  avatarColor: '#123456',
};

function post(id: number, over: Partial<ForumPost> = {}): ForumPost {
  return {
    id,
    content: `c${id}`,
    createdAt: new Date(1000 + id).toISOString(),
    author: user,
    votes: [],
    replies: [],
    ...over,
  };
}

const FORUM = 3;

function mount(overrides: Partial<Parameters<typeof useForumThreads>[0]> = {}) {
  return renderHook(() =>
    useForumThreads({
      forumId: FORUM,
      initialThreads: [],
      currentUser: user,
      ...overrides,
    })
  );
}

describe('useForumThreads — chargement', () => {
  it('charge la page initiale', async () => {
    const onFetchThreads = vi.fn(async () => [post(1), post(2)]);
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onFetchThreads).toHaveBeenCalledWith(FORUM, undefined, 20);
    expect(result.current.threads.map((t) => t.id)).toEqual([1, 2]);
    expect(result.current.loadError).toBeNull();
  });

  it('positionne loadError si le fetch rejette', async () => {
    const onFetchThreads = vi.fn(async () => {
      throw new Error('x');
    });
    const { result } = mount({ onFetchThreads });
    await waitFor(() =>
      expect(result.current.loadError).toBe('Impossible de charger les sujets. Réessayez.')
    );
  });

  it('reload relance le fetch', async () => {
    const onFetchThreads = vi.fn(async () => [post(1)]);
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reload());
    await waitFor(() => expect(onFetchThreads).toHaveBeenCalledTimes(2));
  });

  it('sans fetch : reste sur initialThreads, loading false', async () => {
    const { result } = mount({ initialThreads: [post(1)] });
    expect(result.current.loading).toBe(false);
    expect(result.current.threads.map((t) => t.id)).toEqual([1]);
  });
});

describe('useForumThreads — loadReplies', () => {
  it('charge les réponses directes et met à jour replyCount', async () => {
    const onFetchReplies = vi.fn(async () => [post(11), post(12)]);
    const { result } = mount({ initialThreads: [post(1, { replies: undefined, replyCount: 2 })], onFetchReplies });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.loadReplies(1);
    });
    expect(ok).toBe(true);
    expect(onFetchReplies).toHaveBeenCalledWith(FORUM, 1);
    const parent = result.current.threads[0];
    expect(parent.replies?.map((r) => r.id)).toEqual([11, 12]);
    expect(parent.replyCount).toBe(2);
    expect(result.current.loadingReplies.has(1)).toBe(false);
  });

  it('id négatif : pas de fetch, réponses vides', async () => {
    const onFetchReplies = vi.fn(async () => [post(11)]);
    const { result } = mount({ initialThreads: [post(-5, { replies: undefined })], onFetchReplies });
    await act(async () => {
      await result.current.loadReplies(-5);
    });
    expect(onFetchReplies).not.toHaveBeenCalled();
    expect(result.current.threads[0].replies).toEqual([]);
  });

  it('échec du fetch : replyErrors renseigné', async () => {
    const onFetchReplies = vi.fn(async () => {
      throw new Error('x');
    });
    const { result } = mount({ initialThreads: [post(1, { replies: undefined })], onFetchReplies });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.loadReplies(1);
    });
    expect(ok).toBe(false);
    expect(result.current.replyErrors.has(1)).toBe(true);
  });
});

describe('useForumThreads — actions optimistes', () => {
  it('vote pose un vote optimiste et rollback si échec', async () => {
    const onVotePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ initialThreads: [post(1)], onVotePost });
    await act(async () => {
      result.current.vote(1, 1);
      await Promise.resolve();
    });
    // rollback : plus de vote
    expect(result.current.threads[0].votes).toEqual([]);
    expect(result.current.error).toBe("Votre vote n'a pas pu être enregistré. Réessayez.");
    expect(onVotePost).toHaveBeenCalledWith(1, 1);
  });

  it('vote toggle : re-cliquer la même direction envoie 0 localement', () => {
    const { result } = mount({
      initialThreads: [post(1, { votes: [{ userId: 1, value: 1 }] })],
    });
    act(() => result.current.vote(1, 1));
    expect(result.current.threads[0].votes.find((v) => v.userId === 1)).toBeUndefined();
  });

  it('vote bloque un id négatif', () => {
    const onVotePost = vi.fn();
    const { result } = mount({ initialThreads: [post(-1)], onVotePost });
    act(() => result.current.vote(-1, 1));
    expect(onVotePost).not.toHaveBeenCalled();
  });

  it('addThread insère un optimiste et réconcilie', async () => {
    const onCreatePost = vi.fn(async (_f, content: string, _p, clientId: string, title?: string) => ({
      ...post(77, { content, title }),
      clientPostId: clientId,
    }));
    const { result } = mount({ onCreatePost });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addThread('Titre', 'Contenu');
    });
    expect(ok).toBe(true);
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].id).toBe(77);
    expect(result.current.threads[0].title).toBe('Titre');
  });

  it('addThread rollback si échec', async () => {
    const onCreatePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ onCreatePost });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addThread('T', 'C');
    });
    expect(ok).toBe(false);
    expect(result.current.threads).toHaveLength(0);
    expect(result.current.error).toBe("Le sujet n'a pas pu être publié. Réessayez.");
  });

  it('addReply insère sous le parent et incrémente replyCount', async () => {
    const onCreatePost = vi.fn(async (_f, content: string, _p, clientId: string) => ({
      ...post(88, { content }),
      clientPostId: clientId,
    }));
    const { result } = mount({ initialThreads: [post(1, { replyCount: 0 })], onCreatePost });
    await act(async () => {
      await result.current.addReply(1, 'une réponse');
    });
    const parent = result.current.threads[0];
    expect(parent.replies?.map((r) => r.id)).toEqual([88]);
    expect(parent.replyCount).toBe(1);
  });

  it('editPost applique le contenu et bloque un id négatif', async () => {
    const onEditPost = vi.fn(async () => undefined);
    const { result } = mount({ initialThreads: [post(1, { content: 'avant' })], onEditPost });
    await act(async () => {
      await result.current.editPost(1, 'après');
    });
    expect(result.current.threads[0].content).toBe('après');

    onEditPost.mockClear();
    const neg = mount({ initialThreads: [post(-1, { content: 'x' })], onEditPost });
    await act(async () => {
      await neg.result.current.editPost(-1, 'y');
    });
    expect(onEditPost).not.toHaveBeenCalled();
  });

  it('deletePost retire le post et rollback si échec', async () => {
    const onDeletePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ initialThreads: [post(1), post(2)], onDeletePost });
    await act(async () => {
      result.current.deletePost(1);
      await Promise.resolve();
    });
    // rollback : le post revient
    expect(result.current.threads.map((t) => t.id).sort()).toEqual([1, 2]);
    expect(result.current.error).toBe("La suppression n'a pas pu être effectuée. Réessayez.");
  });
});

describe('useForumThreads — entrants WebSocket', () => {
  it('applyIncomingPost insère un nouveau sujet racine', () => {
    const { result } = mount({ initialThreads: [post(1)] });
    act(() => result.current.applyIncomingPost(post(2), null));
    expect(result.current.threads.map((t) => t.id)).toEqual([1, 2]);
  });

  it('applyIncomingPost dédup/réconcilie via clientPostId', () => {
    const optimistic = post(-1, { clientPostId: 'nonce-y' });
    const { result } = mount({ initialThreads: [optimistic] });
    act(() => result.current.applyIncomingPost({ ...post(60), clientPostId: 'nonce-y' }, null));
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].id).toBe(60);
  });

  it('applyIncomingEdit et applyIncomingDelete mettent à jour l\'arbre', () => {
    const { result } = mount({ initialThreads: [post(1, { content: 'a' }), post(2)] });
    act(() => result.current.applyIncomingEdit(1, 'edité'));
    expect(result.current.threads.find((t) => t.id === 1)?.content).toBe('edité');
    act(() => result.current.applyIncomingDelete(2));
    expect(result.current.threads.map((t) => t.id)).toEqual([1]);
  });

  it('applyIncomingVote pose le vote d\'un autre utilisateur', () => {
    const { result } = mount({ initialThreads: [post(1)] });
    act(() => result.current.applyIncomingVote(1, 99, 1));
    expect(result.current.threads[0].votes).toContainEqual({ userId: 99, value: 1 });
    act(() => result.current.applyIncomingVote(1, 99, 0));
    expect(result.current.threads[0].votes.find((v) => v.userId === 99)).toBeUndefined();
  });

  it('branche les handlers du socket et se désabonne au démontage', () => {
    const unsubscribe = vi.fn();
    let handlers: IncomingForumHandlers | null = null;
    const socket: ForumSocket = {
      subscribe: vi.fn((_id, h) => {
        handlers = h;
        return unsubscribe;
      }),
    };
    const { result, unmount } = mount({ initialThreads: [post(1)], socket });
    expect(socket.subscribe).toHaveBeenCalledWith(FORUM, expect.any(Object));
    act(() => handlers!.onPost(post(2), null));
    expect(result.current.threads.map((t) => t.id)).toEqual([1, 2]);
    act(() => handlers!.onVote(1, 5, -1));
    expect(result.current.threads.find((t) => t.id === 1)?.votes).toContainEqual({ userId: 5, value: -1 });
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});

/** Promesse résolue à la demande (contrôle fin de l'ordre asynchrone). */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Page de `n` sujets d'ids consécutifs à partir de `from`. */
function page(from: number, n: number): ForumPost[] {
  return Array.from({ length: n }, (_, i) => post(from + i));
}

/** Socket factice : capture les handlers à l'abonnement. */
function fakeSocket() {
  const ref: { handlers: IncomingForumHandlers | null } = { handlers: null };
  const socket: ForumSocket = {
    subscribe: (_id, h) => {
      ref.handlers = h;
      return () => {};
    },
  };
  return { socket, ref };
}

describe('useForumThreads — pagination (loadMore)', () => {
  it('page initiale pleine → hasMore ; page incomplète → plus rien', async () => {
    const onFetchThreads = vi
      .fn()
      .mockResolvedValueOnce(page(100, 20))
      .mockResolvedValueOnce(page(80, 5));
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    // Curseur = plus petit id affiché.
    expect(onFetchThreads).toHaveBeenLastCalledWith(FORUM, 100, 20);
    expect(result.current.threads).toHaveLength(25);
    expect(result.current.hasMore).toBe(false);
  });

  it('le curseur ignore les optimistes (id négatif) et les doublons ne sont pas réajoutés', async () => {
    const onFetchThreads = vi.fn().mockResolvedValueOnce([post(5), post(3)]);
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.applyIncomingPost(post(-9), null);
    });
    onFetchThreads.mockResolvedValueOnce([post(3), post(2)]);
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(onFetchThreads).toHaveBeenLastCalledWith(FORUM, 3, 20);
    expect(result.current.threads.map((t) => t.id)).toEqual([5, 3, -9, 2]);
  });

  it('aucun sujet réel : pas de curseur (before undefined)', async () => {
    const onFetchThreads = vi.fn().mockResolvedValue([]);
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      result.current.loadMore();
    });
    expect(onFetchThreads).toHaveBeenLastCalledWith(FORUM, undefined, 20);
  });

  it('verrou : un 2e loadMore pendant le premier ne relance pas de requête', async () => {
    const onFetchThreads = vi.fn().mockResolvedValueOnce(page(50, 20));
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const older = deferred<ForumPost[]>();
    onFetchThreads.mockReturnValueOnce(older.promise);
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);
    expect(onFetchThreads).toHaveBeenCalledTimes(2); // initial + un seul loadMore
    await act(async () => {
      older.resolve([post(10)]);
      await older.promise;
    });
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.threads).toHaveLength(21);
  });

  it('échec de loadMore : silencieux (pas de loadError ni error), verrou relâché', async () => {
    const onFetchThreads = vi.fn().mockResolvedValueOnce(page(50, 20));
    const { result } = mount({ onFetchThreads });
    await waitFor(() => expect(result.current.loading).toBe(false));
    onFetchThreads.mockRejectedValueOnce(new Error('net'));
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.loadError).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.threads).toHaveLength(20);
    // Le verrou est relâché : un nouvel essai part bien.
    onFetchThreads.mockResolvedValueOnce([post(1)]);
    await act(async () => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.threads).toHaveLength(21));
  });

  it('sans onFetchThreads : loadMore et reload ne font rien', () => {
    const { result } = mount({ initialThreads: [post(1)] });
    act(() => {
      result.current.loadMore();
      result.current.reload();
    });
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.threads.map((t) => t.id)).toEqual([1]);
  });

  it('démontage pendant le chargement : aucune mise à jour après coup', async () => {
    const initial = deferred<ForumPost[]>();
    const onFetchThreads = vi.fn().mockReturnValue(initial.promise);
    const { result, unmount } = mount({ onFetchThreads });
    expect(result.current.loading).toBe(true);
    unmount();
    await act(async () => {
      initial.resolve([post(1)]);
      await initial.promise;
    });
    // Toujours l'état figé au démontage (pas de setState sur composant démonté).
    expect(result.current.threads).toEqual([]);
    expect(result.current.loading).toBe(true);
  });
});

describe('useForumThreads — loadReplies (compléments)', () => {
  it("un nouvel essai efface l'erreur de branche ; loadingReplies est vrai pendant le fetch", async () => {
    const onFetchReplies = vi.fn().mockRejectedValueOnce(new Error('x'));
    const { result } = mount({
      initialThreads: [post(1, { replies: undefined, replyCount: 1 })],
      onFetchReplies,
    });
    await act(async () => {
      await result.current.loadReplies(1);
    });
    expect(result.current.replyErrors.has(1)).toBe(true);

    const children = deferred<ForumPost[]>();
    onFetchReplies.mockReturnValueOnce(children.promise);
    let pendingCall: Promise<boolean> | undefined;
    act(() => {
      pendingCall = result.current.loadReplies(1);
    });
    expect(result.current.replyErrors.has(1)).toBe(false);
    expect(result.current.loadingReplies.has(1)).toBe(true);
    await act(async () => {
      children.resolve([post(11)]);
      await pendingCall;
    });
    expect(result.current.loadingReplies.has(1)).toBe(false);
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([11]);
  });

  it('sans onFetchReplies : la branche est marquée chargée et vide', async () => {
    const { result } = mount({ initialThreads: [post(1, { replies: undefined, replyCount: 3 })] });
    await act(async () => {
      await result.current.loadReplies(1);
    });
    expect(result.current.threads[0].replies).toEqual([]);
    expect(result.current.threads[0].replyCount).toBe(0);
  });

  it('charge une branche imbriquée (petit-enfant) sans toucher aux autres', async () => {
    const onFetchReplies = vi.fn(async () => [post(111)]);
    const { result } = mount({
      initialThreads: [post(1, { replies: [post(11, { replies: undefined })] }), post(2)],
      onFetchReplies,
    });
    await act(async () => {
      await result.current.loadReplies(11);
    });
    expect(onFetchReplies).toHaveBeenCalledWith(FORUM, 11);
    expect(result.current.threads[0].replies?.[0].replies?.map((r) => r.id)).toEqual([111]);
    expect(result.current.threads[1].replies).toEqual([]);
  });

  it('reload remet à zéro les erreurs de branche', async () => {
    const onFetchThreads = vi.fn(async () => [post(1, { replies: undefined })]);
    const onFetchReplies = vi.fn(async () => {
      throw new Error('x');
    });
    const { result } = mount({ onFetchThreads, onFetchReplies });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.loadReplies(1);
    });
    expect(result.current.replyErrors.has(1)).toBe(true);
    act(() => result.current.reload());
    expect(result.current.replyErrors.size).toBe(0);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('useForumThreads — votes (compléments)', () => {
  it("changer de direction remplace le vote ; succès : le vote reste, pas d'erreur", async () => {
    const onVotePost = vi.fn(async () => undefined);
    const { result } = mount({
      initialThreads: [post(1, { votes: [{ userId: 1, value: 1 }] })],
      onVotePost,
    });
    await act(async () => {
      result.current.vote(1, -1);
    });
    expect(onVotePost).toHaveBeenCalledWith(1, -1);
    expect(result.current.threads[0].votes).toEqual([{ userId: 1, value: -1 }]);
    expect(result.current.error).toBeNull();
  });

  it('rollback : restaure le vote PRÉCÉDENT (pas seulement le retire)', async () => {
    const onVotePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({
      initialThreads: [
        post(1, {
          votes: [
            { userId: 1, value: -1 },
            { userId: 9, value: 1 },
          ],
        }),
      ],
      onVotePost,
    });
    await act(async () => {
      result.current.vote(1, 1);
    });
    expect(result.current.threads[0].votes).toEqual([
      { userId: 1, value: -1 },
      { userId: 9, value: 1 },
    ]);
  });

  it('vote sur une réponse imbriquée', async () => {
    const { result } = mount({ initialThreads: [post(1, { replies: [post(11)] })] });
    await act(async () => {
      result.current.vote(11, 1);
    });
    expect(result.current.threads[0].replies?.[0].votes).toEqual([{ userId: 1, value: 1 }]);
  });

  it('post introuvable : aucun appel serveur', () => {
    const onVotePost = vi.fn();
    const { result } = mount({ initialThreads: [post(1)], onVotePost });
    act(() => result.current.vote(42, 1));
    expect(onVotePost).not.toHaveBeenCalled();
  });

  it("clearError efface l'erreur courante", async () => {
    const onVotePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ initialThreads: [post(1)], onVotePost });
    await act(async () => {
      result.current.vote(1, 1);
    });
    expect(result.current.error).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });
});

describe('useForumThreads — publication (compléments)', () => {
  it('addThread : contenu vide → false, rien publié', async () => {
    const onCreatePost = vi.fn();
    const { result } = mount({ onCreatePost });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addThread('Titre', '   ');
    });
    expect(ok).toBe(false);
    expect(onCreatePost).not.toHaveBeenCalled();
    expect(result.current.threads).toHaveLength(0);
  });

  it("addThread : envoie contenu/titre rognés, parent null et un nonce ; pending pendant l'envoi", async () => {
    const saved = deferred<ForumPost | void>();
    const onCreatePost = vi.fn().mockReturnValue(saved.promise);
    const { result } = mount({ onCreatePost });
    let call: Promise<boolean> | undefined;
    act(() => {
      call = result.current.addThread('  Titre  ', '  Corps  ');
    });
    expect(onCreatePost).toHaveBeenCalledWith(FORUM, 'Corps', null, expect.any(String), 'Titre');
    expect(result.current.pending).toBe(true);
    // Optimiste visible tout de suite, avec un id temporaire négatif.
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].id).toBeLessThan(0);
    expect(result.current.threads[0].title).toBe('Titre');
    await act(async () => {
      saved.resolve(undefined);
      await call;
    });
    expect(result.current.pending).toBe(false);
    // Pas de post renvoyé : l'optimiste reste.
    expect(result.current.threads[0].content).toBe('Corps');
  });

  it('addThread : titre vide → envoyé undefined', async () => {
    const onCreatePost = vi.fn(async () => undefined);
    const { result } = mount({ onCreatePost });
    await act(async () => {
      await result.current.addThread('   ', 'Corps');
    });
    expect(onCreatePost).toHaveBeenCalledWith(FORUM, 'Corps', null, expect.any(String), undefined);
    expect(result.current.threads[0].title).toBeUndefined();
  });

  it('addReply : contenu vide → false', async () => {
    const onCreatePost = vi.fn();
    const { result } = mount({ initialThreads: [post(1)], onCreatePost });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addReply(1, '  ');
    });
    expect(ok).toBe(false);
    expect(onCreatePost).not.toHaveBeenCalled();
  });

  it("addReply : échec → retire l'optimiste et rétablit le compteur", async () => {
    const onCreatePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({
      initialThreads: [post(1, { replies: [post(11)], replyCount: 1 })],
      onCreatePost,
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addReply(1, 'réponse');
    });
    expect(ok).toBe(false);
    expect(onCreatePost).toHaveBeenCalledWith(FORUM, 'réponse', 1, expect.any(String));
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([11]);
    expect(result.current.threads[0].replyCount).toBe(1);
    expect(result.current.error).toBe("La réponse n'a pas pu être publiée. Réessayez.");
    expect(result.current.pending).toBe(false);
  });

  it("addReply sans serveur : l'optimiste reste et le compteur est incrémenté", async () => {
    const { result } = mount({ initialThreads: [post(1, { replies: [], replyCount: 0 })] });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.addReply(1, 'local');
    });
    expect(ok).toBe(true);
    expect(result.current.threads[0].replies?.[0].content).toBe('local');
    expect(result.current.threads[0].replyCount).toBe(1);
  });
});

describe('useForumThreads — édition (compléments)', () => {
  it("rien de changé (contenu + titre identiques) → false, pas d'appel", async () => {
    const onEditPost = vi.fn();
    const { result } = mount({
      initialThreads: [post(1, { content: 'c', title: 'T' })],
      onEditPost,
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.editPost(1, ' c ', ' T ');
    });
    expect(ok).toBe(false);
    expect(onEditPost).not.toHaveBeenCalled();
  });

  it('titre fourni mais vide, contenu vide ou post inconnu → false', async () => {
    const onEditPost = vi.fn();
    const { result } = mount({ initialThreads: [post(1, { title: 'T' })], onEditPost });
    const outcomes: boolean[] = [];
    await act(async () => {
      outcomes.push(await result.current.editPost(1, 'neuf', '  '));
      outcomes.push(await result.current.editPost(1, '  '));
      outcomes.push(await result.current.editPost(404, 'neuf'));
    });
    expect(outcomes).toEqual([false, false, false]);
    expect(onEditPost).not.toHaveBeenCalled();
  });

  it('modifie le seul titre : appel avec le titre rogné', async () => {
    const onEditPost = vi.fn(async () => undefined);
    const { result } = mount({
      initialThreads: [post(1, { content: 'c', title: 'T' })],
      onEditPost,
    });
    await act(async () => {
      await result.current.editPost(1, 'c', ' Nouveau ');
    });
    expect(onEditPost).toHaveBeenCalledWith(1, 'c', 'Nouveau');
    expect(result.current.threads[0].title).toBe('Nouveau');
  });

  it('réponse du serveur fusionnée en préservant les réponses chargées et le compteur', async () => {
    const onEditPost = vi.fn(async () => ({
      ...post(1, { content: 'serveur' }),
      replies: undefined,
      replyCount: undefined,
    }));
    const { result } = mount({
      initialThreads: [post(1, { content: 'avant', replies: [post(11)], replyCount: 1 })],
      onEditPost,
    });
    await act(async () => {
      await result.current.editPost(1, 'après');
    });
    const p = result.current.threads[0];
    expect(p.content).toBe('serveur');
    expect(p.replies?.map((r) => r.id)).toEqual([11]);
    expect(p.replyCount).toBe(1);
  });

  it("échec : rollback du contenu ET du titre, message d'erreur", async () => {
    const onEditPost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({
      initialThreads: [post(1, { content: 'avant', title: 'Ancien' })],
      onEditPost,
    });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.editPost(1, 'après', 'Nouveau');
    });
    expect(ok).toBe(false);
    expect(result.current.threads[0].content).toBe('avant');
    expect(result.current.threads[0].title).toBe('Ancien');
    expect(result.current.error).toBe("La modification n'a pas pu être enregistrée. Réessayez.");
  });
});

describe('useForumThreads — suppression (compléments)', () => {
  it("supprimer une réponse décrémente le compteur du parent ; appel serveur avec l'id", async () => {
    const onDeletePost = vi.fn(async () => undefined);
    const { result } = mount({
      initialThreads: [post(1, { replies: [post(11), post(12)], replyCount: 2 })],
      onDeletePost,
    });
    await act(async () => {
      result.current.deletePost(11);
    });
    expect(onDeletePost).toHaveBeenCalledWith(11);
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([12]);
    expect(result.current.threads[0].replyCount).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('échec sur une réponse : elle revient sous son parent avec le compteur rétabli', async () => {
    const onDeletePost = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({
      initialThreads: [post(1, { replies: [post(11)], replyCount: 1 })],
      onDeletePost,
    });
    await act(async () => {
      result.current.deletePost(11);
    });
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([11]);
    expect(result.current.threads[0].replyCount).toBe(1);
  });

  it('id négatif ou inconnu : aucune suppression', () => {
    const onDeletePost = vi.fn();
    const { result } = mount({ initialThreads: [post(-1), post(1)], onDeletePost });
    act(() => {
      result.current.deletePost(-1);
      result.current.deletePost(99);
    });
    expect(onDeletePost).not.toHaveBeenCalled();
    expect(result.current.threads.map((t) => t.id)).toEqual([-1, 1]);
  });
});

describe('useForumThreads — entrants WebSocket (compléments)', () => {
  it('réponse entrante sous une branche NON chargée : compteur incrémenté, rien inséré', () => {
    const { result } = mount({ initialThreads: [post(1, { replies: undefined, replyCount: 2 })] });
    act(() => result.current.applyIncomingPost(post(11), 1));
    expect(result.current.threads[0].replies).toBeUndefined();
    expect(result.current.threads[0].replyCount).toBe(3);
  });

  it('réponse entrante sous une branche chargée : insérée et compteur incrémenté', () => {
    const { result } = mount({ initialThreads: [post(1, { replies: [post(11)], replyCount: 1 })] });
    act(() => result.current.applyIncomingPost(post(12), 1));
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([11, 12]);
    expect(result.current.threads[0].replyCount).toBe(2);
  });

  it("écho d'un post existant : fusion en préservant ses réponses et son compteur", () => {
    const { result } = mount({
      initialThreads: [post(1, { content: 'a', replies: [post(11)], replyCount: 1 })],
    });
    act(() =>
      result.current.applyIncomingPost(
        { ...post(1, { content: 'b' }), replies: undefined, replyCount: undefined },
        null
      )
    );
    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].content).toBe('b');
    expect(result.current.threads[0].replies?.map((r) => r.id)).toEqual([11]);
    expect(result.current.threads[0].replyCount).toBe(1);
  });

  it("socket : onEdit applique le titre s'il est fourni, le garde sinon", () => {
    const { socket, ref } = fakeSocket();
    const { result } = mount({ initialThreads: [post(1, { title: 'T' })], socket });
    act(() => ref.handlers!.onEdit(1, 'contenu', 'Nouveau titre'));
    expect(result.current.threads[0].title).toBe('Nouveau titre');
    act(() => ref.handlers!.onEdit(1, 'contenu 2', null));
    expect(result.current.threads[0].title).toBe('Nouveau titre');
    expect(result.current.threads[0].content).toBe('contenu 2');
  });

  it("socket : onDelete d'une réponse imbriquée décrémente son parent", () => {
    const { socket, ref } = fakeSocket();
    const { result } = mount({
      initialThreads: [post(1, { replies: [post(11, { replies: [post(111)], replyCount: 1 })] })],
      socket,
    });
    act(() => ref.handlers!.onDelete(111));
    const child = result.current.threads[0].replies![0];
    expect(child.replies).toEqual([]);
    expect(child.replyCount).toBe(0);
  });

  it("socket : onUserUpdate met à jour l'auteur sur les racines ET les réponses imbriquées", () => {
    const { socket, ref } = fakeSocket();
    const other: ForumAuthor = { ...user, id: 2, username: 'rosie', firstName: 'Rosie' };
    const { result } = mount({
      initialThreads: [
        post(1, { replies: [post(11, { replies: [post(111)] }), post(12, { author: other })] }),
      ],
      socket,
    });
    act(() =>
      ref.handlers!.onUserUpdate!({
        id: 1,
        username: 'jeanne',
        firstName: 'Jeanne',
        lastName: 'X',
        avatarColor: '#abcdef',
      })
    );
    const root = result.current.threads[0];
    expect(root.author.firstName).toBe('Jeanne');
    expect(root.replies![0].replies![0].author).toMatchObject({
      username: 'jeanne',
      lastName: 'X',
      avatarColor: '#abcdef',
    });
    // L'auteur d'un autre utilisateur n'est pas touché.
    expect(root.replies![1].author.firstName).toBe('Rosie');
  });
});
