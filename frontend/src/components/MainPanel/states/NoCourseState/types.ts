/** Types de libellés du NoCourseState (etat 2 : le programme ne contient aucun cours). */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface NoCourseStateLabels {
  /** Titre principal. */
  title: string;
  /** Texte affiche a un utilisateur sans droits d'administration (aucune action). */
  userSubtitle: string;
  /** Texte affiche a un administrateur (qui voit le bouton d'ajout). */
  adminSubtitle: string;
  /** Libellé du bouton d'ajout de cours (affiche seulement pour l'admin). */
  addCourse: string;
}
