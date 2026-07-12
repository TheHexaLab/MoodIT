import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

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
  it('sans token : status unauthed immédiat, aucun appel /api/me', async () => {
    getToken.mockReturnValue(null);
    renderProvider();

    expect(screen.getByTestId('status').textContent).toBe('unauthed');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(getMe).not.toHaveBeenCalled();
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
