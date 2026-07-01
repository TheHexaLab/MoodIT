/**
 * Libellés de la carte de question (en-tête : barème / score). Passés via `labels`
 * (en Partial) ; les champs omis prennent les défauts.
 */
export interface QuestionCardLabels {
  /** Étiquette « Question N » (N = position 1-based). */
  questionLabel: (index: number) => string;
  /** Barème en passation (« N pts »). */
  points: (value: number) => string;
  /** Score obtenu en révision (« earned / max pts »). */
  score: (earned: number, max: number) => string;
}

/** Textes par défaut (FR) de la carte de question. */
export const defaultQuestionCardLabels: QuestionCardLabels = {
  questionLabel: (index) => `Question ${index}`,
  points: (value) => `${value} pts`,
  score: (earned, max) => `${earned} / ${max} pts`,
};
