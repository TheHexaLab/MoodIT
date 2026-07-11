import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Quiz } from '../../../types/domain';
import {
  type AttemptAnswers,
  type AttemptOutcome,
  type AttemptSummary,
  type FetchAttemptResultHandler,
  type FetchAttemptsHandler,
  type FetchQuizHandler,
  type QuestionAnswer,
  type QuizResult,
  type SubmitQuizHandler,
  initAnswers,
  mergeAnswers,
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

/**
 * Soumission « en vol » persistée en localStorage : permet de survivre à un RECHARGEMENT de
 * l'onglet pendant la CORRECTION asynchrone (l'état React est perdu, mais le serveur finit la
 * correction et enregistre la tentative). `attemptsBefore` = nb de tentatives avant l'envoi → au
 * remontage, une tentative en plus signale que la correction a abouti. `attemptId` (présent une
 * fois le 202 reçu) permet d'honorer le verdict WS ciblé (`quiz:attempt-*`) pendant l'attente.
 */
type PendingSubmission = { answers: AttemptAnswers; attemptsBefore: number; attemptId?: number };

const PENDING_KEY = (quizId: number) => `moodit:quiz-pending-submission:${quizId}`;

function readPending(quizId: number): PendingSubmission | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY(quizId));
    return raw ? (JSON.parse(raw) as PendingSubmission) : null;
  } catch {
    return null;
  }
}
function writePending(quizId: number, pending: PendingSubmission): void {
  try {
    localStorage.setItem(PENDING_KEY(quizId), JSON.stringify(pending));
  } catch {
    // quota / mode privé : la persistance est un bonus, on ignore l'échec.
  }
}
function clearPending(quizId: number): void {
  try {
    localStorage.removeItem(PENDING_KEY(quizId));
  } catch {
    // ignore
  }
}

/**
 * Brouillon de PASSATION persisté en localStorage : réponses en cours, questions déjà touchées
 * et position (index de la question affichée). Sauvegardé à chaque changement tant que la
 * tentative n'est pas soumise, il permet de RETROUVER où l'étudiant en était après un simple
 * rechargement de l'onglet (l'état React est perdu au refresh). Distinct de `PendingSubmission`,
 * qui ne couvre QUE l'instant de l'envoi.
 */
type DraftState = { answers: AttemptAnswers; touched: number[]; currentIndex: number };

const DRAFT_KEY = (quizId: number) => `moodit:quiz-draft:${quizId}`;

function readDraft(quizId: number): DraftState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(quizId));
    return raw ? (JSON.parse(raw) as DraftState) : null;
  } catch {
    return null;
  }
}
function writeDraft(quizId: number, draft: DraftState): void {
  try {
    localStorage.setItem(DRAFT_KEY(quizId), JSON.stringify(draft));
  } catch {
    // quota / mode privé : la persistance est un bonus, on ignore l'échec.
  }
}
function clearDraft(quizId: number): void {
  try {
    localStorage.removeItem(DRAFT_KEY(quizId));
  } catch {
    // ignore
  }
}

/** Ramène un index de question dans les bornes valides du quiz (0..n-1, ou 0 si vide). */
function clampIndex(index: number, quiz: Quiz): number {
  return Math.max(0, Math.min(index, Math.max((quiz.questions?.length ?? 0) - 1, 0)));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Attente du résultat de la correction ASYNCHRONE : normalement résolue par le push WebSocket
 * (`quiz:attempt-*`) en quelques secondes ; le polling de l'historique n'est qu'un FILET (WS
 * manqué / reconnexion). Plafond large car une correction de code peut durer (langages compilés,
 * plusieurs harnais) — on ne veut pas conclure à tort à un échec.
 */
const RECONCILE_TIMEOUT_MS = 120_000;
const RECONCILE_INTERVAL_MS = 1_500;

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
   * Verdict PUSH de la correction asynchrone (WebSocket), remonté depuis le Dashboard (room
   * `user:<id>`). Quand il concerne ce quiz et la tentative en cours d'attente, il résout
   * immédiatement l'attente (succès → résumé ; échec → l'étudiant peut renvoyer).
   */
  attemptOutcome?: AttemptOutcome | null;
  /** Message d'erreur affiché si le chargement échoue (label, surchargeable). */
  loadErrorMessage?: string;
  /** Message d'erreur affiché si la soumission échoue (label, surchargeable). */
  submitErrorMessage?: string;
  /**
   * Message affiché si la vérification du code est indisponible (503) : la tentative n'a pas été
   * enregistrée, l'étudiant peut renvoyer (label, surchargeable).
   */
  codeVerificationUnavailableMessage?: string;
  /**
   * Message affiché quand une soumission interrompue par un refresh n'a pas pu être confirmée
   * côté serveur après réconciliation (label, surchargeable).
   */
  submissionNotConfirmedMessage?: string;
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
  /** Efface l'erreur de soumission (fermeture du popup). */
  dismissSubmitError: () => void;
  /**
   * Réconciliation en cours : une soumission avait été lancée puis l'onglet a été rechargé ;
   * on sonde le serveur pour retrouver la tentative. Pilote le spinner plein quiz.
   */
  reconciling: boolean;

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
  attemptOutcome,
  loadErrorMessage = 'Impossible de charger le quiz. Réessayez.',
  submitErrorMessage = 'La soumission a échoué. Réessayez.',
  codeVerificationUnavailableMessage = "La vérification du code est momentanément indisponible. Votre tentative n'a pas été enregistrée : réessayez de l'envoyer.",
  submissionNotConfirmedMessage = "Ta tentative n'a pas pu être confirmée. Vérifie l'historique ou renvoie-la.",
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
  const [reconciling, setReconciling] = useState(false);

  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [currentAttemptId, setCurrentAttemptId] = useState<number | null>(null);

  const mountedRef = useRef(true);
  // Passe à `true` une fois le brouillon éventuel restauré (fin du premier `reload`) : évite que
  // l'effet de persistance n'ÉCRASE le brouillon stocké avec l'état pristine du montage.
  const hydratedRef = useRef(false);
  // Dernier verdict WS reçu pour CE quiz : consulté par la boucle d'attente (reconcilePending)
  // pour résoudre immédiatement une correction sans attendre le prochain sondage.
  const outcomeRef = useRef<AttemptOutcome | null>(null);
  useEffect(() => {
    if (attemptOutcome && attemptOutcome.quizId === initialQuiz.id) {
      outcomeRef.current = attemptOutcome;
    }
  }, [attemptOutcome, initialQuiz.id]);
  const fetchRef = useRef(onFetchQuiz);
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

  /**
   * Attend le résultat de la correction ASYNCHRONE d'une tentative (aussi utilisé pour réconcilier
   * une correction interrompue par un refresh). Résolu par le push WebSocket ciblé
   * (`outcomeRef`, prioritaire) ou, à défaut, par le sondage de l'historique jusqu'à ce qu'une
   * NOUVELLE tentative apparaisse. Timeout → reste en passation + message d'erreur.
   */
  const reconcilePending = useCallback(
    async (quizId: number, pending: PendingSubmission) => {
      setReconciling(true);
      const refresh = fetchAttemptsRef.current;
      const deadline = Date.now() + RECONCILE_TIMEOUT_MS;
      // Charge le résultat corrigé d'une tentative et ouvre le résumé.
      const openSummary = async (attemptId: number) => {
        clearPending(quizId);
        clearDraft(quizId);
        const lastResult = fetchAttemptResultRef.current
          ? await fetchAttemptResultRef.current(quizId, attemptId)
          : null;
        const history = refresh ? await refresh(quizId) : [];
        if (!mountedRef.current) return;
        setAttempts(history);
        if (lastResult) {
          setResult(lastResult);
          setCurrentAttemptId(attemptId);
          setPhase('summary');
        }
        setReconciling(false);
      };
      try {
        while (Date.now() < deadline) {
          // (1) Verdict WS ciblé reçu ? → résolution IMMÉDIATE (prioritaire sur le polling).
          const outcome = outcomeRef.current;
          if (outcome && pending.attemptId != null && outcome.attemptId === pending.attemptId) {
            outcomeRef.current = null;
            if (outcome.ok) {
              await openSummary(outcome.attemptId);
            } else {
              // Correction échouée (code inévaluable) : la tentative a été SUPPRIMÉE côté serveur,
              // l'étudiant peut renvoyer. On reste en passation.
              clearPending(quizId);
              if (!mountedRef.current) return;
              setReconciling(false);
              setSubmitError(codeVerificationUnavailableMessage);
            }
            return;
          }
          // (2) Filet : sondage de l'historique (WS manqué / reconnexion).
          await delay(RECONCILE_INTERVAL_MS);
          if (!mountedRef.current) return;
          const history = refresh ? await refresh(quizId) : [];
          if (!mountedRef.current) return;
          if (history.length > pending.attemptsBefore) {
            await openSummary(history[history.length - 1].id);
            return;
          }
        }
        // Timeout : la correction n'a pas été confirmée. On garde les réponses restaurées.
        clearPending(quizId);
        if (!mountedRef.current) return;
        setReconciling(false);
        setSubmitError(submissionNotConfirmedMessage);
      } catch {
        clearPending(quizId);
        if (!mountedRef.current) return;
        setReconciling(false);
        setSubmitError(submissionNotConfirmedMessage);
      }
    },
    [submissionNotConfirmedMessage, codeVerificationUnavailableMessage]
  );

  /** Charge le détail du quiz + l'historique ; ouvre sur la dernière tentative s'il y en a. */
  const reload = useCallback(async () => {
    const fetchQuiz = fetchRef.current;
    // Sans GET (mode purement local, chemin défensif), la persistance du brouillon reste inactive
    // (`hydratedRef` jamais posé) : rien à restaurer, on ne clobbere pas non plus l'existant.
    if (!fetchQuiz) return;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await fetchQuiz(initialQuiz.id);
      const history = fetchAttemptsRef.current ? await fetchAttemptsRef.current(initialQuiz.id) : [];
      if (!mountedRef.current) return;
      setQuiz(fetched);
      setTouched(new Set());
      setCurrentIndex(0);

      // Une soumission était-elle en vol lors d'un refresh ? (marqueur localStorage, pas encore
      // reflété par une nouvelle tentative) → restaure les réponses et réconcilie avec le serveur.
      const pending = readPending(initialQuiz.id);
      if (pending && history.length <= pending.attemptsBefore) {
        setAnswers(mergeAnswers(fetched, pending.answers));
        setAttempts(history);
        setResult(null);
        setCurrentAttemptId(null);
        setPhase('taking');
        setLoading(false);
        await reconcilePending(initialQuiz.id, pending);
        return;
      }
      if (pending) clearPending(initialQuiz.id);

      // Brouillon de passation restauré (réponses + position) : l'étudiant était en train de
      // répondre avant le rechargement. On le rétablit et on reste en passation — SAUF si la
      // tentative unique est déjà consommée (brouillon obsolète → on le jette).
      const draft = readDraft(initialQuiz.id);
      const consumed = !fetched.allowRetry && history.length > 0;
      if (draft && !consumed) {
        setAnswers(mergeAnswers(fetched, draft.answers));
        const ids = new Set((fetched.questions ?? []).map((q) => q.id));
        setTouched(new Set(draft.touched.filter((id) => ids.has(id))));
        setCurrentIndex(clampIndex(draft.currentIndex, fetched));
        setAttempts(history);
        setResult(null);
        setCurrentAttemptId(null);
        setPhase('taking');
        return;
      }
      if (draft) clearDraft(initialQuiz.id);

      setAnswers(initAnswers(fetched));
      setAttempts(history);
      const last = history.length > 0 ? history[history.length - 1] : null;
      // Récap de la dernière tentative si elle existe (et qu'on sait la charger).
      const lastResult =
        last && fetchAttemptResultRef.current
          ? await fetchAttemptResultRef.current(initialQuiz.id, last.id)
          : null;
      if (!mountedRef.current) return;
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
      // Hydratation terminée (y compris via un `return` anticipé de la branche pending/brouillon) :
      // l'effet de persistance peut désormais sauvegarder sans écraser le brouillon restauré.
      hydratedRef.current = true;
      if (mountedRef.current) setLoading(false);
    }
  }, [initialQuiz.id, loadErrorMessage, reconcilePending]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Persiste le brouillon de passation (réponses + touched + position) à chaque changement, tant
  // qu'on est en train de répondre. Gardé par `hydratedRef` pour ne pas écraser un brouillon stocké
  // avec l'état pristine du montage (avant restauration). En dehors de `taking` (résumé/révision),
  // rien n'est écrit : le brouillon d'une tentative en cours reste intact jusqu'à sa soumission.
  useEffect(() => {
    if (!hydratedRef.current || phase !== 'taking') return;
    // Clé = `initialQuiz.id` (l'id de la REQUÊTE, stable et identique à celui lu par `reload`).
    // NE PAS utiliser `quiz.id` (l'id du quiz FETCHÉ) : il peut différer (quiz du jour /
    // normalisation de canal), et on écrirait alors sous une clé que la restauration ne relit pas.
    writeDraft(initialQuiz.id, { answers, touched: [...touched], currentIndex });
  }, [initialQuiz.id, phase, answers, touched, currentIndex]);

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
    const usingServer = Boolean(onSubmitQuiz);
    const attemptsBefore = attempts.length;
    // Marqueur « en vol » AVANT le POST (clé sur `initialQuiz.id`, cf. effet de persistance) : si
    // l'onglet est rechargé pendant l'envoi OU la correction, le remontage réconciliera.
    if (usingServer) writePending(initialQuiz.id, { answers, attemptsBefore });
    try {
      if (onSubmitQuiz) {
        // Mode serveur ASYNCHRONE : le POST enregistre la tentative (202 + id) et rend la main ;
        // la correction (sandbox) tourne en tâche de fond. On attend le résultat via le push WS
        // (`quiz:attempt-*`) — le polling de l'historique n'est qu'un filet (cf. reconcilePending).
        const accepted = await onSubmitQuiz(toSubmission(quiz, answers));
        if (!mountedRef.current) return;
        // On connaît l'id : on peut honorer le verdict WS ciblé (et le rendre robuste au refresh).
        const pending = { answers, attemptsBefore, attemptId: accepted.attemptId };
        writePending(initialQuiz.id, pending);
        setSubmitting(false);
        await reconcilePending(initialQuiz.id, pending);
      } else {
        // Repli mock : correction locale instantanée (pas de voie async).
        const graded = gradeQuiz(quiz, answers);
        clearDraft(initialQuiz.id);
        if (!mountedRef.current) return;
        setResult(graded);
        setCurrentAttemptId(graded.attemptId ?? null);
        setPhase('summary');
      }
    } catch {
      // Échec du POST lui-même (réseau, 409 déjà soumis / en cours, 5xx) : rien « en vol ».
      if (usingServer) clearPending(initialQuiz.id);
      if (!mountedRef.current) return;
      setSubmitError(submitErrorMessage);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [quiz, initialQuiz.id, answers, attempts.length, onSubmitQuiz, submitErrorMessage, reconcilePending]);

  /** Relance une nouvelle tentative (vide la saisie, repasse en passation). */
  const retry = useCallback(() => {
    // Jette le brouillon de la tentative précédente ; l'effet de persistance en réécrira un neuf.
    clearDraft(initialQuiz.id);
    setAnswers(initAnswers(quiz));
    setTouched(new Set());
    setCurrentIndex(0);
    setResult(null);
    setCurrentAttemptId(null);
    setSubmitError(null);
    setPhase('taking');
  }, [quiz, initialQuiz.id]);

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
      dismissSubmitError: () => setSubmitError(null),
      reconciling,
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
      reconciling,
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
