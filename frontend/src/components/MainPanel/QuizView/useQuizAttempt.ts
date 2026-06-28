import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Quiz } from '../../../types/domain';
import {
  type AttemptAnswers,
  type FetchQuizHandler,
  type QuestionAnswer,
  type QuizResult,
  type SubmitQuizHandler,
  initAnswers,
  toSubmission,
} from './quizAttempt';
import { gradeQuiz } from './grading';

/**
 * Phase de la tentative :
 * - `taking`  : l'étudiant répond, navigation Q1→Qn.
 * - `summary` : quiz soumis et corrigé, écran récapitulatif (score).
 * - `review`  : relecture d'une question donnée avec sa correction.
 */
export type QuizPhase = 'taking' | 'summary' | 'review';

interface UseQuizAttemptParams {
  /** Quiz de départ (mock / cache) : affiché immédiatement, sert aussi de repli. */
  initialQuiz: Quiz;
  /** Chargement du détail (API-ready, GET). Absent → on reste sur `initialQuiz`. */
  onFetchQuiz?: FetchQuizHandler;
  /** Soumission (API-ready). Absent → correction par le grader de prévisualisation. */
  onSubmitQuiz?: SubmitQuizHandler;
  /** Message d'erreur affiché si le chargement échoue (label, surchargeable). */
  loadErrorMessage?: string;
  /** Message d'erreur affiché si la soumission échoue (label, surchargeable). */
  submitErrorMessage?: string;
}

export interface QuizAttemptApi {
  quiz: Quiz;
  /** Chargement initial du détail en cours. */
  loading: boolean;
  loadError: string | null;
  reload: () => void;

  phase: QuizPhase;
  /** Index de la question affichée (en `taking` et `review`). */
  currentIndex: number;
  /** Réponses courantes, indexées par `Question.id`. */
  answers: AttemptAnswers;
  /**
   * Ids des questions que l'étudiant a réellement modifiées (interaction). Sert
   * d'indicateur « répondue » fiable : les valeurs par défaut (ordre livré d'une
   * Remise en ordre, squelette d'une question Code) ne comptent PAS tant qu'elles
   * ne sont pas touchées.
   */
  touched: Set<number>;
  /** Résultat corrigé (disponible en `summary` / `review`). */
  result: QuizResult | null;

  submitting: boolean;
  submitError: string | null;

  // ── Saisie ──
  setAnswer: (questionId: number, answer: QuestionAnswer) => void;

  // ── Navigation (passation) ──
  goNext: () => void;
  goPrev: () => void;
  /** Saute directement à une question (points de progression cliquables). */
  goTo: (index: number) => void;
  /** Soumet la tentative ; passe en `summary` si la correction réussit. */
  submit: () => void;

  // ── Révision ──
  /** Ouvre la révision d'une question (depuis le résumé). */
  reviewQuestion: (index: number) => void;
  /** Revient au résumé depuis la révision. */
  backToSummary: () => void;
}

/**
 * Source de vérité d'une tentative de quiz : charge le détail (API-ready),
 * accumule les réponses, pilote la machine de phases et délègue la correction au
 * backend (ou au grader local en mode mock). Le composant est remonté via `key`
 * au changement de quiz, donc l'état repart de zéro à chaque quiz.
 */
export function useQuizAttempt({
  initialQuiz,
  onFetchQuiz,
  onSubmitQuiz,
  loadErrorMessage = 'Impossible de charger le quiz. Réessayez.',
  submitErrorMessage = 'La soumission a échoué. Réessayez.',
}: UseQuizAttemptParams): QuizAttemptApi {
  const [quiz, setQuiz] = useState<Quiz>(initialQuiz);
  const [loading, setLoading] = useState<boolean>(Boolean(onFetchQuiz));
  const [loadError, setLoadError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<AttemptAnswers>(() => initAnswers(initialQuiz));
  const [touched, setTouched] = useState<Set<number>>(() => new Set());
  const [phase, setPhase] = useState<QuizPhase>('taking');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState<QuizResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const fetchRef = useRef(onFetchQuiz);
  useEffect(() => {
    fetchRef.current = onFetchQuiz;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const questionCount = quiz.questions?.length ?? 0;

  /** Charge (ou recharge) le détail du quiz via `onFetchQuiz`. */
  const reload = useCallback(async () => {
    const fetchQuiz = fetchRef.current;
    if (!fetchQuiz) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await fetchQuiz(initialQuiz.id);
      if (!mountedRef.current) return;
      setQuiz(fetched);
      setAnswers(initAnswers(fetched));
      setTouched(new Set());
      setPhase('taking');
      setCurrentIndex(0);
      setResult(null);
    } catch {
      if (!mountedRef.current) return;
      setLoadError(loadErrorMessage);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [initialQuiz.id, loadErrorMessage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setAnswer = useCallback((questionId: number, answer: QuestionAnswer) => {
    setAnswers((prev) => ({ ...prev, [questionId]: answer }));
    setTouched((prev) => (prev.has(questionId) ? prev : new Set(prev).add(questionId)));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex((i) => Math.min(i + 1, Math.max(questionCount - 1, 0)));
  }, [questionCount]);

  const goPrev = useCallback(() => {
    setCurrentIndex((i) => Math.max(i - 1, 0));
  }, []);

  const goTo = useCallback(
    (index: number) => {
      setCurrentIndex(Math.max(0, Math.min(index, Math.max(questionCount - 1, 0))));
    },
    [questionCount]
  );

  const submit = useCallback(async () => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const graded = onSubmitQuiz
        ? await onSubmitQuiz(toSubmission(quiz, answers))
        : gradeQuiz(quiz, answers); // repli : correction locale (mode mock)
      if (!mountedRef.current) return;
      setResult(graded);
      setPhase('summary');
    } catch {
      if (!mountedRef.current) return;
      setSubmitError(submitErrorMessage);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [quiz, answers, onSubmitQuiz, submitErrorMessage]);

  const reviewQuestion = useCallback((index: number) => {
    setCurrentIndex(index);
    setPhase('review');
  }, []);

  const backToSummary = useCallback(() => setPhase('summary'), []);

  return useMemo<QuizAttemptApi>(
    () => ({
      quiz,
      loading,
      loadError,
      reload: () => void reload(),
      phase,
      currentIndex,
      answers,
      touched,
      result,
      submitting,
      submitError,
      setAnswer,
      goNext,
      goPrev,
      goTo,
      submit: () => void submit(),
      reviewQuestion,
      backToSummary,
    }),
    [
      quiz,
      loading,
      loadError,
      reload,
      phase,
      currentIndex,
      answers,
      touched,
      result,
      submitting,
      submitError,
      setAnswer,
      goNext,
      goPrev,
      goTo,
      submit,
      reviewQuestion,
      backToSummary,
    ]
  );
}
