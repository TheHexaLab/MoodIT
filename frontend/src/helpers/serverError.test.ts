import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyServerError, publicServerError } from './serverError';

/**
 * classifyServerError : mappe un message serveur vers un champ de formulaire par mots-clés.
 * Ordre de priorité : username > email > password > null (global).
 */
describe('classifyServerError', () => {
  describe('→ username (mot-clé "utilisateur")', () => {
    it('détecte "utilisateur"', () => {
      expect(classifyServerError('Cet utilisateur existe déjà')).toBe('username');
    });
    it('insensible à la casse', () => {
      expect(classifyServerError('UTILISATEUR invalide')).toBe('username');
    });
    it('a priorité sur email si les deux mots présents', () => {
      expect(classifyServerError("utilisateur ou email invalide")).toBe('username');
    });
  });

  describe('→ email (mots-clés e-mail/email/adresse/domaine/courriel/vérifié)', () => {
    it('détecte "e-mail"', () => {
      expect(classifyServerError('E-mail déjà utilisé')).toBe('email');
    });
    it('détecte "email"', () => {
      expect(classifyServerError('email invalide')).toBe('email');
    });
    it('détecte "adresse"', () => {
      expect(classifyServerError('Adresse non reconnue')).toBe('email');
    });
    it('détecte "domaine"', () => {
      expect(classifyServerError('Le domaine est interdit')).toBe('email');
    });
    it('détecte "courriel"', () => {
      expect(classifyServerError('Courriel introuvable')).toBe('email');
    });
    it('détecte "vérifié"', () => {
      expect(classifyServerError('Compte non vérifié')).toBe('email');
    });
    it('insensible à la casse', () => {
      expect(classifyServerError('ADRESSE inconnue')).toBe('email');
    });
    it('a priorité sur password', () => {
      expect(classifyServerError('email et mot de passe requis')).toBe('email');
    });
  });

  describe('→ password (mot-clé "mot de passe")', () => {
    it('détecte "mot de passe"', () => {
      expect(classifyServerError('Mot de passe trop court')).toBe('password');
    });
    it('insensible à la casse', () => {
      expect(classifyServerError('MOT DE PASSE incorrect')).toBe('password');
    });
  });

  describe('→ null (message général)', () => {
    it('message sans mot-clé connu', () => {
      expect(classifyServerError('Erreur interne du serveur')).toBeNull();
    });
    it('chaîne vide', () => {
      expect(classifyServerError('')).toBeNull();
    });
    it('mot proche mais non exact ("passe" seul sans "mot de")', () => {
      expect(classifyServerError('Le délai est passé')).toBeNull();
    });
  });
});

/**
 * publicServerError : en PROD masque le détail technique, sinon renvoie le message brut.
 * import.meta.env.PROD vaut false sous Vitest ; la branche PROD est forcée via vi.stubEnv.
 */
describe('publicServerError', () => {
  it('en dev (PROD=false) renvoie le message brut', () => {
    expect(publicServerError('Erreur 403 Forbidden')).toBe('Erreur 403 Forbidden');
  });

  it('en dev renvoie même une chaîne vide telle quelle', () => {
    expect(publicServerError('')).toBe('');
  });

  it('confirme que import.meta.env.PROD est falsy sous Vitest', () => {
    expect(import.meta.env.PROD).toBeFalsy();
  });

  // Branche PROD : on force la variable d'environnement le temps du test.
  describe('en production (PROD=true)', () => {
    beforeEach(() => {
      vi.stubEnv('PROD', true);
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('masque le détail technique derrière un message générique', () => {
      expect(publicServerError('Erreur 403 Forbidden')).toBe(
        'Une erreur est survenue. Veuillez réessayer plus tard.'
      );
    });

    it('n’influence pas classifyServerError (le mapping par champ reste actif)', () => {
      expect(classifyServerError('Mot de passe incorrect')).toBe('password');
    });
  });
});
