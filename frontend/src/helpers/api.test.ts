import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from './api';

/**
 * Tests de la couche réseau bas niveau (apiFetch : wrapper de fetch).
 * fetch est mocké via vi.stubGlobal ; le token vient du localStorage (helpers/auth).
 * Couvre : injection du header Authorization, absence de token, transmission de init,
 * et la gestion du 401 (purge du token + redirection /login).
 */

const TOKEN_KEY = 'moodit_token';

/** Fabrique une Response factice minimale. */
function fakeResponse(init: Partial<Response> = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: (init as { json?: () => Promise<unknown> }).json ?? (async () => ({})),
    ...init,
  } as Response;
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse()));
    localStorage.clear();
    // Repartir d'un pathname connu (jsdom) sans déclencher de navigation réelle.
    window.history.pushState({}, '', '/dashboard');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('appelle fetch avec l’URL fournie', async () => {
    await apiFetch('/api/thing');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/thing');
  });

  it('ajoute le header Authorization Bearer quand un token est présent', async () => {
    localStorage.setItem(TOKEN_KEY, 'abc123');
    await apiFetch('/api/thing');
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer abc123');
  });

  it('n’ajoute PAS le header Authorization en l’absence de token', async () => {
    await apiFetch('/api/thing');
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });

  it('conserve les headers fournis dans init et y ajoute le token', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    await apiFetch('/api/thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(init.method).toBe('POST');
  });

  it('retourne la Response telle quelle (200)', async () => {
    const res = await apiFetch('/api/thing');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('retourne une réponse d’erreur non-401 sans purge ni redirection', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 500 })
    );
    const res = await apiFetch('/api/thing');
    expect(res.status).toBe(500);
    // Token conservé, pas de redirection.
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok');
  });

  it('sur 401 : purge le token et redirige vers /login', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    const assignSpy = vi.fn();
    // window.location.href n’est pas assignable en jsdom : on remplace l’objet location.
    Object.defineProperty(window, 'location', {
      value: { pathname: '/dashboard', set href(v: string) { assignSpy(v); } },
      writable: true,
      configurable: true,
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 401 })
    );

    await apiFetch('/api/thing');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('sur 401 déjà sur /login : purge le token sans rediriger', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok');
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { pathname: '/login', set href(v: string) { assignSpy(v); } },
      writable: true,
      configurable: true,
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      fakeResponse({ ok: false, status: 401 })
    );

    await apiFetch('/api/thing');

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
