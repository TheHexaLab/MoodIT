/**
 * Contrats de la PASSATION d'un quiz (côté étudiant), pensés API-ready : les
 * formes échangées avec le backend (chargement du détail, soumission, résultat
 * corrigé) sont isolées ici, indépendamment du rendu.
 *
 * Règle de correction (rappel du modèle) : la vérité de correction est SERVEUR.
 * Le front envoie les réponses brutes (`QuizSubmission`) et reçoit un
 * `QuizResult` déjà corrigé. En l'absence de backend (mode mock), un grader de
 * prévisualisation local le calcule à partir des données embarquées (voir
 * `grading.ts`) — sauf le code, qui ne s'exécute pas dans le navigateur.
 */

import { type Quiz, type Question, type QuestionType } from '../../../types/domain';

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Réponse de l'étudiant à UNE question, forme normalisée par famille de type.
 * `kind` regroupe les types qui partagent la même saisie :
 * - `choice`   → Vrai/Faux, Choix unique (≤ 1 id), Choix multiple (n ids).
 * - `ordering` → ids des `Drag_Item` dans l'ordre choisi.
 * - `matching` → placement `dragItemId → groupName` (null = non classé).
 * - `coding`   → code source saisi.
 */
export type QuestionAnswer =
  | { kind: 'choice'; answerIds: number[] }
  | { kind: 'ordering'; itemIds: number[] }
  | { kind: 'matching'; placement: Record<number, string | null> }
  | { kind: 'coding'; code: string };

/** État des réponses d'une tentative, indexé par `Question.id`. */
export type AttemptAnswers = Record<number, QuestionAnswer>;

/** Famille de saisie d'un type de question (mappe `QuestionType` → `QuestionAnswer.kind`). */
export function answerKindFor(qType: QuestionType): QuestionAnswer['kind'] {
  switch (qType) {
    case 'true_false':
    case 'single_choice':
    case 'multiple_choice':
      return 'choice';
    case 'ordering':
      return 'ordering';
    case 'matching':
      return 'matching';
    case 'coding':
      return 'coding';
  }
}

/** Réponse vide (état initial) pour une question donnée. */
export function emptyAnswer(question: Question): QuestionAnswer {
  switch (answerKindFor(question.qType)) {
    case 'choice':
      return { kind: 'choice', answerIds: [] };
    case 'ordering':
      // Ordre de départ = ordre de livraison (le backend le mélange ; le mock le
      // livre tel quel). On part des `dragItems` dans l'ordre fourni.
      return { kind: 'ordering', itemIds: (question.dragItems ?? []).map((d) => d.id) };
    case 'matching':
      // Tous les éléments commencent « non classés » (dans la réserve).
      return {
        kind: 'matching',
        placement: Object.fromEntries((question.dragItems ?? []).map((d) => [d.id, null])),
      };
    case 'coding':
      return { kind: 'coding', code: question.startCode ?? '' };
  }
}

/** Construit l'état de réponses initial d'un quiz (une entrée par question). */
export function initAnswers(quiz: Quiz): AttemptAnswers {
  const answers: AttemptAnswers = {};
  for (const q of quiz.questions ?? []) answers[q.id] = emptyAnswer(q);
  return answers;
}

/** Une question a-t-elle reçu une réponse (pour l'indicateur « répondue ») ? */
export function isAnswered(answer: QuestionAnswer | undefined): boolean {
  if (!answer) return false;
  switch (answer.kind) {
    case 'choice':
      return answer.answerIds.length > 0;
    case 'ordering':
      return answer.itemIds.length > 0;
    case 'matching':
      return Object.values(answer.placement).some((g) => g != null);
    case 'coding':
      return answer.code.trim().length > 0;
  }
}

// ───────────────────────── Soumission & résultat (API) ─────────────────────────

/** Réponse d'une question telle qu'envoyée au backend. */
export interface SubmittedAnswer {
  questionId: number;
  /** Choix : ids des options cochées. */
  answerIds?: number[];
  /** Remise en ordre : ids des éléments dans l'ordre soumis. */
  orderedItemIds?: number[];
  /** Association : placement `dragItemId → groupName`. */
  placement?: Record<number, string | null>;
  /** Code : source soumise. */
  code?: string;
}

/** Charge utile de soumission d'une tentative. */
export interface QuizSubmission {
  quizId: number;
  answers: SubmittedAnswer[];
}

/** Détail de correction d'un item d'Association (pour l'écran de révision). */
export interface MatchingItemResult {
  itemId: number;
  chosenGroup: string | null;
  correctGroup: string;
  correct: boolean;
}

/** Détail de correction d'un harnais de question Code. */
export interface CodingTestResult {
  name: string;
  passed: boolean;
  /** Poids du harnais (Test_Case.weight) — pour afficher sa contribution au score. */
  weight: number;
}

/**
 * Résultat corrigé d'UNE question (vérité serveur). `earned`/`max` pilotent
 * l'affichage du score ; les champs optionnels alimentent l'écran de révision
 * selon le type (réponses correctes, ordre attendu, placements, harnais).
 */
export interface QuestionResult {
  questionId: number;
  earned: number;
  max: number;
  /** Choix : ids corrects / ids choisis par l'étudiant. */
  correctAnswerIds?: number[];
  selectedAnswerIds?: number[];
  /** Remise en ordre : ordre attendu / ordre soumis (ids d'éléments). */
  correctOrder?: number[];
  submittedOrder?: number[];
  /** Association : détail par élément. */
  matching?: MatchingItemResult[];
  /** Code : résultat par harnais. `null` si non évalué (ex. mode mock navigateur). */
  tests?: CodingTestResult[] | null;
}

/** Résultat corrigé d'une tentative complète. */
export interface QuizResult {
  quizId: number;
  earned: number;
  max: number;
  questions: QuestionResult[];
}

/** Transforme l'état de réponses en charge utile de soumission. */
export function toSubmission(quiz: Quiz, answers: AttemptAnswers): QuizSubmission {
  const submitted: SubmittedAnswer[] = (quiz.questions ?? []).map((q) => {
    const a = answers[q.id];
    switch (a?.kind) {
      case 'choice':
        return { questionId: q.id, answerIds: a.answerIds };
      case 'ordering':
        return { questionId: q.id, orderedItemIds: a.itemIds };
      case 'matching':
        return { questionId: q.id, placement: a.placement };
      case 'coding':
        return { questionId: q.id, code: a.code };
      default:
        return { questionId: q.id };
    }
  });
  return { quizId: quiz.id, answers: submitted };
}

/**
 * Reconstruit l'état de réponses à partir d'une charge utile de soumission
 * (opération inverse de `toSubmission`). Sert au grader de prévisualisation
 * MOCK côté « serveur » (cf. `dashboardApi.submitQuiz`), qui reçoit une
 * `QuizSubmission` et veut la corriger via `gradeQuiz` (qui attend des `AttemptAnswers`).
 */
export function fromSubmission(quiz: Quiz, submission: QuizSubmission): AttemptAnswers {
  const byId = new Map(submission.answers.map((a) => [a.questionId, a]));
  const answers: AttemptAnswers = {};
  for (const q of quiz.questions ?? []) {
    const s = byId.get(q.id);
    switch (answerKindFor(q.qType)) {
      case 'choice':
        answers[q.id] = { kind: 'choice', answerIds: s?.answerIds ?? [] };
        break;
      case 'ordering':
        answers[q.id] = { kind: 'ordering', itemIds: s?.orderedItemIds ?? [] };
        break;
      case 'matching':
        answers[q.id] = { kind: 'matching', placement: s?.placement ?? {} };
        break;
      case 'coding':
        answers[q.id] = { kind: 'coding', code: s?.code ?? '' };
        break;
    }
  }
  return answers;
}

// ───────────────────────────── Handlers API-ready ─────────────────────────────

/**
 * Chargement du détail d'un quiz (questions embarquées). API-ready : fourni par
 * le parent (GET). Absent → la vue se rabat sur le quiz mock fourni en repli.
 */
export type FetchQuizHandler = (quizId: number) => MaybePromise<Quiz>;

/**
 * Soumission d'une tentative. API-ready : le backend corrige et renvoie le
 * `QuizResult`. Absent → le grader de prévisualisation local s'en charge.
 */
export type SubmitQuizHandler = (submission: QuizSubmission) => MaybePromise<QuizResult>;
