import { describe, it, expect, beforeEach } from 'vitest';
import { clearToken } from './auth';

const TOKEN_KEY = 'moodit_token';

/**
 * Depuis la migration cookie HttpOnly, le JWT n'est plus lu ni écrit par le JS :
 * `auth.ts` n'expose plus que `clearToken`, qui purge un éventuel token résiduel
 * en localStorage (sessions d'avant la migration). On vide le storage avant chaque
 * test pour l'isolation (localStorage fourni par jsdom).
 */
describe('clearToken (purge du token localStorage résiduel)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('supprime un token résiduel sous la clé moodit_token', () => {
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
  });
});
