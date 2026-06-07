import type { EditProfilePopupLabels } from './types.ts';

/** Tous les textes par défaut affichés par le composant. */
export const defaultLabels: EditProfilePopupLabels = {
  title: 'Modifier le profil',
  subtitle: 'Personnalise ton avatar et tes informations.',
  avatarLabel: 'Avatar',
  paletteLabel: 'Couleur de la pastille',
  addColorLabel: 'Ajouter une couleur',
  removePhoto: 'Retirer la photo',
  firstNameLabel: 'Prénom',
  firstNamePlaceholder: 'Ex. Marie',
  lastNameLabel: 'Nom',
  lastNamePlaceholder: 'Ex. Tremblay',
  cancel: 'Annuler',
  save: 'Enregistrer',
  errorTitle: 'Une erreur est survenue',
  saveError: "Échec de l'enregistrement. Réessaie.",
  errorClose: 'Fermer',
};

/** Couleurs prédéfinies par défaut (cf. tokens --avatar-* dans index.css). */
export const DEFAULT_PALETTE = ['#0D9488', '#14B8A6', '#2DD4BF', '#0F766E', '#7D7D94'];

/** Longueurs max alignées sur la table User_ : first_name et last_name en VARCHAR(128). */
export const NAME_MAX_LENGTH = 128;
