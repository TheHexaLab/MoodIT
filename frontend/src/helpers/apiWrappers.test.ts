import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMe,
  updateMe,
  updateMeSettings,
  register,
  login,
  verifyEmail,
  verify2FA,
  forgotPassword,
  resetPassword,
  resendCode,
} from './api';

/**
 * Tests des wrappers d'API de helpers/api.ts (apiFetch lui-même est testé dans api.test.ts).
 * fetch est mocké via vi.stubGlobal. On vérifie l'URL, la méthode, le corps, les credentials,
 * le renvoi du corps JSON, et les trois chemins d'erreur : message serveur, corps JSON sans
 * message (repli), corps non JSON (repli « Erreur <statut> »).
 */

const TOKEN_KEY = 'moodit_token';

/** Réponse JSON factice (corps lisible). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** Réponse d'erreur dont le corps n'est pas du JSON (json() rejette). */
function nonJsonError(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token');
    },
  } as unknown as Response;
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

/** URL + init du n-ième appel à fetch. */
function fetchCall(n = 0): [string, RequestInit] {
  return fetchMock().mock.calls[n] as [string, RequestInit];
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('getMe', () => {
  it('GET /api/me avec le cookie et renvoie le profil', async () => {
    const user = { id: 3, username: 'karine' };
    fetchMock().mockResolvedValueOnce(jsonResponse(user));
    const out = await getMe();
    const [url, init] = fetchCall();
    expect(url).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(init.method).toBeUndefined();
    expect(out).toEqual(user);
  });

  it('propage le message d’erreur du serveur', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'Profil introuvable' }, 404));
    await expect(getMe()).rejects.toThrow('Profil introuvable');
  });

  it('retombe sur « Erreur <statut> » si le corps n’est pas du JSON', async () => {
    fetchMock().mockResolvedValueOnce(nonJsonError(503));
    await expect(getMe()).rejects.toThrow('Erreur 503');
  });

  it('retombe sur « Erreur <statut> » si le corps JSON n’a pas de message', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(getMe()).rejects.toThrow('Erreur 500');
  });
});

describe('updateMe', () => {
  const payload = { firstName: 'Karine', lastName: 'Roussel', avatarColor: '#123456' };

  it('PATCH /api/me avec le corps JSON et renvoie le profil à jour', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ id: 3, ...payload }));
    const out = await updateMe(payload);
    const [url, init] = fetchCall();
    expect(url).toBe('/api/me');
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(out).toEqual({ id: 3, ...payload });
  });

  it('throw avec le message serveur en cas d’échec', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'Couleur invalide' }, 400));
    await expect(updateMe(payload)).rejects.toThrow('Couleur invalide');
  });

  it('throw « Erreur <statut> » si le corps n’est pas du JSON', async () => {
    fetchMock().mockResolvedValueOnce(nonJsonError(502));
    await expect(updateMe(payload)).rejects.toThrow('Erreur 502');
  });

  it('throw « Erreur <statut> » si le corps JSON n’a pas de message', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 422));
    await expect(updateMe(payload)).rejects.toThrow('Erreur 422');
  });
});

describe('updateMeSettings', () => {
  it('PUT /api/me/settings avec le blob sérialisé, sans keepalive par défaut', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ id: 3 }));
    const settings = { theme: 'dark' as const, location: { programId: 2, courseId: 5 } };
    const out = await updateMeSettings(settings);
    const [url, init] = fetchCall();
    expect(url).toBe('/api/me/settings');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(settings);
    expect(init.keepalive).toBeUndefined();
    expect(out).toEqual({ id: 3 });
  });

  it('transmet keepalive:true quand demandé (flush au déchargement)', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ id: 3 }));
    await updateMeSettings({ theme: 'light' }, { keepalive: true });
    expect(fetchCall()[1].keepalive).toBe(true);
  });

  it('throw avec le message serveur en cas d’échec', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'Blob trop gros' }, 413));
    await expect(updateMeSettings({})).rejects.toThrow('Blob trop gros');
  });

  it('throw « Erreur <statut> » si le corps n’est pas du JSON', async () => {
    fetchMock().mockResolvedValueOnce(nonJsonError(500));
    await expect(updateMeSettings({})).rejects.toThrow('Erreur 500');
  });

  it('throw « Erreur <statut> » si le corps JSON n’a pas de message', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 400));
    await expect(updateMeSettings({})).rejects.toThrow('Erreur 400');
  });
});

// Endpoints /auth/* : appel direct à fetch (pas apiFetch), POST JSON + credentials.
// Colonnes : nom, appel, URL attendue, corps attendu, message de repli (corps sans message).
type AuthCase = [
  string,
  () => Promise<unknown>,
  string,
  Record<string, unknown>,
  (status: number) => string,
];

const EMAIL = 'k@usherbrooke.ca';

const authCases: AuthCase[] = [
  [
    'register',
    () =>
      register({
        username: 'rk',
        firstName: 'Karine',
        lastName: 'Roussel',
        email: EMAIL,
        password: 'Secret123!',
      }),
    '/auth/register',
    {
      username: 'rk',
      firstName: 'Karine',
      lastName: 'Roussel',
      email: EMAIL,
      password: 'Secret123!',
    },
    (s) => `Erreur ${s}`,
  ],
  [
    'login',
    () => login({ email: EMAIL, password: 'pw' }),
    '/auth/login',
    { email: EMAIL, password: 'pw' },
    (s) => `Erreur ${s}`,
  ],
  [
    'verifyEmail',
    () => verifyEmail(EMAIL, '123456'),
    '/auth/verify-email',
    { email: EMAIL, code: '123456' },
    () => 'Code invalide',
  ],
  [
    'verify2FA',
    () => verify2FA(EMAIL, '654321'),
    '/auth/verify-2fa',
    { email: EMAIL, code: '654321' },
    () => 'Code invalide',
  ],
  [
    'forgotPassword',
    () => forgotPassword(EMAIL),
    '/auth/forgot-password',
    { email: EMAIL },
    (s) => `Erreur ${s}`,
  ],
  [
    'resetPassword',
    () => resetPassword(EMAIL, '111222', 'Nouveau1!'),
    '/auth/reset-password',
    { email: EMAIL, code: '111222', newPassword: 'Nouveau1!' },
    (s) => `Erreur ${s}`,
  ],
  [
    'resendCode',
    () => resendCode(EMAIL, '2fa'),
    '/auth/resend-code',
    { email: EMAIL, mode: '2fa' },
    () => 'Impossible de renvoyer le code',
  ],
];

describe.each(authCases)('%s', (_name, call, url, body, fallback) => {
  it(`POST ${url} en JSON avec credentials:"include" et renvoie le corps`, async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'ok', username: 'rk' }));
    const out = await call();
    const [calledUrl, init] = fetchCall();
    expect(calledUrl).toBe(url);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(out).toEqual({ message: 'ok', username: 'rk' });
  });

  it('propage le message d’erreur renvoyé par le serveur', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'Refus serveur' }, 400));
    await expect(call()).rejects.toThrow('Refus serveur');
  });

  it('utilise le message de repli si le corps d’erreur n’a pas de message', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(call()).rejects.toThrow(fallback(429));
  });

  it('lit « Erreur <statut> » si le corps d’erreur n’est pas du JSON', async () => {
    fetchMock().mockResolvedValueOnce(nonJsonError(500));
    await expect(call()).rejects.toThrow('Erreur 500');
  });

  it('n’intercepte pas un 401 (appel hors apiFetch : pas de purge du token résiduel)', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    fetchMock().mockResolvedValueOnce(jsonResponse({ message: 'Identifiants invalides' }, 401));
    await expect(call()).rejects.toThrow('Identifiants invalides');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok');
  });
});
