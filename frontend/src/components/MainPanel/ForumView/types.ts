/** Types de libellés des composants du dossier ForumView. */

/**
 * Tous les textes affichés par ForumView (visibles + aria).
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface ForumViewLabels {
  /** État de chargement des sujets. */
  loading: string;
  /** Bouton « réessayer » de l'état d'erreur de chargement. */
  retry: string;
  /** Message affiché quand le forum n'a aucun sujet. */
  empty: string;
  /** aria-label du groupe de tri. */
  sortGroup: string;
  /** Bouton de tri « populaires ». */
  sortTop: string;
  /** Bouton de tri « récents ». */
  sortRecent: string;
  /** Bouton « nouveau sujet ». */
  newThread: string;
  /** aria-label du bouton de vote positif. */
  voteUp: string;
  /** aria-label du bouton de vote négatif. */
  voteDown: string;
  /** title affiché quand on ne peut pas voter sa propre publication. */
  ownVoteTitle: string;
  /** aria-label du bouton « répondre ». */
  reply: string;
  /** aria-label du bouton « modifier ». */
  edit: string;
  /** aria-label du bouton « supprimer ». */
  delete: string;
  /** aria-label du toggle de réponses (fil déplié → on replie). */
  collapseReplies: string;
  /** aria-label du toggle de réponses (fil replié → on déplie). */
  expandReplies: string;
  /** aria-label du filet vertical cliquable. */
  collapseThread: string;
  /** Suffixe singulier du compteur de réponses. */
  replyOne: string;
  /** Suffixe pluriel du compteur de réponses. */
  replyMany: string;
  /** Libellé « aucune réponse » (sujet sans réponse). */
  noReplies: string;
  /** Badge d'un sujet épinglé. */
  pinned: string;
  /** Titre du popup de confirmation de suppression. */
  deleteTitle: string;
  /** Contenu du popup de confirmation de suppression. */
  deleteContent: string;
  /** Placeholder + aria du champ titre du nouveau sujet. */
  newThreadTitle: string;
  /** Bouton de publication d'un nouveau sujet. */
  publish: string;
  /** Bouton d'enregistrement d'une édition. */
  editSave: string;
  /** Placeholder de l'éditeur d'édition. */
  editPlaceholder: string;
  /** Placeholder de l'éditeur de réponse. */
  replyPlaceholder: string;
  /** Placeholder de l'éditeur de nouveau sujet. */
  newThreadPlaceholder: string;
}

/**
 * Tous les textes internes du MarkdownEditor (barre d'outils, menus, actions).
 * Les libellés dynamiques (validation, placeholder) restent des props dédiées.
 */
export interface MarkdownEditorLabels {
  /** aria-label de la barre d'outils. */
  toolbar: string;
  /** Tooltip/aria du bouton de titre. */
  heading: string;
  /** aria-label du menu de niveaux de titre. */
  headingMenu: string;
  /** Niveau de titre — titre. */
  headingTitle: string;
  /** Niveau de titre — sous-titre. */
  headingSub: string;
  /** Niveau de titre — sous-sous-titre. */
  headingSubSub: string;
  /** Niveau de titre — petit titre. */
  headingSmall: string;
  /** Tooltip/aria « gras ». */
  bold: string;
  /** Tooltip/aria « italique ». */
  italic: string;
  /** Tooltip/aria « code en ligne ». */
  inlineCode: string;
  /** Tooltip/aria « bloc de code ». */
  codeBlock: string;
  /** aria-label du menu de langages. */
  codeBlockMenu: string;
  /** Entrée « sans langage » du menu de langages. */
  noLanguage: string;
  /** Tooltip/aria « lien ». */
  link: string;
  /** Tooltip/aria « liste à puces ». */
  bulletList: string;
  /** Tooltip/aria « liste numérotée ». */
  numberedList: string;
  /** Tooltip/aria « citation ». */
  quote: string;
  /** Tooltip « aperçu » (vers l'aperçu). */
  preview: string;
  /** Tooltip « modifier » (depuis l'aperçu). */
  previewExit: string;
  /** Bouton « annuler ». */
  cancel: string;
  /** Texte de l'aperçu vide. */
  emptyPreview: string;
}
