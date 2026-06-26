/**
 * Libellés du corps « Modifier le quiz / Nouveau quiz » (méta + liste de questions).
 * Passés via `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface QuizFormLabels {
  /** Label du champ titre. */
  titleLabel: string;
  /** Placeholder du champ titre. */
  titlePlaceholder: string;
  /** Interrupteur « publié ». */
  published: string;
  /** Interrupteur « quiz du jour ». */
  daily: string;
  /** Titre de la section des questions. */
  questionsSection: string;
  /** Formatte un total de points (badge + méta de section). */
  points: (value: number) => string;
  /** Bouton d'ajout d'une question. */
  addQuestion: string;
  /** aria-label « modifier la question ». */
  editQuestionAria: string;
  /** aria-label « supprimer la question ». */
  deleteQuestionAria: string;
  /** Sous-ligne quand la question n'a pas d'énoncé. */
  noPrompt: string;
  /** Bouton annuler. */
  cancel: string;
  /** Bouton enregistrer en création. */
  create: string;
  /** Bouton enregistrer en édition. */
  save: string;
}

/** Textes par défaut (FR) du formulaire de quiz. */
export const defaultQuizFormLabels: QuizFormLabels = {
  titleLabel: 'Titre',
  titlePlaceholder: 'Titre du quiz',
  published: 'Publié',
  daily: 'Quiz du jour',
  questionsSection: 'Questions',
  points: (value) => `${value} pts`,
  addQuestion: 'Ajouter',
  editQuestionAria: 'Modifier la question',
  deleteQuestionAria: 'Supprimer la question',
  noPrompt: 'Sans énoncé',
  cancel: 'Annuler',
  create: 'Créer',
  save: 'Enregistrer',
};
