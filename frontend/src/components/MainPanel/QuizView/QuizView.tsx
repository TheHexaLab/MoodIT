import React from 'react';
import styles from './QuizView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';

interface QuizViewProps {
  /** Cours auquel appartient le quiz (contexte d'en-tete). */
  course: Course;
  /** Quiz selectionne (table Quiz). */
  channel: CourseChannel;
}

/**
 * Etat 7 — vue d'un quiz (table Quiz).
 * Contenu a implementer.
 */
const QuizView: React.FC<QuizViewProps> = ({ course, channel }) => {
  const courseLabel = getCourseDisplayLabel(course);

  return (
    <>
      <header className={styles.header}>
        {courseLabel && <p className={styles.meta}>{courseLabel}</p>}
        <h1 className={styles.title}>
          <span className={styles.prefix}>{getPrefixForType(channel.type)}</span>
          {channel.name}
        </h1>
      </header>

      <div className={styles.body}>
        <p className={styles.placeholder}>
          Quiz.
          <br />
          Les questions et le déroulement du quiz seront affichés ici (à implémenter).
        </p>
      </div>
    </>
  );
};

export default QuizView;
