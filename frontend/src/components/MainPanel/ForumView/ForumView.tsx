import React from 'react';
import styles from './ForumView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';

interface ForumViewProps {
  /** Forum selectionne (forum de f_type 'Thread' : post + reponses). */
  channel: CourseChannel;
  /** Libelle du programme actif (contexte d'en-tete). */
  programLabel?: string;
  /** Libelle du cours selectionne (contexte d'en-tete). */
  courseLabel?: string;
}

/**
 * Etat 6 — vue d'un forum (f_type 'Thread').
 * Discussion sous forme de post + reponses. Contenu a implementer.
 */
const ForumView: React.FC<ForumViewProps> = ({ channel, programLabel, courseLabel }) => (
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
        Forum de discussion{programLabel ? ` du programme ${programLabel}` : ''}.
        <br />
        Les sujets et leurs réponses seront affichés ici (à implémenter).
      </p>
    </div>
  </>
);

export default ForumView;
