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
  { id: 1, username: 'jeandubois', first_name: 'Jean', last_name: 'Dubois', email: 'jeandubois@usherbrooke.ca', avatar_color: '#0a5cc0' },
  { id: 2, username: 'tremblaymar', first_name: 'Marie', last_name: 'Tremblay', email: 'tremblaymar@usherbrooke.ca', avatar_color: '#f6c350' },
  { id: 3, username: 'gagnonjp', first_name: 'Jean-Philippe', last_name: 'Gagnon', email: 'gagnonjp@usherbrooke.ca', avatar_color: '#1a6e3c' },
  { id: 4, username: 'roygenev', first_name: 'Geneviève', last_name: 'Roy', email: 'roygenev@usherbrooke.ca', avatar_color: '#7a4e1a' },
  { id: 5, username: 'lavoiesam', first_name: 'Samuel', last_name: 'Lavoie', email: 'lavoiesam@usherbrooke.ca', avatar_color: '#3a3a7a' },
  { id: 6, username: 'bouchardalx', first_name: 'Alexandre', last_name: 'Bouchard', email: 'bouchardalx@usherbrooke.ca', avatar_color: '#0a7a6e' },
  { id: 7, username: 'fortinemi', first_name: 'Émilie', last_name: 'Fortin', email: 'fortinemi@usherbrooke.ca', avatar_color: '#4a7a1a' },
  { id: 8, username: 'morinclar', first_name: 'Clara', last_name: 'Morin', email: 'morinclar@usherbrooke.ca', avatar_color: '#5eead4' },
  { id: 9, username: 'girardtho', first_name: 'Thomas', last_name: 'Girard', email: 'girardtho@usherbrooke.ca', avatar_color: '#9333ea' },
  { id: 10, username: 'pelletierni', first_name: 'Nicolas', last_name: 'Pelletier', email: 'pelletierni@usherbrooke.ca', avatar_color: '#8b1a1a' },
  { id: 11, username: 'belangerju', first_name: 'Julie', last_name: 'Bélanger', email: 'belangerju@usherbrooke.ca', avatar_color: '#0891b2' },
  { id: 12, username: 'cotemax', first_name: 'Maxime', last_name: 'Côté', email: 'cotemax@usherbrooke.ca', avatar_color: '#b45309' },
  { id: 13, username: 'lemieuxaud', first_name: 'Audrey', last_name: 'Lemieux', email: 'lemieuxaud@usherbrooke.ca', avatar_color: '#be185d' },
  { id: 14, username: 'simardphi', first_name: 'Philippe', last_name: 'Simard', email: 'simardphi@usherbrooke.ca', avatar_color: '#15803d' },
  { id: 15, username: 'caronlea', first_name: 'Léa', last_name: 'Caron', email: 'caronlea@usherbrooke.ca', avatar_color: '#1d4ed8' },
  { id: 16, username: 'dufoursop', first_name: 'Sophie', last_name: 'Dufour', email: 'dufoursop@usherbrooke.ca', avatar_color: '#c2410c' },
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
