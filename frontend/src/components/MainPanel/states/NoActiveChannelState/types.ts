/** Types de libellés du NoActiveChannelState (etat 4 : aucun canal/forum/quiz selectionne). */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface NoActiveChannelStateLabels {
  /** Titre principal. */
  title: string;
  /** Texte d'explication sous le titre. */
  subtitle: string;
}
