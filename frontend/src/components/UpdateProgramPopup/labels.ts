import type { UpdateProgramPopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: UpdateProgramPopupLabels = {
  title: 'Modifier le programme',
  subtitle: 'Mets à jour les informations du programme.',
  colorLabel: 'Couleur du programme',
  addColorLabel: 'Ajouter une couleur',
  codeLabel: 'Code du programme',
  codePlaceholder: 'Ex. GIN',
  codeTaken: 'Ce code existe déjà dans cet établissement',
  nameLabel: 'Nom du programme',
  namePlaceholder: 'Ex. Génie informatique',
  cohortLabel: 'Cohorte',
  cohortPlaceholder: 'Ex. Promo 71',
  cancel: 'Annuler',
  save: 'Enregistrer',
  errorTitle: 'Une erreur est survenue',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};

/** Couleurs prédéfinies par défaut (identiques à AddSubscriptionPopup ; tokens --avatar-* d'index.css). */
export const DEFAULT_PALETTE = ['#0D9488', '#14B8A6', '#2DD4BF', '#0F766E', '#7D7D94'];

/** Longueurs max alignées sur la table Program : name, code et cohort en VARCHAR(128). */
export const FIELD_MAX_LENGTH = 128;
