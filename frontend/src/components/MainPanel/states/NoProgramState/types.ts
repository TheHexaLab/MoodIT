/** Types de libellés du NoProgramState (etat 1 : aucun programme rejoint). */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface NoProgramStateLabels {
  /** Titre principal. */
  title: string;
  /** Texte affiche a un utilisateur sans droits d'administration (aucune action). */
  userSubtitle: string;
  /** Texte affiche a un administrateur (qui voit le bouton d'ajout). */
  adminSubtitle: string;
  /** Libellé du bouton d'ajout / d'adhesion a un programme (affiche seulement pour l'admin). */
  addProgram: string;
}
