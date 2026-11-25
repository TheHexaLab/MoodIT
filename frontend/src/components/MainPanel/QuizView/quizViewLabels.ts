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
  /** Soumission refusée par le serveur sans motif lisible : renvoyer telle quelle ne sert à rien. */
  submitRejected: string;
  /** Soumission refusée car trop volumineuse (413 du gateway, au-delà de 1 Mo). */
  submitTooLarge: string;
  /**
   * Soumission refusée TEMPORAIREMENT (409 de cause « relance », quiz AVEC reprise) : l'enseignant
   * relance la correction de la tentative précédente. Le brouillon est gardé, à renvoyer plus tard.
   */
  submitRegrading: string;
  /**
   * Soumission refusée DÉFINITIVEMENT (409 « déjà soumis ») : la tentative unique est déjà
   * consommée (autre onglet…). La vue rouvre le résumé.
   */
  submitAlreadySubmitted: string;
  /** Message d'erreur quand la vérification du code est indisponible (503) : la tentative
   *  n'a pas été enregistrée, l'étudiant peut renvoyer. */
  codeVerificationUnavailable: string;
  /**
   * Message quand la correction d'une soumission n'a pas été confirmée au plafond d'attente
   * (30 min, au-delà du pire cas serveur) ou après un rechargement : réponses restaurées, renvoi
   * possible (un renvoi refusé parce que la correction tourne encore revient à l'attente).
   */
  submissionNotConfirmed: string;
  /**
   * Texte de la région d'état pendant l'attente de la correction (spinner plein quiz) : elle peut
   * durer plusieurs minutes, et l'étudiant peut quitter la page.
   */
  gradingInProgress: string;
  /** Statut d'en-tête d'une tentative à revoir par l'enseignant (#116). */
  awaitingReviewStatus: string;
  /** Titre du message affiché à la place du résumé : tentative à revoir (#116). */
  awaitingReviewTitle: string;
  /** Corps de ce message. */
  awaitingReview: string;
  /** Annonce (lecteur d'écran) quand la relance de l'enseignant aboutit sur la tentative affichée. */
  reviewGraded: string;
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
  submitRejected: 'La soumission a été refusée : vérifiez vos réponses avant de la renvoyer.',
  submitTooLarge: 'Réponses trop volumineuses : réduisez le code soumis, puis renvoyez.',
  submitRegrading:
    'Votre tentative précédente est en cours de recorrection par votre enseignant. Réessayez plus tard : vos réponses sont conservées.',
  submitAlreadySubmitted: 'Ce quiz a déjà été soumis.',
  codeVerificationUnavailable:
    "La vérification du code est momentanément indisponible. Votre tentative n'a pas été enregistrée : réessayez de l'envoyer.",
  submissionNotConfirmed:
    "Votre tentative n'a pas pu être confirmée. Vérifiez l'historique ou renvoyez-la.",
  gradingInProgress:
    'Correction en cours… cela peut prendre plusieurs minutes ; vous pouvez quitter cette page et revenir.',
  awaitingReviewStatus: "En attente de l'enseignant",
  awaitingReviewTitle: 'Tentative transmise à votre enseignant',
  awaitingReview:
    "La correction automatique de votre code n'a pas abouti. Votre tentative est enregistrée et votre enseignant va relancer sa correction : vous recevrez votre résultat ici.",
  reviewGraded: 'Votre tentative a été corrigée : son résultat est affiché.',
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
