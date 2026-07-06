import type { AddSubscriptionPopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: AddSubscriptionPopupLabels = {
  title: 'Ajouter un programme',
  subtitle: 'Crée ton propre programme ou rejoins-en un existant.',
  createTitle: 'Créer un programme',
  createSubtitle: 'Configure un nouveau programme',
  joinTitle: 'Rejoindre un programme',
  joinSubtitle: "Sélectionne les programmes qui t'intéressent",
  manageEstablishmentsTitle: 'Gérer les établissements',
  manageEstablishmentsSubtitle: 'Ajouter, modifier ou supprimer des établissements',
  joinSearchSubtitle: 'Recherche et sélectionne ton établissement.',
  joinProgramsSubtitle: 'Sélectionne un ou plusieurs programmes à rejoindre.',
  programSearchPlaceholder: 'Rechercher un programme…',
  noPrograms: 'Aucun programme pour cet établissement',
  programCount: (count) =>
    count === 0 ? 'Aucun programme' : `${count} programme${count > 1 ? 's' : ''}`,
  add: 'Enregister',
  back: 'Retour',
  colorLabel: 'Couleur du programme',
  addColorLabel: 'Ajouter une couleur',
  establishmentLabel: 'Établissement',
  establishmentPlaceholder: 'Sélectionner un établissement',
  searchPlaceholder: 'Rechercher un établissement…',
  noEstablishments: 'Aucun établissement disponible',
  noResults: 'Aucun résultat',
  codeLabel: 'Code du programme',
  codePlaceholder: 'Ex. GIN',
  codeTaken: 'Ce code existe déjà dans cet établissement',
  nameLabel: 'Nom du programme',
  namePlaceholder: 'Ex. Génie informatique',
  cohortLabel: 'Cohorte',
  cohortPlaceholder: 'Ex. Promo 71',
  cancel: 'Annuler',
  submit: 'Créer',
  errorTitle: 'Une erreur est survenue',
  loadError: 'Échec du chargement. Vérifie ta connexion et réessaie.',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};

/** Couleurs prédéfinies par défaut (identiques à EditProfilePopup ; tokens --avatar-* d'index.css). */
export const DEFAULT_PALETTE = ['#0D9488', '#14B8A6', '#2DD4BF', '#0F766E', '#7D7D94'];

/** Couleur par défaut = première de la palette (comme le popup de profil). */
export const DEFAULT_COLOR = DEFAULT_PALETTE[0];

/** Longueurs max alignées sur la table Program : name, code et cohort en VARCHAR(128). */
export const FIELD_MAX_LENGTH = 128;
