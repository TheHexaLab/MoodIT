import React from 'react';
import styles from './QuizView.module.css';
import { Markdown } from '../ForumView/Markdown';
import { QUESTION_TYPE_LABELS, type Question } from '../../../types/domain';
import { type QuestionResult } from './quizAttempt';
import { scoreTone } from './scoreTone';
import { defaultQuestionCardLabels, type QuestionCardLabels } from './questionCardLabels';

interface QuestionCardProps {
  question: Question;
  /** Position 0-based dans le quiz (affichée « Question N+1 »). */
  index: number;
  /** Résultat corrigé : présent en révision → pastille de points colorée. */
  result?: QuestionResult;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuestionCardLabels>;
  /** Le rendu de saisie / révision propre au type. */
  children: React.ReactNode;
}

/**
 * Carte d'une question : badge de type + « Question N » + pastille de points, puis
 * l'énoncé (Markdown) et le contenu propre au type. La pastille affiche le barème
 * en passation (« 10 pts ») et le score obtenu, coloré, en révision (« 5 / 5 pts »).
 */
export function QuestionCard({
  question,
  index,
  result,
  labels,
  children,
}: QuestionCardProps): React.ReactElement {
  const t = { ...defaultQuestionCardLabels, ...labels };
  return (
    <article className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.badge}>{QUESTION_TYPE_LABELS[question.qType]}</span>
        <span className={styles.questionLabel}>{t.questionLabel(index + 1)}</span>
        <PointsPill question={question} result={result} labels={t} />
      </div>

      <div className={styles.prompt}>
        <Markdown source={question.prompt} />
      </div>

      {children}
    </article>
  );
}

function PointsPill({
  question,
  result,
  labels,
}: {
  question: Question;
  result?: QuestionResult;
  labels: QuestionCardLabels;
}): React.ReactElement {
  if (!result) {
    return <span className={styles.points}>{labels.points(question.totalScore)}</span>;
  }
  const toneClass = {
    good: styles.pointsFull,
    warn: styles.pointsPartial,
    bad: styles.pointsZero,
  }[scoreTone(result.earned, result.max)];
  return (
    <span className={[styles.points, toneClass].join(' ')}>
      {labels.score(result.earned, result.max)}
    </span>
  );
}
