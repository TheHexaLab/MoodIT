import React from 'react';
import styles from './QuizView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';

interface QuizViewProps {
  /** Quiz selectionne (table Quiz). */
  channel: CourseChannel;
  /** Libelle du programme actif (contexte d'en-tete). */
  programLabel?: string;
  /** Libelle du cours selectionne (contexte d'en-tete). */
  courseLabel?: string;
}

/**
 * Etat 7 — vue d'un quiz (table Quiz).
 * Contenu a implementer.
 */
const QuizView: React.FC<QuizViewProps> = ({ channel, programLabel, courseLabel }) => (
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
        Quiz{programLabel ? ` du programme ${programLabel}` : ''}.
        <br />
        Les questions et le déroulement du quiz seront affichés ici (à implémenter).
      </p>
    </div>
  </>
);

export default QuizView;
