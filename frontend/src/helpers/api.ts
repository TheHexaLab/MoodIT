import { getToken, clearToken } from './auth';
import { type User } from '../types/domain';

export interface RegisterPayload {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface RegisterResponse {
  message: string;
}

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers as HeadersInit);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(input, { ...init, headers });

  if (res.status === 401) {
    clearToken();
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }

  return res;
}

/**
 * Profil de l'utilisateur connecté (GET /api/me). L'identité vient du JWT côté
 * gateway ; aucune donnée n'est passée en paramètre. Le gateway route /api/** vers
 * core-service. Un 401 est géré par apiFetch (purge du token + redirection /login).
 */
export async function getMe(): Promise<User> {
  const res = await apiFetch('/api/me');

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || `Erreur ${res.status}`);
  }

  return res.json();
}

/** Champs de profil modifiables par l'utilisateur via PATCH /api/me. */
export interface UpdateMePayload {
  firstName: string;
  lastName: string;
  avatarColor: string;
}

/**
 * Met à jour le profil de l'utilisateur connecté (PATCH /api/me) et renvoie le
 * profil à jour. La photo (multipart) n'est pas encore gérée côté backend.
 */
export async function updateMe(payload: UpdateMePayload): Promise<User> {
  const res = await apiFetch('/api/me', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || `Erreur ${res.status}`);
  }

  return res.json();
}

export async function register(payload: RegisterPayload): Promise<RegisterResponse> {
  const res = await fetch('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || `Erreur ${res.status}`);
  }

  return res.json();
}

export async function login(payload: { email: string; password: string }): Promise<AuthResponse> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || `Erreur ${res.status}`);
  }

  // Le token n'est PAS sauvegardé ici : login ne renvoie pas encore de token
  // (2FA requise). Le token est sauvegardé après /auth/verify-2fa.
  return res.json();
}

export async function verifyEmail(email: string, code: string): Promise<{ message: string }> {
  const res = await fetch('/auth/verify-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || 'Code invalide');
  }

  return res.json();
}

export async function verify2FA(email: string, code: string): Promise<AuthResponse> {
  const res = await fetch('/auth/verify-2fa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || 'Code invalide');
  }

  return res.json();
}

export async function resendCode(email: string, mode: string): Promise<{ message: string }> {
  const res = await fetch('/auth/resend-code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, mode }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || 'Impossible de renvoyer le code');
  }

  return res.json();
}
