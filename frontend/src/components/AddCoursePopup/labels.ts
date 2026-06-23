import type { AddCoursePopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: AddCoursePopupLabels = {
  title: 'Ajouter un cours',
  subtitle: 'Ajoute ce cours à un ou plusieurs programmes',
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
  save: 'Sauvegarder',
  errorTitle: 'Une erreur est survenue',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};

/** Longueur max du code du cours (alignée sur la table Course). */
export const CODE_MAX_LENGTH = 128;

/** Longueur max du titre du cours (alignée sur la table Course). */
export const NAME_MAX_LENGTH = 128;
