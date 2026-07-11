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
  /** Message d'erreur quand la vérification du code est indisponible (503) : la tentative
   *  n'a pas été enregistrée, l'étudiant peut renvoyer. */
  codeVerificationUnavailable: string;
  /** Message quand une soumission interrompue par un refresh n'a pas pu être confirmée. */
  submissionNotConfirmed: string;
  /** Titre du popup d'erreur de soumission. */
  errorTitle: string;
  /** Bouton « réessayer » (erreur de chargement). */
  retry: string;
  /** Quiz sans question. */
  empty: string;
  /** Bouton « tableau de bord » (résumé). */
  toDashboard: string;
  /** Bouton « revoir mes réponses » (résumé). */
  reviewAnswers: string;
  /** Bouton « refaire le quiz » (résumé, si tentatives autorisées). */
  retryQuiz: string;
  /** Bouton « précédent ». */
  prev: string;
  /** Bouton « suivant ». */
  next: string;
  /** Bouton « soumettre ». */
  submit: string;
  /** Bouton « soumettre » pendant l'envoi. */
  submitting: string;
  /** Infobulle du bouton « soumettre » grisé : tentative unique déjà utilisée. */
  alreadySubmitted: string;
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
  codeVerificationUnavailable:
    "La vérification du code est momentanément indisponible. Votre tentative n'a pas été enregistrée : réessayez de l'envoyer.",
  submissionNotConfirmed:
    "Votre tentative n'a pas pu être confirmée. Vérifiez l'historique ou renvoyez-la.",
  errorTitle: 'Soumission impossible',
  retry: 'Réessayer',
  empty: 'Ce quiz ne contient pas encore de question.',
  toDashboard: 'Tableau de bord',
  reviewAnswers: 'Revoir mes réponses',
  retryQuiz: 'Refaire le quiz',
  prev: 'Précédent',
  next: 'Suivant',
  submit: 'Soumettre',
  submitting: 'Envoi…',
  alreadySubmitted: 'Vous avez déjà soumis ce quiz (une seule tentative autorisée).',
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
