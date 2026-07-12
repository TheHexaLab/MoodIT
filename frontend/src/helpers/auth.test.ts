import { describe, it, expect, beforeEach } from 'vitest';
import { clearToken } from './auth';

const TOKEN_KEY = 'moodit_token';

/**
 * Depuis la migration cookie (JWT dans un cookie HttpOnly, invisible au JS), auth.ts
 * n'expose plus que `clearToken()` : il purge un éventuel token RÉSIDUEL en localStorage
 * (anciennes sessions d'avant la migration). Il ne lit/écrit plus de token.
 */
describe('clearToken', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('supprime le token résiduel en localStorage', () => {
    localStorage.setItem(TOKEN_KEY, 'abc');
    clearToken();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('est idempotent (aucune erreur si rien à supprimer)', () => {
    expect(() => clearToken()).not.toThrow();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('ne touche pas aux autres clés', () => {
    localStorage.setItem('autre', 'valeur');
    localStorage.setItem(TOKEN_KEY, 'abc');
    clearToken();
    expect(localStorage.getItem('autre')).toBe('valeur');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});
