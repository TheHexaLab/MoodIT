import type {
  CreateEstablishment,
  Establishment,
  JoinEstablishment,
  Program as CatalogProgram,
} from '../components/AddSubscriptionPopup/AddSubscriptionPopup.tsx';

/**
 * Mock « API-ready » pour le AddSubscriptionPopup (création / adhésion à un
 * programme). Reproduit la forme des données backend attendues par les trois
 * loaders du popup. À remplacer par de vrais GET le jour du branchement.
 */

/** Établissements (aligné sur init.sql). */
export const establishments: Establishment[] = [
  { id: 1, name: 'Université de Sherbrooke' },
  { id: 2, name: 'Université Laval' },
  { id: 3, name: 'Polytechnique Montréal' },
  { id: 4, name: 'Université de Montréal' },
  { id: 5, name: 'Université McGill' },
  { id: 6, name: 'Université Concordia' },
  { id: 7, name: 'Université du Québec à Montréal' },
  { id: 8, name: 'Université du Québec à Trois-Rivières' },
  { id: 9, name: 'Université du Québec à Chicoutimi' },
  { id: 10, name: 'Université du Québec en Outaouais' },
  { id: 11, name: 'École de technologie supérieure' },
  { id: 12, name: 'HEC Montréal' },
];

/** Catalogue des programmes rattachés aux établissements (vue « rejoindre »). */
export const catalogPrograms: CatalogProgram[] = [
  { id: 1, name: 'Génie informatique', code: 'GIN', cohort: 'Promo 71', color: '#1a6e3c', establishment_id: 1 },
  { id: 2, name: 'Génie logiciel', code: 'GLO', cohort: 'Promo 71', color: '#0a5cc0', establishment_id: 1 },
  { id: 3, name: 'Génie électrique', code: 'GEL', cohort: 'Promo 71', color: '#8b1a1a', establishment_id: 1 },
  { id: 4, name: 'Génie mécanique', code: 'GMC', cohort: 'Promo 71', color: '#7a4e1a', establishment_id: 1 },
  { id: 5, name: 'Génie civil', code: 'GCI', cohort: 'Promo 71', color: '#3a3a7a', establishment_id: 1 },
  { id: 6, name: 'Génie chimique', code: 'GCH', cohort: 'Promo 71', color: '#4a7a1a', establishment_id: 1 },
  { id: 7, name: "Génie de l'environnement", code: 'GEN', cohort: 'Promo 2024', color: '#0a7a6e', establishment_id: 1 },
  { id: 8, name: 'Génie biotechnologique', code: 'GBT', cohort: 'Promo 2024', color: '#9333ea', establishment_id: 1 },
  { id: 9, name: 'Génie robotique', code: 'GRO', cohort: 'Promo 2025', color: '#0891b2', establishment_id: 1 },
  { id: 10, name: 'Génie aérospatial', code: 'GAE', cohort: 'Promo 71', color: '#b45309', establishment_id: 1 },
  { id: 11, name: 'Génie physique', code: 'GPH', cohort: 'Promo 71', color: '#be185d', establishment_id: 2 },
  { id: 12, name: 'Génie des matériaux', code: 'GMA', cohort: 'Promo 2024', color: '#15803d', establishment_id: 2 },
  { id: 13, name: 'Génie industriel', code: 'GIA', cohort: 'Promo 71', color: '#1d4ed8', establishment_id: 3 },
  { id: 14, name: 'Génie alimentaire', code: 'GAL', cohort: 'Promo 2025', color: '#c2410c', establishment_id: 3 },
];

/** GET établissements + codes de leurs programmes (vue « créer », unicité du code). */
export function getCreateEstablishments(): CreateEstablishment[] {
  return establishments.map((e) => ({
    ...e,
    programCodes: catalogPrograms.filter((p) => p.establishment_id === e.id).map((p) => p.code),
  }));
}

/** GET établissements + leur nombre de programmes (vue « rejoindre », étape 1). */
export function getJoinEstablishments(): JoinEstablishment[] {
  return establishments.map((e) => ({
    ...e,
    programCount: catalogPrograms.filter((p) => p.establishment_id === e.id).length,
  }));
}

/** GET programmes d'un établissement (vue « rejoindre », étape 2). */
export function getEstablishmentPrograms(establishment_id: number): CatalogProgram[] {
  return catalogPrograms.filter((p) => p.establishment_id === establishment_id);
}
