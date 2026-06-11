/** Types de libellés du EmptyCourseState (etat 3 : le cours ne contient aucun canal/forum/quiz). */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface EmptyCourseStateLabels {
  /** Titre principal. */
  title: string;
  /** Texte affiche a un utilisateur sans droits d'administration (aucune action). */
  userSubtitle: string;
  /** Texte affiche a un administrateur (qui voit les boutons de creation). */
  adminSubtitle: string;
  /** Libellé du bouton de creation de canal (affiche seulement pour l'admin). */
  createChannel: string;
  /** Libellé du bouton de creation de quiz (affiche seulement pour l'admin). */
  createQuiz: string;
  /** Libellé du bouton de creation de forum (affiche seulement pour l'admin). */
  createForum: string;
}
