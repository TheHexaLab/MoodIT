import React from 'react';
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
  type FetchQuizHandler,
  type SubmitQuizHandler,
  isAnswered,
} from './quizAttempt';
import { useQuizAttempt } from './useQuizAttempt';
import { QuestionCard } from './QuestionCard';
import { QuestionRenderer } from './questions/QuestionRenderer';
import { QuizSummary } from './QuizSummary';

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
  /** Soumission de la tentative (API-ready). */
  onSubmitQuiz?: SubmitQuizHandler;
  /** Retour au tableau de bord depuis le résumé (optionnel). */
  onExit?: () => void;
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
  onSubmitQuiz,
  onExit,
}) => {
  // Repli : le mock des 6 types, rattaché à l'id du quiz sélectionné.
  const fallbackQuiz: Quiz = initialQuiz ?? { ...quizAllQuestionTypesMock, id: channel.id };

  const attempt = useQuizAttempt({ initialQuiz: fallbackQuiz, onFetchQuiz, onSubmitQuiz });
  const { quiz, phase, currentIndex, answers, result } = attempt;

  const questions = quiz.questions ?? [];
  const total = questions.length;
  const headerTitle = quiz.isDaily ? 'Quiz du jour' : channel.name;

  // Barre de progression : fraction courante (100 % au résumé).
  const progress =
    phase === 'summary' ? 1 : total > 0 ? (currentIndex + 1) / total : 0;

  return (
    <div className={styles.view}>
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
            Retour au résumé
          </button>
        ) : (
          <span className={styles.status}>
            {phase === 'summary' ? 'Quiz terminé' : `Question ${currentIndex + 1} sur ${total}`}
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
    if (attempt.loading) {
      return <div className={styles.centeredState}>Chargement du quiz…</div>;
    }
    if (attempt.loadError) {
      return (
        <div className={styles.centeredState}>
          <p>{attempt.loadError}</p>
          <button type="button" className={styles.retryButton} onClick={attempt.reload}>
            Réessayer
          </button>
        </div>
      );
    }
    if (total === 0) {
      return (
        <div className={styles.centeredState}>Ce quiz ne contient pas encore de question.</div>
      );
    }

    if (phase === 'summary' && result) {
      return (
        <div className={styles.body}>
          <QuizSummary quiz={quiz} result={result} onReview={attempt.reviewQuestion} />
        </div>
      );
    }

    // Passation OU révision : une question à la fois.
    const question = questions[currentIndex];
    const qResult =
      phase === 'review' ? result?.questions.find((r) => r.questionId === question.id) : undefined;

    return (
      <div className={styles.body}>
        <QuestionCard question={question} index={currentIndex} result={qResult}>
          <QuestionRenderer
            question={question}
            mode={phase === 'review' ? 'review' : 'answer'}
            answer={answers[question.id]}
            result={qResult}
            onChange={(a) => attempt.setAnswer(question.id, a)}
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
        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.navButton}
            onClick={onExit}
            disabled={!onExit}
          >
            <Chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} />
            Tableau de bord
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => attempt.reviewQuestion(0)}
          >
            Revoir mes réponses
          </button>
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
          Précédent
        </button>

        <div className={styles.dots}>
          {questions.map((q, i) => (
            <button
              type="button"
              key={q.id}
              className={[
                styles.dot,
                i === currentIndex ? styles.dotActive : '',
                phase === 'taking' && attempt.touched.has(q.id) && isAnswered(answers[q.id])
                  ? styles.dotAnswered
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={`Question ${i + 1}`}
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
              Terminé <Check width={15} height={15} />
            </>
          ) : (
            <>
              Suivant <ArrowRight width={15} height={15} />
            </>
          )}
        </button>
      );
    }

    if (isLast) {
      return (
        <button
          type="button"
          className={styles.primaryButton}
          onClick={attempt.submit}
          disabled={attempt.submitting}
        >
          {attempt.submitting ? 'Envoi…' : 'Soumettre le quiz'} <Check width={15} height={15} />
        </button>
      );
    }

    return (
      <button type="button" className={styles.primaryButton} onClick={attempt.goNext}>
        Suivant <ArrowRight width={15} height={15} />
      </button>
    );
  }
};

export default QuizView;
