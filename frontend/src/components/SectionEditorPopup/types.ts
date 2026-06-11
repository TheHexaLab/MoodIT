/** Types de données et de libellés du SectionEditorPopup. */

/** Valeur synchrone ou asynchrone : le callback de modification peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

export interface Item {
  id: string;
  name: string;
}

/**
 * Décrit une modification appliquée à la liste.
 * Émise via `onChange` ; le parent persiste comme il veut (l'endpoint vit chez lui).
 */
export type ItemChange =
  | { type: 'create'; item: Item }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'reorder'; orderedIds: string[] };

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface SectionEditorPopupLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé du bouton d'ajout. */
  addButton: string;
  /** Message affiché quand la liste est vide. */
  emptyMessage: string;
  /** Titre du formulaire en mode ajout. */
  addTitle: string;
  /** Titre du formulaire en mode édition. */
  editTitle: string;
  /** Titre de la confirmation de suppression. */
  deleteTitle: string;
  /** Corps de la confirmation ; reçoit l'item et le préfixe (pas de duplication). */
  deleteBody: (item: Item) => string;
  /** Bouton « annuler » du formulaire. */
  cancel: string;
  /** Bouton « enregistrer » du formulaire. */
  save: string;
  /** Aide sous le champ quand la saisie est valide. */
  hint: string;
  /** Aide sous le champ quand la saisie est invalide (format). */
  hintInvalid: string;
  /** Aide sous le champ quand le nom existe déjà dans la liste. */
  hintDuplicate: string;
  /** Titre du popup d'erreur. */
  errorTitle: string;
  /** Message d'erreur quand l'enregistrement d'une modification échoue. */
  saveError: string;
  /** Bouton « fermer » du popup d'erreur. */
  errorClose: string;
}
