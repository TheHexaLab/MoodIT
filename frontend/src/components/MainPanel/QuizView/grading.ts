/**
 * Grader de PRÉVISUALISATION (mode mock, sans backend). Reproduit côté client la
 * correction des 5 types « à réponses » à partir des données embarquées dans le
 * quiz (vérité `isCorrect` / `correctOrder` / `groupName`). Le type Code n'est
 * PAS exécutable dans le navigateur : il est marqué « non évalué » (`tests: null`).
 *
 * ⚠️ En production, c'est le backend qui corrige (voir `SubmitQuizHandler`). Ce
 * module n'existe que pour faire vivre la démo locale.
 */

import { type Quiz, type Question } from '../../../types/domain';
import {
  type AttemptAnswers,
  type QuestionAnswer,
  type QuestionResult,
  type QuizResult,
} from './quizAttempt';

/** Score proportionnel borné, arrondi : `total × ratio` avec `ratio ∈ [0, 1]`. */
function scaled(total: number, ratio: number): number {
  return Math.round(total * Math.max(0, Math.min(1, ratio)));
}

function gradeChoice(question: Question, answer: QuestionAnswer | undefined): QuestionResult {
  const options = question.answers ?? [];
  const correctIds = options.filter((o) => o.isCorrect).map((o) => o.id);
  const selectedIds = answer?.kind === 'choice' ? answer.answerIds : [];
  const correctSet = new Set(correctIds);
  const selectedSet = new Set(selectedIds);

  let earned: number;
  if (question.qType === 'multiple_choice') {
    // Crédit partiel : (bonnes cochées − mauvaises cochées) / nb_bonnes, borné à 0.
    const good = selectedIds.filter((id) => correctSet.has(id)).length;
    const bad = selectedIds.filter((id) => !correctSet.has(id)).length;
    const ratio = correctIds.length === 0 ? 0 : (good - bad) / correctIds.length;
    earned = scaled(question.totalScore, ratio);
  } else {
    // Vrai/Faux & Choix unique : tout-ou-rien (ensemble choisi == ensemble correct).
    const exact =
      selectedSet.size === correctSet.size && [...selectedSet].every((id) => correctSet.has(id));
    earned = exact ? question.totalScore : 0;
  }

  return {
    questionId: question.id,
    earned,
    max: question.totalScore,
    correctAnswerIds: correctIds,
    selectedAnswerIds: selectedIds,
  };
}

function gradeOrdering(question: Question, answer: QuestionAnswer | undefined): QuestionResult {
  const items = question.dragItems ?? [];
  // Ordre attendu : ids triés par `correctOrder` croissant.
  const correctOrder = [...items]
    .sort((a, b) => (a.correctOrder ?? 0) - (b.correctOrder ?? 0))
    .map((d) => d.id);
  const submittedOrder = answer?.kind === 'ordering' ? answer.itemIds : [];

  // Crédit partiel : proportion d'éléments à la bonne position.
  const correctCount = submittedOrder.filter((id, i) => correctOrder[i] === id).length;
  const ratio = items.length === 0 ? 0 : correctCount / items.length;

  return {
    questionId: question.id,
    earned: scaled(question.totalScore, ratio),
    max: question.totalScore,
    correctOrder,
    submittedOrder,
  };
}

function gradeMatching(question: Question, answer: QuestionAnswer | undefined): QuestionResult {
  const items = question.dragItems ?? [];
  const placement = answer?.kind === 'matching' ? answer.placement : {};

  const matching = items.map((d) => {
    const chosenGroup = placement[d.id] ?? null;
    const correctGroup = d.groupName ?? '';
    return { itemId: d.id, chosenGroup, correctGroup, correct: chosenGroup === correctGroup };
  });

  // Crédit partiel : proportion d'éléments bien classés.
  const correctCount = matching.filter((m) => m.correct).length;
  const ratio = items.length === 0 ? 0 : correctCount / items.length;

  return {
    questionId: question.id,
    earned: scaled(question.totalScore, ratio),
    max: question.totalScore,
    matching,
  };
}

function gradeCoding(question: Question, answer: QuestionAnswer | undefined): QuestionResult {
  // Le code ne s'exécute PAS dans le navigateur : la vraie évaluation des harnais
  // est faite côté serveur (onSubmitQuiz). Ici (mode mock) on simule un verdict
  // DÉTERMINISTE par harnais, uniquement pour faire vivre la révision (voir quels
  // Test_Case passent/échouent). Heuristique ALIGNÉE sur `dashboardApi.evaluateCode`
  // (chemin « Tester ») pour que la correction Code soit identique des deux côtés :
  // tenté = code non vide ; alors un harnais sur deux passe (résultat partiel illustratif).
  const tests = question.testCases ?? [];
  const code = answer?.kind === 'coding' ? answer.code : '';
  const attempted = code.trim().length > 0;

  const results = tests.map((t, i) => ({
    name: t.name,
    passed: attempted && i % 2 === 0,
    weight: t.weight,
  }));
  const totalWeight = tests.reduce((sum, t) => sum + t.weight, 0);
  const passedWeight = tests.reduce((sum, t, i) => sum + (results[i].passed ? t.weight : 0), 0);
  const ratio = totalWeight === 0 ? 0 : passedWeight / totalWeight;

  return {
    questionId: question.id,
    earned: scaled(question.totalScore, ratio),
    max: question.totalScore,
    // Pas de harnais défini → on garde `null` (note « évalué côté serveur »).
    tests: tests.length > 0 ? results : null,
  };
}

/** Corrige une question selon son type. */
export function gradeQuestion(
  question: Question,
  answer: QuestionAnswer | undefined
): QuestionResult {
  switch (question.qType) {
    case 'true_false':
    case 'single_choice':
    case 'multiple_choice':
      return gradeChoice(question, answer);
    case 'ordering':
      return gradeOrdering(question, answer);
    case 'matching':
      return gradeMatching(question, answer);
    case 'coding':
      return gradeCoding(question, answer);
  }
}

/** Corrige une tentative complète (prévisualisation locale). */
export function gradeQuiz(quiz: Quiz, answers: AttemptAnswers): QuizResult {
  const questions = (quiz.questions ?? []).map((q) => gradeQuestion(q, answers[q.id]));
  return {
    quizId: quiz.id,
    earned: questions.reduce((sum, q) => sum + q.earned, 0),
    max: questions.reduce((sum, q) => sum + q.max, 0),
    questions,
  };
}
