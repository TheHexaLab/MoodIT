import { describe, it, expect } from 'vitest';
import { getProgramPermissions } from './permissions';
import { ROLE } from './roles';
import type { Program } from '../types/domain';

/**
 * Tests exhaustifs de la dérivation des permissions par rôle.
 * Matrice complète : { rôle programme } × { isGlobalAdmin } → 4 droits.
 */

// Fabrique un Program minimal portant un roleName donné.
function programWithRole(roleName: Program['roleName']): Program {
  return {
    id: 1,
    name: 'P',
    code: 'C',
    cohort: '2026',
    color: '#123456',
    roleName,
  };
}

const ALL_FALSE = {
  canManageContent: false,
  canEditProgram: false,
  canManageRoles: false,
  canDeleteProgram: false,
};

const ALL_TRUE = {
  canManageContent: true,
  canEditProgram: true,
  canManageRoles: true,
  canDeleteProgram: true,
};

describe('getProgramPermissions', () => {
  describe('Administrateur GLOBAL (isGlobalAdmin=true)', () => {
    it('accorde TOUT, y compris la suppression, quel que soit le rôle programme (null)', () => {
      expect(getProgramPermissions(programWithRole(null), true)).toEqual(ALL_TRUE);
    });

    it('accorde tout même sans programme (null)', () => {
      expect(getProgramPermissions(null, true)).toEqual(ALL_TRUE);
    });

    it('accorde tout même sans programme (undefined)', () => {
      expect(getProgramPermissions(undefined, true)).toEqual(ALL_TRUE);
    });

    it('accorde tout si aussi Administrateur programme', () => {
      expect(getProgramPermissions(programWithRole(ROLE.ADMIN), true)).toEqual(ALL_TRUE);
    });

    it('accorde tout si aussi Enseignant programme', () => {
      expect(getProgramPermissions(programWithRole(ROLE.TEACHER), true)).toEqual(ALL_TRUE);
    });
  });

  describe('Administrateur de PROGRAMME (isGlobalAdmin=false, roleName=Administrateur)', () => {
    const perms = getProgramPermissions(programWithRole(ROLE.ADMIN), false);

    it('peut gérer le contenu', () => {
      expect(perms.canManageContent).toBe(true);
    });
    it('peut modifier le programme', () => {
      expect(perms.canEditProgram).toBe(true);
    });
    it('peut gérer les rôles', () => {
      expect(perms.canManageRoles).toBe(true);
    });
    it('ne peut PAS supprimer le programme (réservé au global)', () => {
      expect(perms.canDeleteProgram).toBe(false);
    });
    it('correspond à la matrice attendue', () => {
      expect(perms).toEqual({
        canManageContent: true,
        canEditProgram: true,
        canManageRoles: true,
        canDeleteProgram: false,
      });
    });
  });

  describe('Enseignant de PROGRAMME (isGlobalAdmin=false, roleName=Enseignant)', () => {
    const perms = getProgramPermissions(programWithRole(ROLE.TEACHER), false);

    it('peut gérer le contenu', () => {
      expect(perms.canManageContent).toBe(true);
    });
    it('ne peut PAS modifier le programme', () => {
      expect(perms.canEditProgram).toBe(false);
    });
    it('ne peut PAS gérer les rôles', () => {
      expect(perms.canManageRoles).toBe(false);
    });
    it('ne peut PAS supprimer le programme', () => {
      expect(perms.canDeleteProgram).toBe(false);
    });
    it('correspond à la matrice attendue', () => {
      expect(perms).toEqual({
        canManageContent: true,
        canEditProgram: false,
        canManageRoles: false,
        canDeleteProgram: false,
      });
    });
  });

  describe('Aucun rôle (isGlobalAdmin=false)', () => {
    it('roleName=null → aucune permission', () => {
      expect(getProgramPermissions(programWithRole(null), false)).toEqual(ALL_FALSE);
    });

    it('programme absent (null) → aucune permission', () => {
      expect(getProgramPermissions(null, false)).toEqual(ALL_FALSE);
    });

    it('programme absent (undefined) → aucune permission', () => {
      expect(getProgramPermissions(undefined, false)).toEqual(ALL_FALSE);
    });

    it('roleName absent du programme → aucune permission', () => {
      const p = programWithRole(undefined);
      expect(getProgramPermissions(p, false)).toEqual(ALL_FALSE);
    });
  });

  describe('Rôle INCONNU (non Administrateur/Enseignant)', () => {
    it("un rôle non reconnu (ex. 'Étudiant') n'accorde aucune permission", () => {
      const p = { ...programWithRole(null), roleName: 'Étudiant' } as unknown as Program;
      expect(getProgramPermissions(p, false)).toEqual(ALL_FALSE);
    });

    it("le rôle Gardien dans un programme n'est pas un rôle programme → aucune permission", () => {
      const p = { ...programWithRole(null), roleName: ROLE.GUARDIAN } as unknown as Program;
      expect(getProgramPermissions(p, false)).toEqual(ALL_FALSE);
    });

    it("chaîne vide n'accorde aucune permission", () => {
      const p = { ...programWithRole(null), roleName: '' } as unknown as Program;
      expect(getProgramPermissions(p, false)).toEqual(ALL_FALSE);
    });
  });

  it('retourne toujours les quatre clés booléennes', () => {
    const perms = getProgramPermissions(null, false);
    expect(Object.keys(perms).sort()).toEqual([
      'canDeleteProgram',
      'canEditProgram',
      'canManageContent',
      'canManageRoles',
    ]);
    for (const v of Object.values(perms)) {
      expect(typeof v).toBe('boolean');
    }
  });
});
