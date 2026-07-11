import React, { useEffect, useLayoutEffect, useRef } from 'react';
import styles from './QuizView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { type Course } from '../../CourseMenu/CourseMenu';
import { type Quiz } from '../../../types/domain';
import { ChannelTypeIcon } from '../../CourseChannelList/ChannelTypeIcon';
import { ArrowRight } from '../../../assets/ArrowRight';
import { Chevron } from '../../../assets/Chevron';
import { Check } from '../../../assets/Check';
import { quizAllQuestionTypesMock } from '../../../mocks/dashboardData';
import {
  type FetchAttemptResultHandler,
  type FetchAttemptsHandler,
  type FetchQuizHandler,
  type RunCodeHandler,
  type SubmitQuizHandler,
  isAnswered,
} from './quizAttempt';
import { useQuizAttempt } from './useQuizAttempt';
import { QuestionCard } from './QuestionCard';
import { QuestionRenderer } from './questions/QuestionRenderer';
import { QuizSummary } from './QuizSummary';
import { Spinner } from '../../Spinner/Spinner';
import { ErrorPopup } from '../../ErrorPopup/ErrorPopup';
import { defaultQuizViewLabels, type QuizViewLabelsBundle } from './quizViewLabels';

interface QuizViewProps {
  /** Cours auquel appartient le quiz (contexte d'en-tête). */
  course: Course;
  /** Quiz sélectionné (table Quiz), normalisé en canal de liste. */
  channel: CourseChannel;
  /**
   * Détail de départ (questions embarquées). Repli de DÉMONSTRATION : le quiz mock
   * couvrant les 6 types, tant que le backend n'est pas branché. Remplacé par
   * `onFetchQuiz` dès qu'il est fourni.
   */
  initialQuiz?: Quiz;
  /** Chargement du détail du quiz (API-ready, GET). */
  onFetchQuiz?: FetchQuizHandler;
  /** Historique des tentatives (API-ready, GET) → ouvre sur la dernière + reprise. */
  onFetchAttempts?: FetchAttemptsHandler;
  /** Détail corrigé d'une tentative (API-ready, GET) → révision d'une tentative passée. */
  onFetchAttemptResult?: FetchAttemptResultHandler;
  /** Soumission de la tentative (API-ready). */
  onSubmitQuiz?: SubmitQuizHandler;
  /** Exécute le code d'une question Code dans le sandbox (bouton « play » de l'éditeur). */
  onRunCode?: RunCodeHandler;
  /** Le quiz a été modifié à distance (WS) → affiche une bannière de rechargement. */
  staleNotice?: boolean;
  /** Efface la bannière « quiz modifié » (après rechargement ou rejet). */
  onReloadStale?: () => void;
  /** Libellés (coquille + résumé / carte / rendus). Défauts FR sinon. */
  labels?: QuizViewLabelsBundle;
}

/**
 * Vue d'un quiz côté étudiant : passation des 6 types de questions, soumission,
 * résumé corrigé et révision question par question. La logique (chargement,
 * réponses, correction) vit dans `useQuizAttempt` (API-ready) ; ce composant
 * assemble la coquille (en-tête, barre de progression, pied de navigation).
 */
const QuizView: React.FC<QuizViewProps> = ({
  channel,
  initialQuiz,
  onFetchQuiz,
  onFetchAttempts,
  onFetchAttemptResult,
  onSubmitQuiz,
  onRunCode,
  staleNotice = false,
  onReloadStale,
  labels,
}) => {
  const t = { ...defaultQuizViewLabels, ...labels?.view };
  // Repli : le mock des 6 types, rattaché à l'id du quiz sélectionné.
  const fallbackQuiz: Quiz = initialQuiz ?? { ...quizAllQuestionTypesMock, id: channel.id };

  const attempt = useQuizAttempt({
    initialQuiz: fallbackQuiz,
    onFetchQuiz,
    onFetchAttempts,
    onFetchAttemptResult,
    onSubmitQuiz,
    loadErrorMessage: t.loadError,
    submitErrorMessage: t.submitError,
    codeVerificationUnavailableMessage: t.codeVerificationUnavailable,
    submissionNotConfirmedMessage: t.submissionNotConfirmed,
  });
  const { quiz, phase, currentIndex, answers, result } = attempt;

  // Quiz modifié à distance (WS) : on RECHARGE immédiatement (sans toast). En passation,
  // on conserve les réponses déjà saisies (fusion) ; sinon rechargement complet.
  // Refs pour ne déclencher qu'au front montant de `staleNotice` (pas de double-reload).
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onReloadStaleRef = useRef(onReloadStale);
  onReloadStaleRef.current = onReloadStale;
  useEffect(() => {
    if (!staleNotice) return;
    if (phaseRef.current === 'taking') attemptRef.current.reloadKeepingAnswers();
    else attemptRef.current.reload();
    onReloadStaleRef.current?.();
  }, [staleNotice]);

  const questions = quiz.questions ?? [];
  const total = questions.length;
  const headerTitle = quiz.isDaily ? t.dailyTitle : channel.name;

  // Barre de progression : fraction courante (100 % au résumé).
  const progress =
    phase === 'summary' ? 1 : total > 0 ? (currentIndex + 1) / total : 0;

  // Menu de points défilable : on garde le point actif (marqué data-active) TOUJOURS visible, mais
  // sans scroll superflu — on ne défile QUE s'il sort du cadre (avec une petite marge de contexte),
  // sinon on ne bouge pas. Défile uniquement le conteneur (scrollLeft), pas le reste de la page.
  const dotsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = dotsRef.current;
    const active = container?.querySelector<HTMLElement>('[data-active]');
    if (!container || !active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    const margin = active.offsetWidth; // garde un point de contexte de part et d'autre
    if (left - margin < container.scrollLeft) {
      container.scrollLeft = left - margin;
    } else if (right + margin > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = right + margin - container.clientWidth;
    }
  }, [currentIndex, total, phase]);

  // Spinner PLEIN QUIZ : chargement initial, envoi en cours, ou réconciliation post-refresh.
  const busy = attempt.loading || attempt.submitting || attempt.reconciling;

  return (
    <div className={styles.view}>
      {busy && (
        <div className={styles.busyOverlay} role="status" aria-live="polite" aria-busy="true">
          <Spinner size={44} />
        </div>
      )}

      {attempt.submitError && (
        <ErrorPopup
          content={attempt.submitError}
          onClose={attempt.dismissSubmitError}
          onRetry={attempt.submit}
          labels={{ title: t.errorTitle }}
        />
      )}

      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.bolt}>
            <ChannelTypeIcon type="quiz" />
          </span>
          <span className={styles.titleText}>
            <span className={styles.title}>{headerTitle}</span>
          </span>
        </div>

        {phase === 'review' ? (
          <button type="button" className={styles.backButton} onClick={attempt.backToSummary}>
            <Chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} />
            {t.backToSummary}
          </button>
        ) : (
          <span className={styles.status}>
            {phase === 'summary' ? t.finished : t.questionStatus(currentIndex + 1, total)}
          </span>
        )}
      </header>

      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
      </div>

      {renderBody()}

      {renderFooter()}
    </div>
  );

  // ───────────────────────────────── Corps ─────────────────────────────────

  function renderBody(): React.ReactElement {
    // Le chargement est couvert par l'overlay plein quiz (cf. `busy`) ; on ne rend rien derrière.
    if (attempt.loading) {
      return <div className={styles.body} />;
    }
    if (attempt.loadError) {
      return (
        <div className={styles.centeredState}>
          <p>{attempt.loadError}</p>
          <button type="button" className={styles.retryButton} onClick={attempt.reload}>
            {t.retry}
          </button>
        </div>
      );
    }
    if (total === 0) {
      return <div className={styles.centeredState}>{t.empty}</div>;
    }

    if (phase === 'summary' && result) {
      return (
        <div className={styles.body}>
          <QuizSummary
            quiz={quiz}
            result={result}
            attempts={attempt.attempts}
            currentAttemptId={attempt.currentAttemptId}
            onSelectAttempt={attempt.selectAttempt}
            onReview={attempt.reviewQuestion}
            labels={labels?.summary}
          />
        </div>
      );
    }

    // Passation OU révision : une question à la fois.
    const question = questions[currentIndex];
    const qResult =
      phase === 'review' ? result?.questions.find((r) => r.questionId === question.id) : undefined;

    return (
      <div className={styles.body}>
        <QuestionCard question={question} index={currentIndex} result={qResult} labels={labels?.card}>
          <QuestionRenderer
            question={question}
            mode={phase === 'review' ? 'review' : 'answer'}
            answer={answers[question.id]}
            result={qResult}
            onChange={(a) => attempt.setAnswer(question.id, a)}
            labels={labels?.question}
            onRunCode={onRunCode}
          />
        </QuestionCard>
      </div>
    );
  }

  // ────────────────────────────── Pied de page ──────────────────────────────

  function renderFooter(): React.ReactElement | null {
    if (attempt.loading || attempt.loadError || total === 0) return null;

    if (phase === 'summary') {
      return (
        <footer className={`${styles.footer} ${styles.summaryFooter}`}>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => attempt.reviewQuestion(0)}
          >
            {t.reviewAnswers}
          </button>
          {attempt.allowRetry && (
            <button type="button" className={styles.primaryButton} onClick={attempt.retry}>
              {t.retryQuiz}
            </button>
          )}
        </footer>
      );
    }

    const isLast = currentIndex === total - 1;

    return (
      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.navButton}
          onClick={attempt.goPrev}
          disabled={currentIndex === 0}
        >
          <Chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} />
          {t.prev}
        </button>

        {/* Rangée de points défilable (scrollbar masquée) : tous les points restent cliquables ;
            le point actif est recentré en JS. S'adapte à n'importe quel nombre de questions. */}
        <div className={styles.dots} ref={dotsRef}>
          {questions.map((q, i) => (
            <button
              type="button"
              key={q.id}
              data-active={i === currentIndex ? '' : undefined}
              className={[
                styles.dot,
                i === currentIndex ? styles.dotActive : '',
                phase === 'taking' && attempt.touched.has(q.id) && isAnswered(answers[q.id])
                  ? styles.dotAnswered
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={t.dotAria(i + 1)}
              onClick={() => attempt.goTo(i)}
            />
          ))}
        </div>

        {renderPrimaryNav(isLast)}
      </footer>
    );
  }

  /** Bouton de droite : Suivant / Soumettre (passation) ou Suivant / Terminé (révision). */
  function renderPrimaryNav(isLast: boolean): React.ReactElement {
    if (phase === 'review') {
      return (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => (isLast ? attempt.backToSummary() : attempt.goNext())}
        >
          {isLast ? (
            <>
              {t.done} <Check width={15} height={15} />
            </>
          ) : (
            <>
              {t.next} <ArrowRight width={15} height={15} />
            </>
          )}
        </button>
      );
    }

    if (isLast) {
      // Grisé pendant l'envoi ET si la tentative unique est déjà consommée (miroir du
      // 409 backend : évite le double-clic / rejeu qui serait de toute façon rejeté).
      const disabled = attempt.submitting || attempt.alreadySubmitted;
      return (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={attempt.submit}
          disabled={disabled}
          title={attempt.alreadySubmitted ? t.alreadySubmitted : undefined}
        >
          {attempt.submitting ? t.submitting : t.submit} <Check width={15} height={15} />
        </button>
      );
    }

    return (
      <button type="button" className={styles.primaryButton} onClick={attempt.goNext}>
        {t.next} <ArrowRight width={15} height={15} />
      </button>
    );
  }
};

export default QuizView;
