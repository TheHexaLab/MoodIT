import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useChannelMessages } from './useChannelMessages';
import type { ChannelMessage } from '../../../types/domain';
import type { ChannelMessageAuthor } from '../../CourseChannelList/CourseChannelList';
import type { IncomingMessageHandlers, ChannelSocket } from './useChannelMessages';

afterEach(cleanup);

const user: ChannelMessageAuthor = {
  id: 1,
  username: 'jean',
  firstName: 'Jean',
  lastName: 'D.',
  avatarColor: '#123456',
};
const other: ChannelMessageAuthor = { ...user, id: 2, username: 'marie', firstName: 'Marie' };

function msg(id: number, content = `m${id}`, at = 1000 + id, author = user): ChannelMessage {
  return { id, content, createdAt: new Date(at).toISOString(), author };
}

const CHANNEL = 7;

function mount(overrides: Partial<Parameters<typeof useChannelMessages>[0]> = {}) {
  return renderHook(() =>
    useChannelMessages({
      channelId: CHANNEL,
      initialMessages: [],
      currentUser: user,
      ...overrides,
    })
  );
}

describe('useChannelMessages — chargement', () => {
  it('charge la page initiale et trie chronologiquement', async () => {
    const onFetchMessages = vi.fn(async () => [msg(2, 'b', 2000), msg(1, 'a', 1000)]);
    const { result } = mount({ onFetchMessages });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onFetchMessages).toHaveBeenCalledWith(CHANNEL, undefined, 30);
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(result.current.loadError).toBeNull();
  });

  it('positionne loadError si le fetch rejette', async () => {
    const onFetchMessages = vi.fn(async () => {
      throw new Error('x');
    });
    const { result } = mount({ onFetchMessages });
    await waitFor(() =>
      expect(result.current.loadError).toBe('Impossible de charger les messages. Réessayez.')
    );
    expect(result.current.loading).toBe(false);
  });

  it('reload relance le fetch', async () => {
    const onFetchMessages = vi.fn(async () => [msg(1)]);
    const { result } = mount({ onFetchMessages });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.reload());
    await waitFor(() => expect(onFetchMessages).toHaveBeenCalledTimes(2));
  });

  it('hasMore true si la page est pleine (>= 30)', async () => {
    const full = Array.from({ length: 30 }, (_, i) => msg(i + 1));
    const onFetchMessages = vi.fn(async () => full);
    const { result } = mount({ onFetchMessages });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  it('sans fetch : reste sur initialMessages, loading false', async () => {
    const { result } = mount({ initialMessages: [msg(3), msg(1)] });
    expect(result.current.loading).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 3]);
  });
});

describe('useChannelMessages — loadOlder', () => {
  it('fusionne les plus anciens sans doublon, curseur = plus petit id positif', async () => {
    const onFetchMessages = vi
      .fn()
      .mockResolvedValueOnce([msg(10), msg(11)]) // page initiale
      .mockResolvedValueOnce([msg(5), msg(10)]); // plus anciens (10 en doublon)
    const { result } = mount({ onFetchMessages });
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.loadingOlder).toBe(false));
    expect(onFetchMessages).toHaveBeenNthCalledWith(2, CHANNEL, 10, 30);
    expect(result.current.messages.map((m) => m.id)).toEqual([5, 10, 11]);
  });
});

describe('useChannelMessages — actions optimistes', () => {
  it('sendMessage insère un optimiste puis réconcilie via clientMsgId', async () => {
    let capturedClientId = '';
    const onSendMessage = vi.fn(async (_c: number, content: string, _p, clientId: string) => {
      capturedClientId = clientId;
      return { id: 99, content, createdAt: new Date(5000).toISOString(), author: user, clientMsgId: clientId };
    });
    const { result } = mount({ onSendMessage });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.sendMessage('Salut', null);
    });
    expect(ok).toBe(true);
    // l'optimiste a été remplacé par l'id serveur 99
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(99);
    expect(onSendMessage).toHaveBeenCalledWith(CHANNEL, 'Salut', null, capturedClientId);
    expect(result.current.pending).toBe(false);
  });

  it('sendMessage ignore un contenu vide', async () => {
    const { result } = mount();
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.sendMessage('   ', null);
    });
    expect(ok).toBe(false);
    expect(result.current.messages).toHaveLength(0);
  });

  it('sendMessage rollback + erreur si le POST échoue', async () => {
    const onSendMessage = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ onSendMessage });
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.sendMessage('Coucou', null);
    });
    expect(ok).toBe(false);
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.error).toBe("Le message n'a pas pu être envoyé. Réessayez.");
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('editMessage applique le contenu de façon optimiste', async () => {
    const onEditMessage = vi.fn(async () => undefined);
    const { result } = mount({ initialMessages: [msg(1, 'avant')], onEditMessage });
    await act(async () => {
      result.current.editMessage(1, 'après');
      await Promise.resolve();
    });
    expect(result.current.messages[0].content).toBe('après');
    expect(onEditMessage).toHaveBeenCalledWith(1, 'après');
  });

  it('editMessage bloque un id temporaire négatif', async () => {
    const onEditMessage = vi.fn(async () => undefined);
    const { result } = mount({ initialMessages: [msg(-1, 'x')], onEditMessage });
    act(() => result.current.editMessage(-1, 'y'));
    expect(onEditMessage).not.toHaveBeenCalled();
    expect(result.current.messages[0].content).toBe('x');
  });

  it('deleteMessage retire optimiste puis rollback si échec', async () => {
    const onDeleteMessage = vi.fn(async () => {
      throw new Error('net');
    });
    const { result } = mount({ initialMessages: [msg(1)], onDeleteMessage });
    await act(async () => {
      result.current.deleteMessage(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    // rollback : le message est réinséré
    expect(result.current.messages.map((m) => m.id)).toEqual([1]);
    expect(result.current.error).toBe("Le message n'a pas pu être supprimé. Réessayez.");
  });
});

describe('useChannelMessages — entrants WebSocket', () => {
  it('applyIncomingMessage insère un nouveau message', () => {
    const { result } = mount({ initialMessages: [msg(1, 'a', 1000)] });
    act(() => result.current.applyIncomingMessage(msg(2, 'b', 2000, other)));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
  });

  it('applyIncomingMessage dédup/réconcilie via clientMsgId', () => {
    const optimistic: ChannelMessage = { ...msg(-1, 'a', 1000), clientMsgId: 'nonce-x' };
    const { result } = mount({ initialMessages: [optimistic] });
    const echo: ChannelMessage = { ...msg(50, 'a', 1000), clientMsgId: 'nonce-x' };
    act(() => result.current.applyIncomingMessage(echo));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(50);
  });

  it('applyIncomingEdit et applyIncomingDelete mettent à jour la liste', () => {
    const { result } = mount({ initialMessages: [msg(1, 'a'), msg(2, 'b')] });
    act(() => result.current.applyIncomingEdit(1, 'edité'));
    expect(result.current.messages.find((m) => m.id === 1)?.content).toBe('edité');
    act(() => result.current.applyIncomingDelete(2));
    expect(result.current.messages.map((m) => m.id)).toEqual([1]);
  });

  it('branche les handlers du socket et se désabonne au démontage', () => {
    const unsubscribe = vi.fn();
    let handlers: IncomingMessageHandlers | null = null;
    const socket: ChannelSocket = {
      subscribe: vi.fn((_id, h) => {
        handlers = h;
        return unsubscribe;
      }),
    };
    const { result, unmount } = mount({ initialMessages: [msg(1, 'a', 1000)], socket });
    expect(socket.subscribe).toHaveBeenCalledWith(CHANNEL, expect.any(Object));
    // Un message poussé par le socket arrive dans la liste.
    act(() => handlers!.onMessage(msg(2, 'b', 2000, other)));
    expect(result.current.messages.map((m) => m.id)).toEqual([1, 2]);
    // onUserUpdate met à jour l'auteur.
    act(() => handlers!.onUserUpdate!({ id: 1, username: 'jj', firstName: 'JJ', lastName: 'X', avatarColor: '#fff' }));
    expect(result.current.messages.find((m) => m.id === 1)?.author.firstName).toBe('JJ');
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
