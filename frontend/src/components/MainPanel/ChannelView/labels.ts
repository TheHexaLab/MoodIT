import type { ChannelViewLabels } from './types';

/** Tous les textes par défaut affichés par le ChannelView. */
export const defaultChannelViewLabels: ChannelViewLabels = {
  loading: 'Chargement des messages…',
  retry: 'Réessayer',
  empty: "Aucun message dans ce canal pour l'instant.",
  deletedParent: 'Message original supprimé',
  edit: 'Modifier le message',
  editCancel: 'Annuler',
  editSave: 'Enregistrer',
  reply: 'Répondre au message',
  delete: 'Supprimer le message',
  replyingToPrefix: 'Répondre à',
  cancelReply: 'Annuler la réponse',
  addAttachment: 'Ajouter une pièce jointe',
  composerPlaceholder: 'Envoyer un message dans',
  send: 'Envoyer le message',
  deleteTitle: 'Supprimer le message',
  deleteContent: 'Ce message sera définitivement supprimé. Continuer ?',
};
