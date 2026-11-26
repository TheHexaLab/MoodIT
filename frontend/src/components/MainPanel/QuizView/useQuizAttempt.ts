import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Quiz } from '../../../types/domain';
import {
  type AttemptAnswers,
  type AttemptOutcome,
  type AttemptSummary,
  isAwaitingReview,
  REVIEW_REASON,
  type FetchAttemptResultHandler,
  type FetchAttemptsHandler,
  type FetchQuizHandler,
  type QuestionAnswer,
  type QuizResult,
  type SubmitQuizHandler,
  SubmissionInProgressError,
  SubmissionRejectedError,
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
 * Sans lui (renvoi refusé en 409 : correction déjà en cours, id inconnu), `knownAttemptIds` =
 * tentatives déjà connues : tout verdict d'une AUTRE tentative de ce quiz est celui de la
 * correction en cours (une seule à la fois par étudiant et par quiz).
 */
type PendingSubmission = {
  answers: AttemptAnswers;
  attemptsBefore: number;
  attemptId?: number;
  knownAttemptIds?: number[];
  /**
   * Instant de l'envoi (ms), écrit AVANT le POST : l'échéance d'attente en part, et non du
   * montage — sinon un marqueur abandonné (correction en échec reçue par personne) relançait
   * toute l'attente (RECONCILE_CEILING_MS) à chaque retour sur le quiz, même des jours plus tard.
   */
  submittedAt?: number;
};

/**
 * Le verdict poussé est-il celui de la soumission attendue ? Par son id s'il est connu ; sinon,
 * tout verdict d'une tentative absente de `knownAttemptIds`. Sans l'un ni l'autre (marqueur d'un
 * ancien format), AUCUN : on ne sait pas distinguer la nouvelle tentative d'une ancienne.
 */
function outcomeMatches(pending: PendingSubmission, outcome: AttemptOutcome): boolean {
  if (pending.attemptId != null) return outcome.attemptId === pending.attemptId;
  if (!pending.knownAttemptIds) return false;
  return !pending.knownAttemptIds.includes(outcome.attemptId);
}

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
/**
 * Brouillon vierge : aucune question touchée, première question affichée. Il n'apporte rien à
 * restaurer, et ne doit surtout pas primer sur le résumé d'une tentative déjà faite (un montage
 * interrompu, ex. restauration du dernier emplacement puis clic ailleurs, en écrivait un).
 */
function isPristineDraft(draft: DraftState): boolean {
  return (draft.touched?.length ?? 0) === 0 && (draft.currentIndex ?? 0) === 0;
}
function clearDraft(quizId: number): void {
  try {
    localStorage.removeItem(DRAFT_KEY(quizId));
  } catch {
    // ignore
  }
}

/**
 * La tentative d'une soumission en vol est-elle apparue dans l'historique (corrigée ou à revoir ;
 * il exclut les tentatives en correction) ? Par son id s'il est connu ; sinon, la PLUS RÉCENTE
 * des tentatives absentes des connues à l'envoi (tentatives + dernier verdict vu) — une liste
 * périmée (autre appareil) peut en laisser une plus ancienne inconnue ; marqueur d'ancien format
 * seulement : une tentative de plus qu'avant l'envoi.
 */
function landedAttempt(
  pending: PendingSubmission,
  history: AttemptSummary[]
): AttemptSummary | undefined {
  if (pending.attemptId != null) return history.find((a) => a.id === pending.attemptId);
  const known = pending.knownAttemptIds;
  if (known) {
    return history
      .filter((a) => !known.includes(a.id))
      .reduce<AttemptSummary | undefined>(
        (latest, a) =>
          !latest || a.attemptNo > latest.attemptNo || (a.attemptNo === latest.attemptNo && a.id > latest.id)
            ? a
            : latest,
        undefined
      );
  }
  return history.length > pending.attemptsBefore ? history[history.length - 1] : undefined;
}

/** Ramène un index de question dans les bornes valides du quiz (0..n-1, ou 0 si vide). */
function clampIndex(index: number, quiz: Quiz): number {
  return Math.max(0, Math.min(index, Math.max((quiz.questions?.length ?? 0) - 1, 0)));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Attente du résultat de la correction ASYNCHRONE : normalement résolue par le push WebSocket
 * (`quiz:attempt-*`) en quelques secondes ; le sondage de l'historique n'est qu'un FILET (WS
 * manqué / reconnexion). Une correction de code peut durer bien plus que 2 min (#116). Core
 * attend chaque appel d'évaluation jusqu'à `ExecutionClient.readTimeoutMs` — au pire ≈ 40 min en
 * SQL (≥ 2 harnais), ≈ 28 min en interprété, ≈ 25 min en compilé (file d'execution-service,
 * temps limite jusqu'à 60 s par harnais, budget de 15 min des interprétés, mur de 15 min des
 * compilés, vie du conteneur sous un démon lent) — et corrige les questions Code UNE APRÈS
 * L'AUTRE : K questions, jusqu'à K fois ce pire cas, sans compter sa propre file de correction.
 * Aucun plafond fixe ne couvre tout. Conclure trop tôt à un échec faisait renvoyer une tentative
 * encore en correction (409) et perdre son verdict. D'où :
 * - un sondage rapide (1,5 s) les deux premières minutes, puis lent (15 s), interrompu dès que le
 *   verdict poussé arrive ;
 * - au-delà de RECONCILE_CEILING_MS (45 min : un appel SQL au pire, plus une marge), l'attente
 *   BLOQUANTE cesse — ce n'est pas une borne de la correction : la vue dit qu'elle prend plus de
 *   temps que prévu, sans conclure à un échec. Un verdict poussé plus tard est encore consommé,
 *   et « Réessayer » pendant une correction encore en cours reçoit un 409 « en_cours » qui
 *   relance l'attente, sans perte.
 */
const RECONCILE_CEILING_MS = 45 * 60_000;
const RECONCILE_FAST_MS = 120_000;
const RECONCILE_INTERVAL_MS = 1_500;
const RECONCILE_SLOW_INTERVAL_MS = 15_000;
/** Pas de l'attente entre deux sondages : un verdict poussé n'attend pas la fin de l'intervalle. */
const OUTCOME_CHECK_MS = 250;

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
   * `user:<id>`), qui garde le DERNIER verdict de CHAQUE quiz et passe celui du quiz ouvert —
   * même reçu vue fermée. Quand il concerne la tentative en cours d'attente, il résout
   * immédiatement l'attente (succès → résumé ; échec → l'étudiant peut renvoyer). Le Dashboard ne
   * le vide jamais : le hook ne fait que l'ignorer une fois traité (refs locales).
   */
  attemptOutcome?: AttemptOutcome | null;
  /** Message d'erreur affiché si le chargement échoue (label, surchargeable). */
  loadErrorMessage?: string;
  /** Message d'erreur affiché si la soumission échoue (label, surchargeable). */
  submitErrorMessage?: string;
  /**
   * Message affiché quand le serveur REFUSE la soumission sans dire pourquoi (400 illisible) :
   * renvoyer la même réponse ne servirait à rien (label, surchargeable).
   */
  submitRejectedMessage?: string;
  /** Message d'une soumission trop volumineuse (413 du gateway) — label, surchargeable. */
  submitTooLargeMessage?: string;
  /**
   * Message d'un refus temporaire (409 de cause « relance », quiz AVEC reprise : l'enseignant
   * relance la correction de la tentative précédente) — label, surchargeable.
   */
  submitRegradingMessage?: string;
  /**
   * Message d'un refus définitif (409 « déjà soumis » : tentative unique déjà consommée, ex. dans
   * un autre onglet) — label, surchargeable. La vue rouvre ensuite le résumé.
   */
  submitAlreadySubmittedMessage?: string;
  /**
   * Message affiché si la vérification du code est indisponible (503) : la tentative n'a pas été
   * enregistrée, l'étudiant peut renvoyer (label, surchargeable).
   */
  codeVerificationUnavailableMessage?: string;
  /**
   * Message affiché quand la correction d'une soumission n'est pas encore confirmée au plafond
   * d'attente (RECONCILE_CEILING_MS — pas une borne de la correction, qui peut tourner encore) :
   * réponses restaurées. N'affirme pas un échec : « Réessayer » relit d'abord l'historique (et
   * ouvre la tentative si elle y est), sinon renvoie — un 409 « en_cours » relance l'attente.
   * (La lecture du résultat en échec après un verdict a son propre message : resultUnavailable.)
   * Label, surchargeable.
   */
  submissionNotConfirmedMessage?: string;
  /**
   * Message affiché quand la correction a abouti (verdict, ou tentative dans l'historique) mais
   * que la lecture de son résultat a échoué : la tentative EST enregistrée ; « Réessayer » relit
   * l'historique et ouvre son résumé, sans la renvoyer (label, surchargeable).
   */
  resultUnavailableMessage?: string;
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
  /**
   * L'erreur de soumission est un REFUS du serveur (400, 413, 409 « relance » ou « déjà soumis »,
   * cf. SubmissionRejectedError) : renvoyer les mêmes réponses tout de suite serait refusé de
   * nouveau, l'écran ne propose donc pas « Réessayer ».
   */
  submitRejected: boolean;
  /** Efface l'erreur de soumission (fermeture du popup). */
  dismissSubmitError: () => void;
  /**
   * Attente de la correction d'une soumission (après le 202, après un 409 « en cours », ou au
   * remontage si une soumission était en vol) : verdict poussé ou sondage de l'historique, jusqu'à
   * RECONCILE_CEILING_MS. Pilote le spinner plein quiz et son texte ; aucun nouvel envoi pendant.
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
   * La tentative affichée attend l'ENSEIGNANT (#116) : sa correction automatique a échoué et core
   * l'a gardée « à revoir » (règle : cf. REVIEW_REASON, quizAttempt.ts). Elle compte comme soumise,
   * mais n'a ni note ni corrigé : la vue affiche un message à la place du résumé.
   */
  awaitingReview: boolean;
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
  submitRejectedMessage = 'La soumission a été refusée : vérifiez vos réponses avant de la renvoyer.',
  submitTooLargeMessage = 'Réponses trop volumineuses : réduisez le code soumis, puis renvoyez.',
  submitRegradingMessage = 'Votre tentative précédente est en cours de recorrection par votre enseignant. Réessayez plus tard : vos réponses sont conservées.',
  submitAlreadySubmittedMessage = 'Ce quiz a déjà été soumis.',
  codeVerificationUnavailableMessage = "La vérification du code est momentanément indisponible. Votre tentative n'a pas été enregistrée : réessayez de l'envoyer.",
  submissionNotConfirmedMessage = "La correction prend plus de temps que prévu. Réessayez pour reprendre l'attente : vos réponses sont conservées.",
  resultUnavailableMessage = "Votre tentative est enregistrée, mais son résultat n'a pas pu être chargé. Réessayez pour l'afficher.",
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
  const [submitRejected, setSubmitRejected] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [currentAttemptId, setCurrentAttemptId] = useState<number | null>(null);
  const [awaitingReview, setAwaitingReview] = useState(false);

  const mountedRef = useRef(true);
  // Passe à `true` une fois le brouillon éventuel restauré (fin du premier `reload`) : évite que
  // l'effet de persistance n'ÉCRASE le brouillon stocké avec l'état pristine du montage.
  const hydratedRef = useRef(false);
  // Dernier verdict WS reçu pour CE quiz : consulté par la boucle d'attente (reconcilePending)
  // pour résoudre immédiatement une correction sans attendre le prochain sondage.
  const outcomeRef = useRef<AttemptOutcome | null>(null);
  // Id du DERNIER verdict vu pour ce quiz (jamais vidé, contrairement à `outcomeRef`). Le
  // Dashboard garde le dernier verdict de ce quiz, même vue fermée, et le représente au montage : à
  // l'envoi, cet id rejoint les tentatives connues du marqueur, pour qu'un verdict d'AVANT l'envoi
  // (ex. échec d'une tentative supprimée, absente de l'historique) ne conclue jamais l'attente.
  const lastSeenOutcomeIdRef = useRef<number | null>(null);
  // Attente d'une correction en cours (reconcilePending) : `submit` refuse un second envoi, qui
  // lancerait une seconde boucle, écraserait le marqueur et pourrait consommer le verdict.
  const waitingRef = useRef(false);
  useEffect(() => {
    if (attemptOutcome && attemptOutcome.quizId === initialQuiz.id) {
      outcomeRef.current = attemptOutcome;
      lastSeenOutcomeIdRef.current = attemptOutcome.attemptId;
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

  // Soumission dont l'attente n'a pas conclu (plafond sans verdict, ou résultat illisible), avec
  // le message affiché à ce moment : son verdict poussé plus tard est encore consommé (cf. l'effet
  // plus bas), et « Réessayer » la relit avant tout renvoi (cf. submit), qui rétablit ce message
  // si l'historique est illisible.
  const lateRef = useRef<{ pending: PendingSubmission; message: string } | null>(null);

  /**
   * Attend le résultat de la correction ASYNCHRONE d'une tentative (aussi utilisé pour réconcilier
   * une correction interrompue par un refresh, et après un renvoi refusé en 409). Résolu par le
   * push WebSocket (`outcomeRef`, prioritaire) ou, à défaut, par le sondage de l'historique
   * jusqu'à ce qu'une NOUVELLE tentative apparaisse. Pas d'échec à une échéance courte (cf.
   * RECONCILE_CEILING_MS) ; un sondage en échec (réseau) n'interrompt pas l'attente.
   */
  const reconcilePending = useCallback(
    async (quizId: number, pending: PendingSubmission) => {
      waitingRef.current = true;
      try {
        await waitForGrading(quizId, pending);
      } finally {
        waitingRef.current = false;
      }

      async function waitForGrading(quizId: number, pending: PendingSubmission) {
        setReconciling(true);
        const refresh = fetchAttemptsRef.current;
        // Échéance comptée depuis l'ENVOI (marqueur), pas depuis ce montage. Un retour après
        // l'échéance conclut aussitôt (l'historique vient d'être relu par `reload`) : « non
        // confirmée », renvoi possible — sûr, puisqu'un renvoi pendant une correction encore en
        // cours reçoit un 409 « en_cours » et rejoint l'attente. Marqueur d'ANCIEN format (sans
        // date, âge inconnu) : tenu pour expiré. Date dans le futur (horloge qui a reculé) :
        // ramenée à maintenant, sans quoi l'attente pouvait durer bien plus que le plafond.
        const started = Math.min(pending.submittedAt ?? 0, Date.now());
        const ceiling = started + RECONCILE_CEILING_MS;
        // Échéance déjà passée au départ (retour tardif sur le quiz) : l'attente conclut aussitôt.
        const expiredAtStart = Date.now() >= ceiling;
        const takeOutcome = () => {
          const outcome = outcomeRef.current;
          return outcome && outcomeMatches(pending, outcome) ? outcome : null;
        };
        // Charge le résultat corrigé d'une tentative et ouvre le résumé — ou, si elle attend
        // l'enseignant (#116), le message « à revoir » : elle n'a ni note ni corrigé.
        const openSummary = async (attemptId: number) => {
          clearPending(quizId);
          clearDraft(quizId);
          const history = refresh ? await refresh(quizId) : [];
          if (!mountedRef.current) return;
          // `attempts` n'est posé qu'une fois le résumé prêt : posé avant une lecture du résultat
          // en échec, il grisait « Soumettre » (« déjà soumis », quiz sans reprise) sans plus
          // rien qui mène au résultat — « Réessayer » doit pouvoir le relire.
          if (isAwaitingReview(history.find((a) => a.id === attemptId))) {
            setAttempts(history);
            setResult(null);
            setCurrentAttemptId(attemptId);
            setAwaitingReview(true);
            setPhase('summary');
            setReconciling(false);
            return;
          }
          const lastResult = fetchAttemptResultRef.current
            ? await fetchAttemptResultRef.current(quizId, attemptId)
            : null;
          if (!mountedRef.current) return;
          if (lastResult) {
            setAttempts(history);
            setResult(lastResult);
            setCurrentAttemptId(attemptId);
            setPhase('summary');
          }
          setReconciling(false);
        };
        // Verdict poussé de la soumission attendue → résumé, ou échec (tentative supprimée).
        const settle = async (outcome: AttemptOutcome) => {
          outcomeRef.current = null;
          if (outcome.ok || outcome.reason === REVIEW_REASON) {
            // `review` : la tentative est GARDÉE (à revoir par l'enseignant), pas supprimée.
            await openSummary(outcome.attemptId);
          } else {
            // Correction échouée (code inévaluable) : la tentative a été SUPPRIMÉE côté serveur,
            // l'étudiant peut renvoyer. On reste en passation.
            clearPending(quizId);
            if (!mountedRef.current) return;
            setReconciling(false);
            setSubmitError(codeVerificationUnavailableMessage);
          }
        };
        try {
          while (Date.now() < ceiling) {
            // (1) Verdict WS ciblé reçu ? → résolution IMMÉDIATE (prioritaire sur le polling).
            const outcome = takeOutcome();
            if (outcome) {
              await settle(outcome);
              return;
            }
            // (2) Filet : sondage de l'historique (WS manqué / reconnexion), rapide puis lent.
            const interval =
              Date.now() - started < RECONCILE_FAST_MS ? RECONCILE_INTERVAL_MS : RECONCILE_SLOW_INTERVAL_MS;
            for (let waited = 0; waited < interval && !takeOutcome(); waited += OUTCOME_CHECK_MS) {
              await delay(OUTCOME_CHECK_MS);
              if (!mountedRef.current) return;
            }
            if (takeOutcome()) continue;
            let history: AttemptSummary[];
            try {
              history = refresh ? await refresh(quizId) : [];
            } catch {
              continue; // sondage en échec (réseau) : transitoire, la correction tourne toujours
            }
            if (!mountedRef.current) return;
            // Conclusion par la tentative ATTENDUE (cf. landedAttempt), pas par la longueur : une
            // liste périmée (autre appareil) la faisait conclure sur une tentative plus ancienne.
            const landed = landedAttempt(pending, history);
            if (landed) {
              await openSummary(landed.id);
              return;
            }
          }
          // Un verdict arrivé pendant la DERNIÈRE lecture de l'historique : l'effet des verdicts
          // tardifs a déjà couru (lateRef encore vide) — on le traite ici, sinon il était perdu.
          const lastOutcome = takeOutcome();
          if (lastOutcome) {
            await settle(lastOutcome);
            return;
          }
          // Plafond atteint sans verdict : l'attente bloquante cesse, réponses restaurées et renvoi
          // possible. Le verdict, s'il arrive encore, sera consommé (lateRef). Le marqueur, lui,
          // est GARDÉ (expiré) s'il vient d'expirer : effacé, le remontage restaurait le brouillon
          // de passation au lieu du résultat, et « Soumettre » créait une seconde tentative. Au
          // montage suivant, soit la tentative est dans l'historique (résumé), soit l'attente
          // conclut aussitôt — et c'est alors qu'il est effacé.
          if (expiredAtStart) clearPending(quizId);
          if (!mountedRef.current) return;
          lateRef.current = { pending, message: submissionNotConfirmedMessage };
          setReconciling(false);
          setSubmitError(submissionNotConfirmedMessage);
        } catch {
          // Correction ABOUTIE (verdict, ou tentative dans l'historique), mais la lecture de son
          // résultat a échoué : la tentative est enregistrée. « Réessayer » la relira (lateRef)
          // au lieu de la renvoyer — sur un quiz avec reprise, un renvoi en créait une seconde.
          clearPending(quizId);
          if (!mountedRef.current) return;
          lateRef.current = { pending, message: resultUnavailableMessage };
          setReconciling(false);
          setSubmitError(resultUnavailableMessage);
        }
      }
    },
    [submissionNotConfirmedMessage, codeVerificationUnavailableMessage, resultUnavailableMessage]
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
      setAwaitingReview(false);

      // Une soumission était-elle en vol lors d'un refresh ? (marqueur localStorage, pas encore
      // reflété par une nouvelle tentative) → restaure les réponses et réconcilie avec le serveur.
      const pending = readPending(initialQuiz.id);
      if (pending && !landedAttempt(pending, history)) {
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

      // Une soumission était en vol ET sa tentative est dans l'historique (sinon on serait passé
      // par la branche de réconciliation ci-dessus) : elle a ABOUTI pendant le refresh. La tentative est enregistrée
      // → le brouillon est obsolète, et on doit ouvrir le RÉSUMÉ, pas rouvrir le brouillon (bug
      // observé sur les quiz avec reprise, où `consumed` reste faux).
      const submissionLanded = pending != null;
      if (submissionLanded) clearDraft(initialQuiz.id);

      // Brouillon de passation restauré (réponses + position) : l'étudiant était en train de
      // répondre avant le rechargement. On le rétablit et on reste en passation — SAUF si la
      // tentative unique est déjà consommée OU si une soumission vient d'aboutir (brouillon obsolète).
      const stored = submissionLanded ? null : readDraft(initialQuiz.id);
      const draft = stored && !isPristineDraft(stored) ? stored : null;
      if (stored && !draft) clearDraft(initialQuiz.id);
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
      // Dernière tentative à revoir par l'enseignant (#116) : pas de corrigé à charger.
      if (last && isAwaitingReview(last)) {
        setResult(null);
        setCurrentAttemptId(last.id);
        setAwaitingReview(true);
        setPhase('summary');
        return;
      }
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

  // Verdict poussé APRÈS le plafond d'attente (correction très longue) : il est encore consommé.
  // Corrigée ou gardée à revoir → on recharge, ce qui ouvre la tentative (dernière de
  // l'historique) ; le brouillon de passation, devenu obsolète, est jeté d'abord. Échec → la
  // tentative a été supprimée : message de vérification impossible, l'étudiant renvoie.
  const settleLateOutcome = useCallback(
    async (outcome: AttemptOutcome) => {
      if (outcome.ok || outcome.reason === REVIEW_REASON) {
        clearDraft(initialQuiz.id);
        setSubmitError(null);
        // `reload` voit le marqueur (gardé au plafond) et la tentative dans l'historique : il
        // efface l'un et ouvre l'autre.
        await reload();
      } else {
        // Tentative supprimée : le marqueur gardé au plafond n'attend plus rien.
        clearPending(initialQuiz.id);
        setSubmitError(codeVerificationUnavailableMessage);
      }
    },
    [initialQuiz.id, reload, codeVerificationUnavailableMessage]
  );
  useEffect(() => {
    const late = lateRef.current;
    if (
      !late ||
      !attemptOutcome ||
      attemptOutcome.quizId !== initialQuiz.id ||
      !outcomeMatches(late.pending, attemptOutcome)
    ) {
      return;
    }
    lateRef.current = null;
    outcomeRef.current = null;
    void settleLateOutcome(attemptOutcome);
  }, [attemptOutcome, initialQuiz.id, settleLateOutcome]);

  // Vue courante, relue par les lectures asynchrones (mise à jour hors rendu).
  const shownRef = useRef({ awaiting: awaitingReview, attemptId: currentAttemptId });
  useEffect(() => {
    shownRef.current = { awaiting: awaitingReview, attemptId: currentAttemptId };
  });

  // Tentative à revoir (#116) affichée : l'enseignant peut relancer sa correction à tout moment.
  // Son verdict arrive par le même événement qu'une soumission, alors qu'aucune n'est en cours
  // ici (reconcilePending ne l'attend pas). On affiche le résultat de CETTE tentative — `reload`
  // ouvrait la dernière de l'historique, pas forcément celle que l'étudiant regardait —, sans
  // écran de chargement : la barre reste montée et le focus clavier sur sa puce. Rechargement
  // complet en repli si l'une des deux lectures échoue.
  useEffect(() => {
    if (
      !awaitingReview ||
      !attemptOutcome?.ok ||
      attemptOutcome.quizId !== initialQuiz.id ||
      attemptOutcome.attemptId !== currentAttemptId
    ) {
      return;
    }
    const attemptId = attemptOutcome.attemptId;
    const refresh = fetchAttemptsRef.current;
    const fetchResult = fetchAttemptResultRef.current;
    if (!refresh || !fetchResult) {
      void reload();
      return;
    }
    // L'étudiant a pu changer de vue pendant les deux lectures (autre puce, « Refaire ») : on
    // n'écrase alors ni sa vue ni son choix.
    const stillShown = () =>
      mountedRef.current && shownRef.current.awaiting && shownRef.current.attemptId === attemptId;
    void (async () => {
      try {
        const [list, attemptResult] = await Promise.all([
          refresh(initialQuiz.id),
          fetchResult(initialQuiz.id, attemptId),
        ]);
        if (!stillShown()) return;
        setAttempts(list);
        setResult(attemptResult);
        setCurrentAttemptId(attemptId);
        setCurrentIndex(0);
        setAwaitingReview(false);
        setPhase('summary');
      } catch {
        if (stillShown()) void reload();
      }
    })();
  }, [attemptOutcome, awaitingReview, currentAttemptId, initialQuiz.id, reload]);

  // Relance réussie d'une tentative à revoir qui n'est PAS celle affichée (l'étudiant regarde
  // une autre tentative) : seule la barre des tentatives se met à jour. Sans cela, la puce
  // restait « à revoir » et son clic affichait encore le message d'attente.
  useEffect(() => {
    if (
      !attemptOutcome?.ok ||
      attemptOutcome.quizId !== initialQuiz.id ||
      (awaitingReview && attemptOutcome.attemptId === currentAttemptId) ||
      !attempts.some((a) => a.id === attemptOutcome.attemptId && isAwaitingReview(a))
    ) {
      return;
    }
    const refresh = fetchAttemptsRef.current;
    if (!refresh) return;
    void (async () => {
      try {
        const list = await refresh(initialQuiz.id);
        if (mountedRef.current) setAttempts(list);
      } catch {
        // Barre laissée telle quelle : le prochain rechargement la recale.
      }
    })();
  }, [attemptOutcome, attempts, awaitingReview, currentAttemptId, initialQuiz.id]);

  // Persiste le brouillon de passation (réponses + touched + position) à chaque changement, tant
  // qu'on est en train de répondre. Gardé par `hydratedRef` pour ne pas écraser un brouillon stocké
  // avec l'état pristine du montage (avant restauration). En dehors de `taking` (résumé/révision),
  // rien n'est écrit : le brouillon d'une tentative en cours reste intact jusqu'à sa soumission.
  useEffect(() => {
    if (!hydratedRef.current || phase !== 'taking') return;
    // Rien de saisi ni de parcouru : pas de brouillon (cf. isPristineDraft).
    if (touched.size === 0 && currentIndex === 0) return;
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

  // Envoi en cours (POST, puis attente de la correction) : un second appel est ignoré.
  const sendingRef = useRef(false);
  const submit = useCallback(async () => {
    // Garde : « Soumettre » est désactivé pendant l'envoi et l'attente, mais un double appel
    // (clavier, « Réessayer ») lancerait une seconde boucle et écraserait le marqueur « en vol ».
    if (sendingRef.current || waitingRef.current) return;
    sendingRef.current = true;
    setSubmitError(null);
    setSubmitRejected(false);
    setSubmitting(true);
    // Soumission restée sans conclusion (plafond, ou résultat illisible) : « Réessayer » la
    // vérifie d'abord (cf. plus bas), puis elle n'est plus attendue ici — un 409 « en_cours »,
    // si sa correction tourne encore, rejoint son attente.
    const late = lateRef.current;
    lateRef.current = null;
    const usingServer = Boolean(onSubmitQuiz);
    const attemptsBefore = attempts.length;
    // Tentatives connues + dernier verdict vu (cf. lastSeenOutcomeIdRef) : seul un verdict d'une
    // AUTRE tentative pourra conclure l'attente d'un envoi dont l'id est inconnu.
    const knownAttemptIds = attempts.map((a) => a.id);
    const lastSeen = lastSeenOutcomeIdRef.current;
    if (lastSeen != null && !knownAttemptIds.includes(lastSeen)) knownAttemptIds.push(lastSeen);
    const submittedAt = Date.now();
    try {
      // « Réessayer » après une attente non conclue : la tentative attendue a peut-être abouti
      // depuis. On relit d'abord l'historique et on OUVRE son résumé si elle y est (sur un quiz
      // avec reprise, un renvoi en créait une seconde) ; sinon seulement, on renvoie.
      if (late && onSubmitQuiz) {
        let history: AttemptSummary[];
        try {
          history = fetchAttemptsRef.current ? await fetchAttemptsRef.current(initialQuiz.id) : [];
        } catch {
          // Historique illisible : pas de renvoi à l'aveugle ; l'étudiant réessaiera. Le message
          // d'origine est rétabli (« prend plus de temps » ou « résultat illisible »).
          if (!mountedRef.current) return;
          lateRef.current = late;
          setSubmitError(late.message);
          return;
        }
        if (!mountedRef.current) return;
        const landed = landedAttempt(late.pending, history);
        if (landed) {
          clearPending(initialQuiz.id);
          await settleLateOutcome({ quizId: initialQuiz.id, attemptId: landed.id, ok: true });
          return;
        }
        // Verdict poussé PENDANT cette relecture : l'effet des verdicts tardifs ne l'a pas vu
        // (lateRef vidé plus haut). Il conclut ici — sans quoi le renvoi ci-dessous créait, sur
        // un quiz avec reprise, une seconde tentative.
        const pushed = outcomeRef.current;
        if (pushed && outcomeMatches(late.pending, pushed)) {
          outcomeRef.current = null;
          await settleLateOutcome(pushed);
          return;
        }
      }
      // Marqueur « en vol » AVANT le POST (clé sur `initialQuiz.id`, cf. effet de persistance) :
      // si l'onglet est rechargé pendant l'envoi OU la correction, le remontage réconciliera. Les
      // tentatives déjà connues y figurent : sans id (vue démontée pendant le POST), seul le
      // verdict d'une AUTRE tentative pourra conclure (cf. outcomeMatches).
      if (usingServer) {
        writePending(initialQuiz.id, { answers, attemptsBefore, knownAttemptIds, submittedAt });
      }
      if (onSubmitQuiz) {
        // Mode serveur ASYNCHRONE : le POST enregistre la tentative (202 + id) et rend la main ;
        // la correction (sandbox) tourne en tâche de fond. On attend le résultat via le push WS
        // (`quiz:attempt-*`) — le polling de l'historique n'est qu'un filet (cf. reconcilePending).
        const accepted = await onSubmitQuiz(toSubmission(quiz, answers));
        if (!mountedRef.current) return;
        // On connaît l'id : on peut honorer le verdict WS ciblé (et le rendre robuste au refresh).
        const pending = { answers, attemptsBefore, attemptId: accepted.attemptId, submittedAt };
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
    } catch (e) {
      // 409 de cause « en_cours » : une tentative est déjà en correction (renvoi après le plafond,
      // autre onglet). Pas un échec : on rejoint l'attente, qui ouvre le résumé dès que la
      // tentative apparaît (ou que son verdict est poussé). Seul conclut le verdict d'une
      // tentative absente de `knownAttemptIds` (tentatives connues + dernier verdict vu à
      // l'envoi) — y compris celui arrivé PENDANT le POST, qu'il ne faut donc pas jeter.
      // (« Déjà soumis » et « relance » : autres 409, traités plus bas comme des refus.)
      if (usingServer && e instanceof SubmissionInProgressError) {
        if (!mountedRef.current) return;
        // La liste de la vue peut être PÉRIMÉE (autre appareil) : la tentative en correction
        // n'étant pas dans l'historique, on le relit pour ne compter comme « attendue » que ce qui
        // y manque encore. Relecture en échec : la liste de la vue, faute de mieux.
        let fresh: AttemptSummary[] | null;
        try {
          fresh = fetchAttemptsRef.current ? await fetchAttemptsRef.current(initialQuiz.id) : null;
        } catch {
          fresh = null;
        }
        if (!mountedRef.current) return;
        const known = fresh ? fresh.map((a) => a.id) : knownAttemptIds;
        if (lastSeen != null && !known.includes(lastSeen)) known.push(lastSeen);
        // Échéance : depuis ce renvoi (le début de la correction en cours est inconnu).
        const pending = {
          answers,
          attemptsBefore: fresh ? fresh.length : attemptsBefore,
          knownAttemptIds: known,
          submittedAt: Date.now(),
        };
        writePending(initialQuiz.id, pending);
        setSubmitting(false);
        await reconcilePending(initialQuiz.id, pending);
        return;
      }
      // Échec du POST lui-même (refus, réseau, 5xx) : rien « en vol ».
      if (usingServer) clearPending(initialQuiz.id);
      if (!mountedRef.current) return;
      // Refus (400, 413, 409 « relance » ou « déjà soumis ») : le message dit quoi faire,
      // « réessayez » non. Le brouillon de passation reste en place (rien n'est enregistré par cet
      // envoi) — sauf « déjà soumis », où `reload` le jette pour ouvrir la tentative consommée.
      if (e instanceof SubmissionRejectedError) {
        setSubmitRejected(true);
        setSubmitError(
          e.reason === 'tooLarge'
            ? submitTooLargeMessage
            : e.reason === 'regrading'
              ? submitRegradingMessage
              : e.reason === 'alreadySubmitted'
                ? submitAlreadySubmittedMessage
                : e.message || submitRejectedMessage
        );
        // Déjà soumis : la tentative consommée est dans l'historique (corrigée, ou à revoir —
        // relance comprise), jamais seulement « en correction » (core répondrait alors
        // « en_cours ») ; recharger ouvre donc son résumé, sans boucle (aucun envoi).
        if (e.reason === 'alreadySubmitted') void reload();
      } else {
        setSubmitError(submitErrorMessage);
      }
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [
    quiz, initialQuiz.id, answers, attempts, onSubmitQuiz, submitErrorMessage,
    submitRejectedMessage, submitTooLargeMessage, submitRegradingMessage,
    submitAlreadySubmittedMessage, reconcilePending, reload, settleLateOutcome,
  ]);

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
    setAwaitingReview(false);
    setPhase('taking');
  }, [quiz, initialQuiz.id]);

  /** Affiche le récap d'une tentative passée (charge son détail corrigé). */
  const selectAttempt = useCallback(async (attemptId: number) => {
    // Tentative à revoir (#116) : aucun corrigé à charger, on affiche le message d'attente.
    if (isAwaitingReview(attempts.find((a) => a.id === attemptId))) {
      setResult(null);
      setCurrentAttemptId(attemptId);
      setAwaitingReview(true);
      setPhase('summary');
      return;
    }
    const fetchAttemptResult = fetchAttemptResultRef.current;
    if (!fetchAttemptResult) return;
    setLoading(true);
    try {
      const attemptResult = await fetchAttemptResult(quiz.id, attemptId);
      if (!mountedRef.current) return;
      setResult(attemptResult);
      setCurrentAttemptId(attemptId);
      setCurrentIndex(0);
      setAwaitingReview(false);
      setPhase('summary');
    } catch {
      if (!mountedRef.current) return;
      setLoadError(loadErrorMessage);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [quiz.id, loadErrorMessage, attempts]);

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
      submitRejected,
      dismissSubmitError: () => {
        setSubmitError(null);
        setSubmitRejected(false);
      },
      reconciling,
      attempts,
      currentAttemptId,
      allowRetry,
      awaitingReview,
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
      submitRejected,
      reconciling,
      attempts,
      currentAttemptId,
      allowRetry,
      awaitingReview,
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
