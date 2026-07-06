/**
 * Permissions FRONT (cosmétiques) dérivées du rôle de l'utilisateur DANS un programme.
 *
 * ⚠️ Gating d'INTERFACE uniquement : le backend ne re-vérifie PAS ces droits. Le but est de
 * masquer/afficher les actions selon le rôle, pas de sécuriser (choix assumé : rapidité).
 *
 * Sources de rôle :
 *  - `Program.roleName` (User_Program_Role) : rôle DANS le programme — 'Administrateur' |
 *    'Enseignant' | null.
 *  - `isGlobalAdmin` (User_Role) : super-admin PLATEFORME — seul habilité à SUPPRIMER un programme.
 *
 * Règles (cf. demande produit) :
 *  - Administrateur GLOBAL : tout, y compris supprimer le programme.
 *  - Administrateur (programme) : tout DANS le programme SAUF le supprimer (peut le modifier,
 *    gérer les rôles des membres).
 *  - Enseignant (programme) : gère le CONTENU (cours, canaux, quiz, forums), mais ne touche
 *    NI au programme (modification / suppression) NI aux rôles des membres.
 *  - aucun rôle : aucune action d'administration.
 */
import { type Program } from '../types/domain.ts';

export interface ProgramPermissions {
  /** Gérer le contenu : cours, canaux, quiz, forums. */
  canManageContent: boolean;
  /** Modifier le programme lui-même (nom, code, couleur…). */
  canEditProgram: boolean;
  /** Gérer les rôles des membres du programme (réservé aux administrateurs, PAS aux enseignants). */
  canManageRoles: boolean;
  /** Supprimer le programme (super-admin plateforme uniquement). */
  canDeleteProgram: boolean;
}

export function getProgramPermissions(
  program: Program | null | undefined,
  isGlobalAdmin: boolean
): ProgramPermissions {
  const role = program?.roleName ?? null;
  const isProgramAdmin = role === 'Administrateur';
  const isTeacher = role === 'Enseignant';

  return {
    canManageContent: isGlobalAdmin || isProgramAdmin || isTeacher,
    canEditProgram: isGlobalAdmin || isProgramAdmin,
    canManageRoles: isGlobalAdmin || isProgramAdmin,
    canDeleteProgram: isGlobalAdmin,
  };
}
