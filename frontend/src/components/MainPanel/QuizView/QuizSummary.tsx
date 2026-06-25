import React from 'react';
import styles from './QuizView.module.css';
import { Check } from '../../../assets/Check';
import { X } from '../../../assets/X';
import { Chevron } from '../../../assets/Chevron';
import { QUESTION_TYPE_LABELS, type Quiz } from '../../../types/domain';
import { type QuizResult } from './quizAttempt';
import { scoreTone, type ScoreTone } from './scoreTone';

interface QuizSummaryProps {
  quiz: Quiz;
  result: QuizResult;
  /** Ouvre la révision de la question d'index donné. */
  onReview: (index: number) => void;
}

/**
 * Écran récapitulatif post-soumission : score global (pourcentage), volumétrie, et
 * détail cliquable par question (chaque ligne ouvre la révision correspondante).
 */
export function QuizSummary({ quiz, result, onReview }: QuizSummaryProps): React.ReactElement {
  const questions = quiz.questions ?? [];
  const percent = result.max > 0 ? Math.round((result.earned / result.max) * 100) : 0;
  const perfectCount = result.questions.filter((q) => q.max > 0 && q.earned >= q.max).length;

  return (
    <article className={styles.card}>
      <div className={styles.summaryHead}>
        <span className={styles.summaryCheck}>
          <Check width={28} height={28} />
        </span>
        <h2 className={styles.summaryTitle}>{quiz.title} — terminé !</h2>
        <div className={styles.summaryScore}>{percent} %</div>
        <div className={styles.summarySub}>
          {result.earned} / {result.max} points · {perfectCount} question
          {perfectCount > 1 ? 's' : ''} parfaite{perfectCount > 1 ? 's' : ''} sur {questions.length}
        </div>
      </div>

      <hr className={styles.summaryDivider} />

      <h3 className={styles.summaryListTitle}>Détail par question</h3>
      <div className={styles.summaryList}>
        {questions.map((question, index) => {
          const qResult = result.questions.find((r) => r.questionId === question.id);
          const tone = qResult ? scoreTone(qResult.earned, qResult.max) : 'zero';
          const title = firstLine(question.prompt);
          return (
            <button
              type="button"
              key={question.id}
              className={styles.summaryRow}
              onClick={() => onReview(index)}
            >
              <StatusDot tone={tone} />
              <span className={styles.badge}>{QUESTION_TYPE_LABELS[question.qType]}</span>
              <span className={styles.summaryRowText}>
                Q{index + 1} · {title}
              </span>
              <span className={styles.summaryRowScore}>
                {qResult?.earned ?? 0} / {qResult?.max ?? question.totalScore} pts
              </span>
              <span className={styles.summaryRowChevron}>
                <Chevron width={16} height={16} style={{ transform: 'rotate(90deg)' }} />
              </span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

/** Icône d'état d'une ligne : ✓ (parfait) / ✗ (nul) / ◐ (partiel). */
function StatusDot({ tone }: { tone: ScoreTone }): React.ReactElement {
  if (tone === 'full') {
    return (
      <span className={[styles.summaryRowIcon, styles.pointsFull].join(' ')}>
        <Check width={14} height={14} />
      </span>
    );
  }
  if (tone === 'zero') {
    return (
      <span className={[styles.summaryRowIcon, styles.pointsZero].join(' ')}>
        <X width={12} height={12} />
      </span>
    );
  }
  return <span className={[styles.summaryRowIcon, styles.pointsPartial].join(' ')}>◐</span>;
}

/** Première ligne « parlante » du prompt Markdown (titre court de la question). */
function firstLine(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  // Retire les marques Markdown de base pour un libellé propre.
  return line.replace(/^#+\s*/, '').replace(/[*`_]/g, '');
}
