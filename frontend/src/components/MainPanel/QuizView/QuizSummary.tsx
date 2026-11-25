import React, { useLayoutEffect, useRef } from 'react';
import styles from './QuizView.module.css';
import { Check } from '../../../assets/Check';
import { X } from '../../../assets/X';
import { AlertCircle } from '../../../assets/AlertCircle';
import { Chevron } from '../../../assets/Chevron';
import { QUESTION_TYPE_LABELS, type Quiz } from '../../../types/domain';
import { type AttemptSummary, type QuizResult } from './quizAttempt';
import { scoreTone, type ScoreTone } from './scoreTone';
import { Spinner } from '../../Spinner/Spinner';
import { defaultQuizSummaryLabels, type QuizSummaryLabels } from './quizSummaryLabels';

interface QuizSummaryProps {
  quiz: Quiz;
  result: QuizResult;
  /** Historique des tentatives (≥ 2 → barre de sélection). */
  attempts: AttemptSummary[];
  /** Tentative actuellement affichée (surlignée dans la barre). */
  currentAttemptId: number | null;
  /** Affiche le récap d'une tentative passée. */
  onSelectAttempt: (attemptId: number) => void;
  /** Ouvre la révision de la question d'index donné. */
  onReview: (index: number) => void;
  /** Puce à refocaliser après un changement de tentative (cf. AttemptBar). */
  focusId?: number | null;
  onFocused?: () => void;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuizSummaryLabels>;
}

interface AttemptBarProps {
  attempts: AttemptSummary[];
  currentAttemptId: number | null;
  onSelectAttempt: (attemptId: number) => void;
  /**
   * Puce à refocaliser après un changement de tentative. Passer d'une tentative corrigée à une
   * tentative « à revoir » remplace tout le corps, barre comprise : la puce activée disparaissait
   * et le focus retombait sur <body>. La nouvelle barre le rend à la puce du même id.
   */
  focusId?: number | null;
  /**
   * La demande est soldée : puce focalisée (si le focus était orphelin), ou absente de cette
   * barre — rien sous deux tentatives. Une demande laissée en attente aurait focalisé plus tard
   * la puce d'une AUTRE tentative que celle affichée.
   */
  onFocused?: () => void;
  labels?: Partial<QuizSummaryLabels>;
}

/**
 * Barre de sélection des tentatives (rien sous deux tentatives). Partagée par le récapitulatif
 * et par le message d'une tentative « à revoir » (#116) : sans elle, l'étudiant qui ouvrait une
 * tentative à revoir ne pouvait plus revenir à ses autres tentatives.
 */
export function AttemptBar({
  attempts,
  currentAttemptId,
  onSelectAttempt,
  focusId,
  onFocused,
  labels,
}: AttemptBarProps): React.ReactElement | null {
  const chips = useRef(new Map<number, HTMLButtonElement>());
  // Effet de MISE EN PAGE : le focus est posé dans la même mise à jour que le montage de la
  // barre, jamais après un passage par <body> (un effet passif courait après le rendu, au gré
  // du planificateur — comme AssignmentTeams).
  // La demande est soldée à la première barre rendue, puce trouvée ou non (cf. `onFocused`).
  useLayoutEffect(() => {
    if (focusId == null) return;
    const chip = chips.current.get(focusId);
    const active = document.activeElement;
    if (chip && (!active || active === document.body || !active.isConnected)) chip.focus();
    onFocused?.();
  });
  if (attempts.length < 2) return null;
  const t = { ...defaultQuizSummaryLabels, ...labels };
  return (
    <div className={styles.attemptBar}>
      <span className={styles.attemptBarLabel}>{t.attemptsLabel}</span>
      <div className={styles.attemptChips}>
        {attempts.map((a) => (
          <button
            type="button"
            key={a.id}
            className={[styles.attemptChip, a.id === currentAttemptId ? styles.attemptChipActive : '']
              .filter(Boolean)
              .join(' ')}
            aria-pressed={a.id === currentAttemptId}
            ref={(el) => {
              if (el) chips.current.set(a.id, el);
              else chips.current.delete(a.id);
            }}
            onClick={() => onSelectAttempt(a.id)}
          >
            {a.earned == null
              ? t.attemptChipReview(a.attemptNo)
              : t.attemptChip(a.attemptNo, a.earned, a.max)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Écran récapitulatif post-soumission : score global (pourcentage), volumétrie, et
 * détail cliquable par question (chaque ligne ouvre la révision correspondante).
 */
export function QuizSummary({
  quiz,
  result,
  attempts,
  currentAttemptId,
  onSelectAttempt,
  onReview,
  focusId,
  onFocused,
  labels,
}: QuizSummaryProps): React.ReactElement {
  const t = { ...defaultQuizSummaryLabels, ...labels };
  const questions = quiz.questions ?? [];
  // Une question Code sans verdict (tests null) = correction async pas encore terminée : on
  // affiche « en attente », PAS un échec, et le score global reste « en validation ».
  const isPending = (questionId: number): boolean =>
    result.questions.find((q) => q.questionId === questionId)?.tests == null;
  const anyPending = questions.some((q) => q.qType === 'coding' && isPending(q.id));
  // Pourcentage global au dixième près (format X.X).
  const percent = result.max > 0 ? Math.round((result.earned / result.max) * 1000) / 10 : 0;
  // Palier global (rouge < 50 % / jaune 50-77 % / vert ≥ 78 %) pour l'en-tête. Neutre tant que
  // la validation du code n'est pas finie (score non définitif).
  const overallTone = scoreTone(result.earned, result.max);
  const headToneClass = anyPending
    ? ''
    : { good: styles.headGood, warn: styles.headWarn, bad: styles.headBad }[overallTone];
  const scoreToneClass = anyPending
    ? ''
    : { good: styles.scoreGood, warn: styles.scoreWarn, bad: styles.scoreBad }[overallTone];
  const perfectCount = result.questions.filter((q) => q.max > 0 && q.earned >= q.max).length;
  // Meilleur score parmi les tentatives (affiché quand il y en a plusieurs).
  // Une tentative à revoir (#116) n'a pas de note : elle ne compte pas dans le meilleur score.
  const bestPercent = attempts.reduce(
    (best, a) =>
      a.earned == null
        ? best
        : Math.max(best, a.max > 0 ? Math.round((a.earned / a.max) * 1000) / 10 : 0),
    0
  );

  return (
    <article className={styles.card}>
      <div className={styles.summaryHead}>
        <span className={[styles.summaryCheck, headToneClass].filter(Boolean).join(' ')}>
          {anyPending || overallTone === 'good' ? (
            <Check width={28} height={28} />
          ) : overallTone === 'warn' ? (
            <AlertCircle width={28} height={28} />
          ) : (
            <X width={26} height={26} />
          )}
        </span>
        <h2 className={styles.summaryTitle}>
          {anyPending ? t.submittedTitle(quiz.title) : t.completedTitle(quiz.title)}
        </h2>
        <div className={[styles.summaryScore, scoreToneClass].filter(Boolean).join(' ')}>
          {anyPending ? '-' : t.percent(percent)}
        </div>
        <div className={styles.summarySub}>
          {anyPending
            ? t.validatingSub
            : t.summarySub(result.earned, result.max, perfectCount, questions.length)}
        </div>
        {attempts.length > 1 && (
          <div className={styles.summarySub}>{t.bestScore(bestPercent)}</div>
        )}
      </div>

      <AttemptBar
        attempts={attempts}
        currentAttemptId={currentAttemptId}
        onSelectAttempt={onSelectAttempt}
        focusId={focusId}
        onFocused={onFocused}
        labels={labels}
      />

      <hr className={styles.summaryDivider} />

      <h3 className={styles.summaryListTitle}>{t.detailTitle}</h3>
      <div className={styles.summaryList}>
        {questions.map((question, index) => {
          const qResult = result.questions.find((r) => r.questionId === question.id);
          const pending = question.qType === 'coding' && isPending(question.id);
          const tone = qResult ? scoreTone(qResult.earned, qResult.max) : 'bad';
          const title = firstLine(question.prompt);
          return (
            <button
              type="button"
              key={question.id}
              className={styles.summaryRow}
              onClick={() => onReview(index)}
            >
              {pending ? (
                <span className={styles.summaryRowIcon}>
                  <Spinner tone="current" size={14} />
                </span>
              ) : (
                <StatusDot tone={tone} />
              )}
              <span className={styles.badge}>{QUESTION_TYPE_LABELS[question.qType]}</span>
              <span className={styles.summaryRowText}>{t.rowText(title)}</span>
              <span className={styles.summaryRowScore}>
                {pending
                  ? t.rowPending
                  : t.rowScore(qResult?.earned ?? 0, qResult?.max ?? question.totalScore)}
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
  if (tone === 'good') {
    return (
      <span className={[styles.summaryRowIcon, styles.pointsFull].join(' ')}>
        <Check width={14} height={14} />
      </span>
    );
  }
  if (tone === 'bad') {
    return (
      <span className={[styles.summaryRowIcon, styles.pointsZero].join(' ')}>
        <X width={12} height={12} />
      </span>
    );
  }
  return (
    <span className={[styles.summaryRowIcon, styles.pointsPartial].join(' ')}>
      <AlertCircle width={14} height={14} />
    </span>
  );
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
