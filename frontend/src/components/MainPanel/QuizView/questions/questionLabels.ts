/**
 * Libellés partagés des rendus de question (passation + révision). Passés via
 * `labels` (en Partial) sur `QuestionRenderer` ; les champs omis prennent les défauts.
 */
export interface QuestionLabels {
  /** Aide « choix multiple ». */
  multipleHelper: string;
  /** Aide « remise en ordre ». */
  orderingHelper: string;
  /** Aide « association ». */
  matchingHelper: string;
  /** Catégorie affichée pour un élément non classé (révision association). */
  unplacedGroup: string;
  /** Libellé « Ta réponse » (révision code). */
  yourAnswer: string;
  /** Libellé « Résultat des tests » (révision code). */
  testsResult: string;
  /** Note quand le détail des harnais n'est pas disponible. */
  serverNote: string;
  /** Affiché tant que la correction async du code (exécution sandbox) n'a pas renvoyé les verdicts. */
  evaluating: string;
  /** aria-label de l'éditeur de code (nom du langage). */
  codeAria: (language: string) => string;
}

/** Textes par défaut (FR) des rendus de question. */
export const defaultQuestionLabels: QuestionLabels = {
  multipleHelper: 'Plusieurs réponses possibles.',
  orderingHelper: 'Glisse les éléments pour les réordonner.',
  matchingHelper: 'Glisse chaque étiquette dans la catégorie qui convient.',
  unplacedGroup: '—',
  yourAnswer: 'Ta réponse',
  testsResult: 'Résultat des tests',
  serverNote:
    "Les harnais de test sont exécutés côté serveur ; le détail n'est pas disponible ici.",
  evaluating: 'Évaluation du code en cours…',
  codeAria: (language) => `Éditeur de code (${language})`,
};
