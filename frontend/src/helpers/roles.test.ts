import { describe, it, expect } from 'vitest';
import { ROLE } from './roles';

/**
 * La constante ROLE est la source unique des noms de rôle côté front.
 * Ces valeurs DOIVENT rester alignées avec init.sql / RoleNames.java :
 * un changement ici est intentionnel et doit être revu.
 */
describe('ROLE', () => {
  it('expose exactement les trois rôles connus', () => {
    expect(Object.keys(ROLE).sort()).toEqual(['ADMIN', 'GUARDIAN', 'TEACHER']);
  });

  it('TEACHER vaut "Enseignant"', () => {
    expect(ROLE.TEACHER).toBe('Enseignant');
  });

  it('ADMIN vaut "Administrateur"', () => {
    expect(ROLE.ADMIN).toBe('Administrateur');
  });

  it('GUARDIAN vaut "Gardien"', () => {
    expect(ROLE.GUARDIAN).toBe('Gardien');
  });

  it('les valeurs sont distinctes', () => {
    const values = Object.values(ROLE);
    expect(new Set(values).size).toBe(values.length);
  });

  it('toutes les valeurs sont des chaînes non vides', () => {
    for (const v of Object.values(ROLE)) {
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
