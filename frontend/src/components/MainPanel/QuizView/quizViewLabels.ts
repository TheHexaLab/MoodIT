import type { QuizSummaryLabels } from './quizSummaryLabels';
import type { QuestionCardLabels } from './questionCardLabels';
import type { QuestionLabels } from './questions/questionLabels';

/**
 * Libellés de la coquille de la vue quiz (passation / résumé / révision) : en-tête,
 * statuts, navigation, états, et messages d'erreur (chargement / soumission).
 */
export interface QuizViewLabels {
  /** Titre d'en-tête quand le quiz est « du jour » (sinon = nom du canal). */
  dailyTitle: string;
  /** Statut « quiz terminé » (résumé). */
  finished: string;
  /** Statut « Question N sur T » (passation). */
  questionStatus: (current: number, total: number) => string;
  /** Bouton « retour au résumé » (révision). */
  backToSummary: string;
  /** État de chargement du détail. */
  loading: string;
  /** Message d'erreur de chargement (porté par le hook). */
  loadError: string;
  /** Message d'erreur de soumission (porté par le hook). */
  submitError: string;
  /** Bouton « réessayer » (erreur de chargement). */
  retry: string;
  /** Quiz sans question. */
  empty: string;
  /** Bouton « tableau de bord » (résumé). */
  toDashboard: string;
  /** Bouton « revoir mes réponses » (résumé). */
  reviewAnswers: string;
  /** Bouton « précédent ». */
  prev: string;
  /** Bouton « suivant ». */
  next: string;
  /** Bouton « soumettre ». */
  submit: string;
  /** Bouton « soumettre » pendant l'envoi. */
  submitting: string;
  /** Bouton « terminé » (fin de révision). */
  done: string;
  /** aria-label d'un point de progression. */
  dotAria: (index: number) => string;
}

/** Textes par défaut (FR) de la vue quiz. */
export const defaultQuizViewLabels: QuizViewLabels = {
  dailyTitle: 'Quiz du jour',
  finished: 'Quiz terminé',
  questionStatus: (current, total) => `Question ${current} sur ${total}`,
  backToSummary: 'Retour au résumé',
  loading: 'Chargement du quiz…',
  loadError: 'Impossible de charger le quiz. Réessayez.',
  submitError: 'La soumission a échoué. Réessayez.',
  retry: 'Réessayer',
  empty: 'Ce quiz ne contient pas encore de question.',
  toDashboard: 'Tableau de bord',
  reviewAnswers: 'Revoir mes réponses',
  prev: 'Précédent',
  next: 'Suivant',
  submit: 'Soumettre',
  submitting: 'Envoi…',
  done: 'Terminé',
  dotAria: (index) => `Question ${index}`,
};

/**
 * Ensemble de libellés exposé par `QuizView` : la coquille (`view`) + une surcharge
 * partielle pour le résumé, la carte de question et les rendus. Chaque section est
 * optionnelle (défauts sinon).
 */
export interface QuizViewLabelsBundle {
  view?: Partial<QuizViewLabels>;
  summary?: Partial<QuizSummaryLabels>;
  card?: Partial<QuestionCardLabels>;
  question?: Partial<QuestionLabels>;
}
