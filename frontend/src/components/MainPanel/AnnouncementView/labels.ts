/** Textes du canal d'annonces ; surchargeables via la prop `labels`. */
export const defaultAnnouncementLabels = {
  newAnnouncement: 'Nouvelle annonce',
  loading: 'Chargement des annonces…',
  loadError: 'Impossible de charger les annonces.',
  retry: 'Réessayer',
  emptyTitle: 'Aucune annonce pour le moment',
  emptyStaff: 'Publiez une annonce : elle apparaîtra en haut pour tous les membres du cours.',
  emptyStudent: 'Les annonces du personnel du cours apparaîtront ici.',
  expires: 'Expire le',
  noExpiry: 'Sans expiration',
  expired: 'Expirée',
  edit: "Modifier l'annonce",
  delete: "Supprimer l'annonce",
  deleteTitle: "Supprimer l'annonce",
  deleteContent: 'Cette annonce sera retirée pour tous les membres du cours.',
  deleteError: "La suppression de l'annonce a échoué.",

  formTitle: 'Nouvelle annonce',
  editTitle: "Modifier l'annonce",
  formSubtitle: 'Visible par tous les membres du cours.',
  titleLabel: 'Titre',
  titlePlaceholder: 'Examen intra déplacé au 4 novembre',
  contentLabel: 'Texte (facultatif)',
  contentPlaceholder: 'Même local, même heure.',
  colorLabel: 'Couleur',
  expiryLabel: 'Expiration',
  never: 'Jamais',
  cancel: 'Annuler',
  publish: 'Publier',
  save: 'Enregistrer',
  titleRequired: 'Entrez un titre.',
  dateRequired: "Choisissez une date d'expiration, ou cochez « Jamais ».",
  datePast: "La date d'expiration doit être aujourd'hui ou plus tard.",
  publishError: "La publication de l'annonce a échoué. Réessayez.",
  saveError: "La modification de l'annonce a échoué. Réessayez.",
};

export type AnnouncementLabels = typeof defaultAnnouncementLabels;

/** Bornes alignées sur le backend (Post.title VARCHAR(256), ForumService.MAX_CONTENT_LENGTH). */
export const ANNOUNCEMENT_TITLE_MAX_LENGTH = 256;
