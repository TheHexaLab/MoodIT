// Textes du sélecteur de cours (dropdown) et de son menu contextuel.
// Centralisés ici suivant la convention `labels.ts` du projet : une seule source pour
// relecture / cohérence / traduction éventuelle. Les libellés dynamiques (qui intègrent
// le code du cours) sont exposés comme fonctions.

export interface CourseDropdownLabels {
  /** Code de repli affiché dans le sélecteur quand le cours n'a pas de code. */
  selectFallback: string;
  /** Placeholder du champ de recherche du dropdown. */
  searchPlaceholder: string;
  /** Message affiché quand la recherche ne renvoie aucun cours. */
  noResults: string;
  /** Libellé de l'option « ajouter un cours » (bas du dropdown). */
  addCourse: string;
  /** aria-label / title du crayon d'édition d'un cours (reçoit le code). */
  editCourseAction: (courseCode: string) => string;
  /** aria-label du menu contextuel (reçoit le code du cours). */
  contextMenuAria: (courseCode: string) => string;
  /** Item « Modifier le cours » du menu contextuel. */
  contextEditCourse: string;
  /** Item « Gestion MCP — Feedback du cours » du menu contextuel. */
  contextMcpManagement: string;
}

/** Tous les textes par défaut du dropdown de cours et de son menu contextuel. */
export const defaultLabels: CourseDropdownLabels = {
  selectFallback: 'Cours',
  searchPlaceholder: 'Rechercher un cours…',
  noResults: 'Aucun résultat',
  addCourse: 'Ajouter un cours',
  editCourseAction: (courseCode) => `Modifier le cours ${courseCode}`,
  contextMenuAria: (courseCode) => `Actions du cours ${courseCode}`,
  contextEditCourse: 'Modifier le cours',
  contextMcpManagement: 'Feedback du cours',
};
