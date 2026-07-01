/**
 * Libellés du corps « Tester » (prévisualisation d'une question). Passés via
 * `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface QuestionTestLabels {
  /** Bandeau d'information en tête. */
  infoBanner: string;
  /** Message d'erreur si l'évaluation du code échoue. */
  evalError: string;
  /** Bouton « réessayer » (après correction). */
  retry: string;
  /** Bouton « corriger ». */
  correct: string;
}

/** Textes par défaut (FR) de la prévisualisation de question. */
export const defaultQuestionTestLabels: QuestionTestLabels = {
  infoBanner: 'Prévisualisation : réponds comme un étudiant, puis « Corriger ».',
  evalError: "L'évaluation du code a échoué. Réessayez.",
  retry: 'Réessayer',
  correct: 'Corriger',
};
