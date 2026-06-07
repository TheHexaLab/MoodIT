import type { UpdateCoursePopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: UpdateCoursePopupLabels = {
  title: 'Modifier le cours',
  subtitle: 'Mets à jour le cours et ses programmes',
  programsLabel: 'Programmes',
  programsPlaceholder: 'Sélectionner des programmes',
  searchPlaceholder: 'Rechercher un programme…',
  noCandidates: 'Aucun programme disponible',
  noResults: 'Aucun résultat',
  codeLabel: 'Code du cours',
  codePlaceholder: 'Ex. GIF201',
  titleLabel: 'Titre du cours',
  titlePlaceholder: 'Ex. Structures de données',
  cancel: 'Annuler',
  save: 'Enregistrer',
  errorTitle: 'Une erreur est survenue',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};

/** Longueur max du code du cours (alignée sur la table Course). */
export const CODE_MAX_LENGTH = 128;

/** Longueur max du titre du cours (alignée sur la table Course). */
export const NAME_MAX_LENGTH = 128;
