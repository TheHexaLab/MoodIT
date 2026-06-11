/** Types de libellés du ChannelView. */

/**
 * Tous les textes affichés par le composant (visibles + aria).
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface ChannelViewLabels {
  /** État de chargement de l'historique. */
  loading: string;
  /** Bouton « réessayer » de l'état d'erreur de chargement. */
  retry: string;
  /** Message affiché quand le canal n'a aucun message. */
  empty: string;
  /** Référence d'une réponse dont le message parent a été supprimé. */
  deletedParent: string;
  /** aria-label des contrôles d'édition (bouton + champ). */
  edit: string;
  /** Bouton « annuler » de l'édition inline. */
  editCancel: string;
  /** Bouton « enregistrer » de l'édition inline. */
  editSave: string;
  /** aria-label du bouton « répondre ». */
  reply: string;
  /** aria-label du bouton « supprimer ». */
  delete: string;
  /** Préfixe de la barre « répondre à … » (suivi du nom de l'auteur). */
  replyingToPrefix: string;
  /** aria-label du bouton d'annulation de la réponse. */
  cancelReply: string;
  /** aria-label du bouton de pièce jointe. */
  addAttachment: string;
  /** Préfixe du placeholder / aria de la zone de saisie (suivi du nom du canal). */
  composerPlaceholder: string;
  /** aria-label du bouton d'envoi. */
  send: string;
  /** Titre du popup de confirmation de suppression. */
  deleteTitle: string;
  /** Contenu du popup de confirmation de suppression. */
  deleteContent: string;
}
