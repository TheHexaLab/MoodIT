import React from 'react';
import styles from './QuizView.module.css';
import { Markdown } from '../ForumView/Markdown';
import { QUESTION_TYPE_LABELS, type Question } from '../../../types/domain';
import { type QuestionResult } from './quizAttempt';
import { scoreTone } from './scoreTone';

interface QuestionCardProps {
  question: Question;
  /** Position 0-based dans le quiz (affichée « Question N+1 »). */
  index: number;
  /** Résultat corrigé : présent en révision → pastille de points colorée. */
  result?: QuestionResult;
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
  children,
}: QuestionCardProps): React.ReactElement {
  return (
    <article className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.badge}>{QUESTION_TYPE_LABELS[question.qType]}</span>
        <span className={styles.questionLabel}>Question {index + 1}</span>
        <PointsPill question={question} result={result} />
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
}: {
  question: Question;
  result?: QuestionResult;
}): React.ReactElement {
  if (!result) {
    return <span className={styles.points}>{question.totalScore} pts</span>;
  }
  const toneClass = {
    full: styles.pointsFull,
    zero: styles.pointsZero,
    partial: styles.pointsPartial,
  }[scoreTone(result.earned, result.max)];
  return (
    <span className={[styles.points, toneClass].join(' ')}>
      {result.earned} / {result.max} pts
    </span>
  );
}
