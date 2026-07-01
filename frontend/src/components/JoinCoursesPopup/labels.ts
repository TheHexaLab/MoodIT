import type { JoinCoursesPopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: JoinCoursesPopupLabels = {
  title: 'Rejoindre des cours',
  subtitle: (programName) => `Sélectionne les cours de « ${programName} » à rejoindre.`,
  searchPlaceholder: 'Rechercher un cours…',
  noCourses: 'Aucun cours à rejoindre dans ce programme',
  noResults: 'Aucun résultat',
  cancel: 'Annuler',
  join: 'Rejoindre',
  loadError: 'Échec du chargement des cours. Réessaie.',
  retry: 'Réessayer',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorTitle: 'Une erreur est survenue',
  errorClose: 'Fermer',
};
