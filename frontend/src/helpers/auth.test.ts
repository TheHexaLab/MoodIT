import { describe, it, expect, beforeEach } from 'vitest';
import { saveToken, getToken, clearToken, isAuthenticated } from './auth';

const TOKEN_KEY = 'moodit_token';

/**
 * Gestion du token dans localStorage (fourni par jsdom).
 * On vide le storage avant chaque test pour l'isolation.
 */
describe('auth token helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('getToken', () => {
    it('renvoie null quand aucun token stocké', () => {
      expect(getToken()).toBeNull();
    });

    it('renvoie le token stocké', () => {
      localStorage.setItem(TOKEN_KEY, 'abc123');
      expect(getToken()).toBe('abc123');
    });
  });

  describe('saveToken', () => {
    it('écrit le token sous la bonne clé', () => {
      saveToken('xyz');
      expect(localStorage.getItem(TOKEN_KEY)).toBe('xyz');
      expect(getToken()).toBe('xyz');
    });

    it('écrase un token existant', () => {
      saveToken('first');
      saveToken('second');
      expect(getToken()).toBe('second');
    });

    it('accepte une chaîne vide', () => {
      saveToken('');
      expect(localStorage.getItem(TOKEN_KEY)).toBe('');
    });
  });

  describe('clearToken', () => {
    it('supprime un token existant', () => {
      saveToken('abc');
      clearToken();
      expect(getToken()).toBeNull();
    });

    it('est idempotent (aucune erreur si rien à supprimer)', () => {
      expect(() => clearToken()).not.toThrow();
      expect(getToken()).toBeNull();
    });

    it('ne touche pas aux autres clés', () => {
      localStorage.setItem('autre', 'valeur');
      saveToken('abc');
      clearToken();
      expect(localStorage.getItem('autre')).toBe('valeur');
    });
  });

  describe('isAuthenticated', () => {
    it('false quand aucun token', () => {
      expect(isAuthenticated()).toBe(false);
    });

    it('true quand un token est présent', () => {
      saveToken('abc');
      expect(isAuthenticated()).toBe(true);
    });

    it('true même pour une chaîne vide (getToken() !== null)', () => {
      saveToken('');
      expect(isAuthenticated()).toBe(true);
    });

    it('false après clearToken', () => {
      saveToken('abc');
      clearToken();
      expect(isAuthenticated()).toBe(false);
    });
  });

  describe('cycle complet', () => {
    it('save → get → clear → get', () => {
      expect(getToken()).toBeNull();
      saveToken('token-1');
      expect(getToken()).toBe('token-1');
      expect(isAuthenticated()).toBe(true);
      clearToken();
      expect(getToken()).toBeNull();
      expect(isAuthenticated()).toBe(false);
    });
  });
});
