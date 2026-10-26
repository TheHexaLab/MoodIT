import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';

// --- Mocks des dépendances externes du provider ------------------------------
// helpers/api : appels réseau (GET /api/me, PUT settings, PATCH me).
const getMe = vi.fn();
const updateMe = vi.fn();
const updateMeSettings = vi.fn();
vi.mock('../helpers/api.ts', () => ({
  getMe: (...a: unknown[]) => getMe(...a),
  updateMe: (...a: unknown[]) => updateMe(...a),
  updateMeSettings: (...a: unknown[]) => updateMeSettings(...a),
}));

// helpers/auth : présence d'un token (pilote 'checking' vs 'unauthed').
const getToken = vi.fn();
vi.mock('../helpers/auth.ts', () => ({
  getToken: () => getToken(),
}));

import CurrentUserProvider from './CurrentUserProvider';
import { useCurrentUser } from './currentUserContext';
import ThemeProvider from './ThemeProvider';

// matchMedia requis par ThemeProvider (monté autour du provider testé).
function stubMatchMedia() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

// Consommateur : expose l'identité + les drapeaux de droits + l'état d'auth.
function Consumer() {
  const { currentUser, status, profileLoading, isAdmin, isGuardian } = useCurrentUser();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="loading">{String(profileLoading)}</span>
      <span data-testid="username">{currentUser.username}</span>
      <span data-testid="id">{String(currentUser.id)}</span>
      <span data-testid="admin">{String(isAdmin)}</span>
      <span data-testid="guardian">{String(isGuardian)}</span>
    </div>
  );
}

function renderProvider(children: ReactNode = <Consumer />) {
  return render(
    <ThemeProvider>
      <CurrentUserProvider>{children}</CurrentUserProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.clearAllMocks();
  updateMeSettings.mockResolvedValue(undefined);
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CurrentUserProvider', () => {
  it('sans session : part en checking, interroge /api/me, puis unauthed sur échec', async () => {
    // Le token est dans un cookie HttpOnly invisible au JS : on ne peut plus décider
    // localement. Le provider part toujours en 'checking' et laisse GET /api/me trancher.
    getMe.mockRejectedValue(new Error('401'));
    renderProvider();

    expect(screen.getByTestId('status').textContent).toBe('checking');
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthed'));
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('cookie HttpOnly illisible : part en checking et appelle /api/me pour trancher', async () => {
    // Le JS ne peut pas lire le cookie moodit_token → on démarre toujours en 'checking'
    // et c'est le succès/échec de GET /api/me qui décide (plus de court-circuit sur token).
    getMe.mockResolvedValue({
      id: 1,
      username: 'u',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
    });
    renderProvider();

    expect(screen.getByTestId('status').textContent).toBe('checking');
    expect(screen.getByTestId('loading').textContent).toBe('true');
    await waitFor(() => expect(getMe).toHaveBeenCalledTimes(1));
  });

  it('avec token : part en checking puis passe à authed avec le profil', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 42,
      username: 'alice',
      firstName: 'A',
      lastName: 'L',
      avatarColor: '#000',
    });

    renderProvider();
    // Rendu initial : token présent → checking / profileLoading true.
    expect(screen.getByTestId('status').textContent).toBe('checking');
    expect(screen.getByTestId('loading').textContent).toBe('true');

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    expect(screen.getByTestId('username').textContent).toBe('alice');
    expect(screen.getByTestId('id').textContent).toBe('42');
    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it('mémorise moodit_user_id au succès', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 7,
      username: 'bob',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    expect(localStorage.getItem('moodit_user_id')).toBe('7');
  });

  it('réaligne le thème sur les settings BD reçus', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 1,
      username: 'u',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
      settings: JSON.stringify({ theme: 'dark' }),
    });

    renderProvider();
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    );
  });

  it('échec /api/me : status unauthed', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockRejectedValue(new Error('401'));

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unauthed'));
    expect(screen.getByTestId('username').textContent).toBe('');
  });

  it('dérive isAdmin pour le rôle Administrateur', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 1,
      username: 'admin',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
      roles: [{ name: 'Administrateur' }],
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    expect(screen.getByTestId('admin').textContent).toBe('true');
    expect(screen.getByTestId('guardian').textContent).toBe('false');
  });

  it('le rôle Gardien implique isAdmin ET isGuardian', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 1,
      username: 'g',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
      roles: [{ name: 'Gardien' }],
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    expect(screen.getByTestId('admin').textContent).toBe('true');
    expect(screen.getByTestId('guardian').textContent).toBe('true');
  });

  it('sans rôle : ni admin ni gardien', async () => {
    getToken.mockReturnValue('tok');
    getMe.mockResolvedValue({
      id: 1,
      username: 'plain',
      firstName: '',
      lastName: '',
      avatarColor: '#000',
    });

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    expect(screen.getByTestId('admin').textContent).toBe('false');
    expect(screen.getByTestId('guardian').textContent).toBe('false');
  });

  it('useCurrentUser hors provider lève une erreur explicite', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/CurrentUserProvider/);
    spy.mockRestore();
  });
});

// --- Actions exposées par le contexte (settings, profil, rôles) ---------------

// Consommateur « pilote » : capture l'API du contexte pour l'appeler depuis le test.
let api: ReturnType<typeof useCurrentUser> | null = null;
function Driver() {
  const ctx = useCurrentUser();
  useEffect(() => {
    api = ctx;
  });
  return (
    <div>
      <span data-testid="status">{ctx.status}</span>
      <span data-testid="settings">{ctx.currentUser.settings ?? ''}</span>
      <span data-testid="first">{ctx.currentUser.firstName}</span>
      <span data-testid="color">{ctx.currentUser.avatarColor}</span>
      <span data-testid="admin">{String(ctx.isAdmin)}</span>
      <span data-testid="guardian">{String(ctx.isGuardian)}</span>
      <span data-testid="theme-setting">{ctx.settings.theme ?? ''}</span>
    </div>
  );
}

function ctxApi() {
  if (!api) throw new Error('contexte non capturé');
  return api;
}

const baseUser = {
  id: 3,
  username: 'carol',
  firstName: 'Carol',
  lastName: 'C',
  avatarColor: '#111111',
};

async function renderAuthed(user: Record<string, unknown> = baseUser) {
  getMe.mockResolvedValue(user);
  const utils = renderProvider(<Driver />);
  await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
  return utils;
}

function settingsBlob() {
  return JSON.parse(screen.getByTestId('settings').textContent ?? '{}');
}

describe('CurrentUserProvider — saveSettings (debounce)', () => {
  afterEach(() => {
    vi.useRealTimers();
    api = null;
  });

  it('applique la mise à jour optimiste puis n’émet qu’un seul PUT fusionné après 1 s', async () => {
    await renderAuthed({ ...baseUser, settings: JSON.stringify({ theme: 'light' }) });
    vi.useFakeTimers();

    act(() => ctxApi().saveSettings({ location: { programId: 1 } }));
    act(() => ctxApi().saveSettings({ location: { programId: 2, courseId: 9 } }));

    // Optimiste : le blob local reflète immédiatement la fusion (thème conservé).
    expect(settingsBlob()).toEqual({ theme: 'light', location: { programId: 2, courseId: 9 } });
    // Pas encore d'appel réseau pendant la rafale.
    act(() => vi.advanceTimersByTime(999));
    expect(updateMeSettings).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(updateMeSettings).toHaveBeenCalledTimes(1);
    expect(updateMeSettings).toHaveBeenCalledWith({
      theme: 'light',
      location: { programId: 2, courseId: 9 },
    });
  });

  it('un échec du PUT est ignoré silencieusement (settings locaux conservés)', async () => {
    await renderAuthed();
    updateMeSettings.mockRejectedValue(new Error('500'));
    vi.useFakeTimers();

    act(() => ctxApi().saveSettings({ theme: 'dark' }));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(updateMeSettings).toHaveBeenCalledWith({ theme: 'dark' });
    expect(screen.getByTestId('theme-setting').textContent).toBe('dark');
  });

  it('pagehide envoie immédiatement la sauvegarde en attente avec keepalive', async () => {
    await renderAuthed();
    vi.useFakeTimers();

    act(() => ctxApi().saveSettings({ theme: 'dark' }));
    fireEvent(window, new Event('pagehide'));

    expect(updateMeSettings).toHaveBeenCalledTimes(1);
    expect(updateMeSettings).toHaveBeenCalledWith({ theme: 'dark' }, { keepalive: true });
    // Le debounce est annulé : aucun second PUT à l'échéance.
    act(() => vi.advanceTimersByTime(2000));
    expect(updateMeSettings).toHaveBeenCalledTimes(1);
  });

  it('un échec du PUT keepalive est ignoré silencieusement', async () => {
    await renderAuthed();
    updateMeSettings.mockRejectedValue(new Error('500'));
    act(() => ctxApi().saveSettings({ theme: 'dark' }));
    await act(async () => {
      fireEvent(window, new Event('pagehide'));
    });
    expect(updateMeSettings).toHaveBeenCalledWith({ theme: 'dark' }, { keepalive: true });
    expect(screen.getByTestId('theme-setting').textContent).toBe('dark');
  });

  it('pagehide sans sauvegarde en attente n’émet rien', async () => {
    await renderAuthed();
    fireEvent(window, new Event('pagehide'));
    expect(updateMeSettings).not.toHaveBeenCalled();
  });

  it('visibilitychange : flush seulement quand la page passe en arrière-plan', async () => {
    await renderAuthed();
    vi.useFakeTimers();
    act(() => ctxApi().saveSettings({ theme: 'light' }));

    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    fireEvent(document, new Event('visibilitychange'));
    expect(updateMeSettings).not.toHaveBeenCalled();

    visibility.mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(updateMeSettings).toHaveBeenCalledWith({ theme: 'light' }, { keepalive: true });
    visibility.mockRestore();
  });

  it('le démontage annule la sauvegarde debouncée et retire les écouteurs', async () => {
    const { unmount } = await renderAuthed();
    vi.useFakeTimers();
    act(() => ctxApi().saveSettings({ theme: 'dark' }));
    unmount();

    act(() => vi.advanceTimersByTime(2000));
    fireEvent(window, new Event('pagehide'));
    expect(updateMeSettings).not.toHaveBeenCalled();
  });
});

describe('CurrentUserProvider — saveProfile et applyGlobalRoles', () => {
  afterEach(() => {
    vi.useRealTimers();
    api = null;
  });

  it('saveProfile envoie prénom/nom/couleur et applique la réponse en préservant les settings locaux', async () => {
    await renderAuthed({ ...baseUser, settings: JSON.stringify({ theme: 'light' }) });
    // Settings modifiés localement (debounce pas encore échu).
    act(() => ctxApi().saveSettings({ theme: 'dark' }));
    updateMe.mockResolvedValue({
      ...baseUser,
      firstName: 'Caroline',
      avatarColor: '#222222',
      settings: JSON.stringify({ theme: 'light' }), // instantané BD plus ancien
    });

    await act(async () => {
      await ctxApi().saveProfile({
        firstName: 'Caroline',
        lastName: 'C',
        avatarColor: '#222222',
        photo: null,
      } as never);
    });

    expect(updateMe).toHaveBeenCalledWith({
      firstName: 'Caroline',
      lastName: 'C',
      avatarColor: '#222222',
    });
    expect(screen.getByTestId('first').textContent).toBe('Caroline');
    expect(screen.getByTestId('color').textContent).toBe('#222222');
    expect(settingsBlob()).toEqual({ theme: 'dark' });
  });

  it('saveProfile propage l’échec de PATCH /api/me sans modifier le profil', async () => {
    await renderAuthed();
    updateMe.mockRejectedValue(new Error('400'));

    let error: unknown;
    await act(async () => {
      try {
        await ctxApi().saveProfile({
          firstName: 'X',
          lastName: 'Y',
          avatarColor: '#000000',
        } as never);
      } catch (e) {
        error = e;
      }
    });
    expect((error as Error).message).toBe('400');
    expect(screen.getByTestId('first').textContent).toBe('Carol');
  });

  it('applyGlobalRoles re-dérive isAdmin / isGuardian en direct', async () => {
    await renderAuthed();
    expect(screen.getByTestId('admin').textContent).toBe('false');

    act(() => ctxApi().applyGlobalRoles([{ name: 'Gardien' }] as never));
    expect(screen.getByTestId('admin').textContent).toBe('true');
    expect(screen.getByTestId('guardian').textContent).toBe('true');

    act(() => ctxApi().applyGlobalRoles([{ name: 'Administrateur' }] as never));
    expect(screen.getByTestId('admin').textContent).toBe('true');
    expect(screen.getByTestId('guardian').textContent).toBe('false');

    act(() => ctxApi().applyGlobalRoles([]));
    expect(screen.getByTestId('admin').textContent).toBe('false');
  });

  it('ignore la réponse de /api/me arrivée après le démontage', async () => {
    let resolve: (u: unknown) => void = () => {};
    getMe.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderProvider(<Driver />);
    unmount();
    await act(async () => resolve({ ...baseUser, id: 99 }));
    expect(localStorage.getItem('moodit_user_id')).toBeNull();
  });
});

// Un enfant qui enregistre dès que le profil est chargé, dans son propre useEffect : React
// exécute les effets des enfants AVANT celui du fournisseur. La fusion doit quand même partir
// des réglages du profil (sinon le thème enregistré était effacé par le PUT).
describe('CurrentUserProvider — enregistrement juste après le chargement du profil', () => {
  function EarlySaver() {
    const { status, saveSettings } = useCurrentUser();
    useEffect(() => {
      if (status === 'authed') saveSettings({ location: { programId: 5 } });
    }, [status, saveSettings]);
    return null;
  }

  it('la fusion conserve les réglages du profil (thème) et le PUT les envoie tous', async () => {
    getMe.mockResolvedValue({ ...baseUser, settings: JSON.stringify({ theme: 'light' }) });
    renderProvider(
      <>
        <EarlySaver />
        <Driver />
      </>
    );
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('authed'));
    // L'enregistrement de l'enfant a lieu dans SON useEffect, qui peut passer après l'affichage
    // de « authed » : on attend qu'il soit appliqué, puis on vérifie que rien n'a été perdu.
    await waitFor(() => expect(settingsBlob().location).toEqual({ programId: 5 }));
    expect(settingsBlob()).toEqual({ theme: 'light', location: { programId: 5 } });
    await waitFor(() => expect(updateMeSettings).toHaveBeenCalled(), { timeout: 2500 });
    expect(updateMeSettings).toHaveBeenLastCalledWith({ theme: 'light', location: { programId: 5 } });
  });
});
