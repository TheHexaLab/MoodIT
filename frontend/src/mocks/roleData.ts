import type { Role, User } from '../components/RoleEditorPopup/RoleEditorPopup.tsx';

/**
 * Mock « API-ready » pour le RoleEditorPopup (gestion des rôles d'un programme).
 * Reproduit la forme attendue (table Role + User_ avec leurs assignations).
 * Les membres et leurs rôles VARIENT par programme (déterministe sur `programId`)
 * pour simuler un vrai GET par programme. À remplacer par les vrais GET le jour
 * du branchement (rôles globaux + membres/assignations d'un programme précis).
 */

/** Rôles éditables (ids alignés sur init.sql ; ordre = ordre d'affichage). */
const roles: Role[] = [
  { id: 4, name: 'Administrateur' },
  { id: 2, name: 'Enseignant' },
  { id: 3, name: 'Auxiliaire' },
];

/** Vivier d'utilisateurs (sans rôle ici : l'assignation est dérivée par programme). */
const userPool: Omit<User, 'role_ids'>[] = [
  { id: 1, username: 'jeandubois', firstName: 'Jean', lastName: 'Dubois', email: 'jeandubois@usherbrooke.ca', avatarColor: '#0a5cc0' },
  { id: 2, username: 'tremblaymar', firstName: 'Marie', lastName: 'Tremblay', email: 'tremblaymar@usherbrooke.ca', avatarColor: '#f6c350' },
  { id: 3, username: 'gagnonjp', firstName: 'Jean-Philippe', lastName: 'Gagnon', email: 'gagnonjp@usherbrooke.ca', avatarColor: '#1a6e3c' },
  { id: 4, username: 'roygenev', firstName: 'Geneviève', lastName: 'Roy', email: 'roygenev@usherbrooke.ca', avatarColor: '#7a4e1a' },
  { id: 5, username: 'lavoiesam', firstName: 'Samuel', lastName: 'Lavoie', email: 'lavoiesam@usherbrooke.ca', avatarColor: '#3a3a7a' },
  { id: 6, username: 'bouchardalx', firstName: 'Alexandre', lastName: 'Bouchard', email: 'bouchardalx@usherbrooke.ca', avatarColor: '#0a7a6e' },
  { id: 7, username: 'fortinemi', firstName: 'Émilie', lastName: 'Fortin', email: 'fortinemi@usherbrooke.ca', avatarColor: '#4a7a1a' },
  { id: 8, username: 'morinclar', firstName: 'Clara', lastName: 'Morin', email: 'morinclar@usherbrooke.ca', avatarColor: '#5eead4' },
  { id: 9, username: 'girardtho', firstName: 'Thomas', lastName: 'Girard', email: 'girardtho@usherbrooke.ca', avatarColor: '#9333ea' },
  { id: 10, username: 'pelletierni', firstName: 'Nicolas', lastName: 'Pelletier', email: 'pelletierni@usherbrooke.ca', avatarColor: '#8b1a1a' },
  { id: 11, username: 'belangerju', firstName: 'Julie', lastName: 'Bélanger', email: 'belangerju@usherbrooke.ca', avatarColor: '#0891b2' },
  { id: 12, username: 'cotemax', firstName: 'Maxime', lastName: 'Côté', email: 'cotemax@usherbrooke.ca', avatarColor: '#b45309' },
  { id: 13, username: 'lemieuxaud', firstName: 'Audrey', lastName: 'Lemieux', email: 'lemieuxaud@usherbrooke.ca', avatarColor: '#be185d' },
  { id: 14, username: 'simardphi', firstName: 'Philippe', lastName: 'Simard', email: 'simardphi@usherbrooke.ca', avatarColor: '#15803d' },
  { id: 15, username: 'caronlea', firstName: 'Léa', lastName: 'Caron', email: 'caronlea@usherbrooke.ca', avatarColor: '#1d4ed8' },
  { id: 16, username: 'dufoursop', firstName: 'Sophie', lastName: 'Dufour', email: 'dufoursop@usherbrooke.ca', avatarColor: '#c2410c' },
];

/** Rôle dérivé d'un membre selon sa position dans le programme (déterministe). */
function roleForSlot(slot: number): number[] {
  switch (slot % 4) {
    case 0:
      return [4]; // Administrateur
    case 1:
      return [2]; // Enseignant
    case 2:
      return [3]; // Auxiliaire
    default:
      return []; // aucun rôle (candidat à l'ajout dans n'importe quelle section)
  }
}

/** GET rôles éditables (globaux). */
export function getProgramRoles(): Role[] {
  return roles;
}

/**
 * GET membres (avec rôles) d'un programme. Sous-ensemble + assignations dérivés
 * de `programId` : deux programmes affichent des membres / sections différents.
 */
export function getProgramUsers(programId: number): User[] {
  const safeId = Math.max(0, programId);
  const size = 6 + (safeId % 4); // 6 à 9 membres
  const start = (safeId * 3) % userPool.length;
  return Array.from({ length: size }, (_, i) => {
    const member = userPool[(start + i) % userPool.length];
    return { ...member, role_ids: roleForSlot(i + safeId) };
  });
}
