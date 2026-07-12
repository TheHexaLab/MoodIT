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
