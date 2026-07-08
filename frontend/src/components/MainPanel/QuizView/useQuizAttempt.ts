import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Quiz } from '../../../types/domain';
import {
  type AttemptAnswers,
  type AttemptSummary,
  type FetchAttemptResultHandler,
  type FetchAttemptsHandler,
  type FetchQuizHandler,
  type QuestionAnswer,
  type QuizResult,
  type SubmitQuizHandler,
  type SubscribeCodeGrading,
  initAnswers,
  mergeAnswers,
  mergeCodeResults,
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
  /**
   * Historique des tentatives (API-ready, GET). Non vide au chargement → on ouvre sur
   * le récap de la DERNIÈRE tentative ; vide → passation.
   */
  onFetchAttempts?: FetchAttemptsHandler;
  /** Détail corrigé d'une tentative (API-ready, GET) : révision d'une tentative passée. */
  onFetchAttemptResult?: FetchAttemptResultHandler;
  /** Soumission (API-ready). Absent → correction par le grader de prévisualisation. */
  onSubmitQuiz?: SubmitQuizHandler;
  /**
   * Abonnement à la correction ASYNC des questions Code (WS, pré-lié à l'utilisateur courant).
   * Quand les verdicts arrivent, le résultat courant est mis à jour en direct. Absent → pas de
   * live-update (les verdicts apparaissent au rechargement de la tentative).
   */
  onSubscribeCodeGrading?: SubscribeCodeGrading;
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
  /** Recharge le quiz en CONSERVANT les réponses déjà saisies (fusion). */
  reloadKeepingAnswers: () => void;

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

  // ── Tentatives ──
  /** Historique des tentatives (résumés), ordre croissant. */
  attempts: AttemptSummary[];
  /** Tentative actuellement affichée au récap (null si passation en cours). */
  currentAttemptId: number | null;
  /** Le quiz autorise-t-il une nouvelle tentative ? */
  allowRetry: boolean;
  /**
   * L'étudiant a déjà consommé sa tentative unique (au moins une tentative ET reprise
   * interdite) → la soumission doit être bloquée côté UI (miroir du 409 backend).
   */
  alreadySubmitted: boolean;
  /** Relance une nouvelle tentative (repasse en `taking`). */
  retry: () => void;
  /** Affiche le récap d'une tentative passée. */
  selectAttempt: (attemptId: number) => void;

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
 * Source de vérité d'une tentative de quiz : charge le détail + l'historique des
 * tentatives (API-ready), accumule les réponses, pilote la machine de phases et délègue
 * la correction au backend (ou au grader local en mode mock). Remonté via `key` au
 * changement de quiz → l'état repart de zéro à chaque quiz.
 */
export function useQuizAttempt({
  initialQuiz,
  onFetchQuiz,
  onFetchAttempts,
  onFetchAttemptResult,
  onSubmitQuiz,
  onSubscribeCodeGrading,
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

  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [currentAttemptId, setCurrentAttemptId] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const fetchRef = useRef(onFetchQuiz);

  // Correction ASYNC des questions Code : à réception du verdict WS, on fusionne dans le résultat
  // courant (verdicts + score recalculés) si la tentative correspond. Abonnement pour toute la vie
  // de la vue ; le merge est un no-op tant qu'aucun résultat correspondant n'est affiché.
  useEffect(() => {
    if (!onSubscribeCodeGrading) return;
    return onSubscribeCodeGrading((attemptId, questions) => {
      setResult((prev) => mergeCodeResults(prev, attemptId, questions));
    });
  }, [onSubscribeCodeGrading]);
  const fetchAttemptsRef = useRef(onFetchAttempts);
  const fetchAttemptResultRef = useRef(onFetchAttemptResult);
  useEffect(() => {
    fetchRef.current = onFetchQuiz;
    fetchAttemptsRef.current = onFetchAttempts;
    fetchAttemptResultRef.current = onFetchAttemptResult;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const questionCount = quiz.questions?.length ?? 0;

  /** Charge le détail du quiz + l'historique ; ouvre sur la dernière tentative s'il y en a. */
  const reload = useCallback(async () => {
    const fetchQuiz = fetchRef.current;
    if (!fetchQuiz) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await fetchQuiz(initialQuiz.id);
      const history = fetchAttemptsRef.current ? await fetchAttemptsRef.current(initialQuiz.id) : [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      // Récap de la dernière tentative si elle existe (et qu'on sait la charger).
      const lastResult =
        last && fetchAttemptResultRef.current
          ? await fetchAttemptResultRef.current(initialQuiz.id, last.id)
          : null;
      if (!mountedRef.current) return;
      setQuiz(fetched);
      setAnswers(initAnswers(fetched));
      setTouched(new Set());
      setCurrentIndex(0);
      setAttempts(history);
      if (lastResult) {
        setResult(lastResult);
        setCurrentAttemptId(last ? last.id : null);
        setPhase('summary');
      } else {
        setResult(null);
        setCurrentAttemptId(null);
        setPhase('taking');
      }
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

  /** Recharge le détail du quiz en CONSERVANT les réponses en cours (fusion). Reste en passation. */
  const reloadKeepingAnswers = useCallback(async () => {
    const fetchQuiz = fetchRef.current;
    if (!fetchQuiz) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await fetchQuiz(initialQuiz.id);
      if (!mountedRef.current) return;
      setQuiz(fetched);
      setAnswers((prev) => mergeAnswers(fetched, prev));
      setTouched((prev) => {
        const ids = new Set((fetched.questions ?? []).map((q) => q.id));
        return new Set([...prev].filter((id) => ids.has(id)));
      });
      setCurrentIndex((i) =>
        Math.max(0, Math.min(i, Math.max((fetched.questions?.length ?? 0) - 1, 0)))
      );
      setResult(null);
      setCurrentAttemptId(null);
      setPhase('taking');
    } catch {
      if (!mountedRef.current) return;
      setLoadError(loadErrorMessage);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [initialQuiz.id, loadErrorMessage]);

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
      setCurrentAttemptId(graded.attemptId ?? null);
      setPhase('summary');
      // Met à jour l'historique avec la nouvelle tentative.
      const refresh = fetchAttemptsRef.current;
      if (refresh) {
        const history = await refresh(quiz.id);
        if (mountedRef.current) setAttempts(history);
      }
    } catch {
      if (!mountedRef.current) return;
      setSubmitError(submitErrorMessage);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [quiz, answers, onSubmitQuiz, submitErrorMessage]);

  /** Relance une nouvelle tentative (vide la saisie, repasse en passation). */
  const retry = useCallback(() => {
    setAnswers(initAnswers(quiz));
    setTouched(new Set());
    setCurrentIndex(0);
    setResult(null);
    setCurrentAttemptId(null);
    setSubmitError(null);
    setPhase('taking');
  }, [quiz]);

  /** Affiche le récap d'une tentative passée (charge son détail corrigé). */
  const selectAttempt = useCallback(async (attemptId: number) => {
    const fetchAttemptResult = fetchAttemptResultRef.current;
    if (!fetchAttemptResult) return;
    setLoading(true);
    try {
      const attemptResult = await fetchAttemptResult(quiz.id, attemptId);
      if (!mountedRef.current) return;
      setResult(attemptResult);
      setCurrentAttemptId(attemptId);
      setCurrentIndex(0);
      setPhase('summary');
    } catch {
      if (!mountedRef.current) return;
      setLoadError(loadErrorMessage);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [quiz.id, loadErrorMessage]);

  const reviewQuestion = useCallback((index: number) => {
    setCurrentIndex(index);
    setPhase('review');
  }, []);

  const backToSummary = useCallback(() => setPhase('summary'), []);

  const allowRetry = Boolean(quiz.allowRetry);
  const alreadySubmitted = !allowRetry && attempts.length > 0;

  return useMemo<QuizAttemptApi>(
    () => ({
      quiz,
      loading,
      loadError,
      reload: () => void reload(),
      reloadKeepingAnswers: () => void reloadKeepingAnswers(),
      phase,
      currentIndex,
      answers,
      touched,
      result,
      submitting,
      submitError,
      attempts,
      currentAttemptId,
      allowRetry,
      alreadySubmitted,
      retry,
      selectAttempt: (attemptId: number) => void selectAttempt(attemptId),
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
      reloadKeepingAnswers,
      phase,
      currentIndex,
      answers,
      touched,
      result,
      submitting,
      submitError,
      attempts,
      currentAttemptId,
      allowRetry,
      alreadySubmitted,
      retry,
      selectAttempt,
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
