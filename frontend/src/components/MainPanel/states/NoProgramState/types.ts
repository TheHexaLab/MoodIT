/** Types de libellés du NoProgramState (etat 1 : aucun programme rejoint). */

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface NoProgramStateLabels {
  /** Titre principal. */
  title: string;
  /** Texte affiche a un utilisateur sans droits d'administration. */
  userSubtitle: string;
  /** Texte affiche a un administrateur (qui voit aussi le bouton de creation). */
  adminSubtitle: string;
  /** Libellé du bouton d'ajout d'un programme, ouvre le menu créer/gérer (admin seulement). */
  addProgram: string;
  /** Libellé du bouton « rejoindre un programme » (affiche a tous). */
  joinProgram: string;
}
