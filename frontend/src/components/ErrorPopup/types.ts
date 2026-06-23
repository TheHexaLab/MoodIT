/** Types de libellés du ErrorPopup. */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface ErrorPopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Libellé du bouton de fermeture. */
  close: string;
  /** Libellé du bouton de réessai. */
  retry: string;
}
