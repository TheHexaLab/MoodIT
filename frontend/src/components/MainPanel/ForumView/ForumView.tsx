import React from 'react';
import styles from './ForumView.module.css';
import { type CourseChannel } from '../../CourseChannelList/CourseChannelList';
import { getPrefixForType } from '../../CourseChannelList/channelTypePrefix';
import { type Course } from '../../CourseMenu/CourseMenu';
import { getCourseDisplayLabel } from '../../CourseMenu/courseLabel';

interface ForumViewProps {
  /** Cours auquel appartient le forum (contexte d'en-tete). */
  course: Course;
  /** Forum selectionne (forum de f_type 'Thread' : post + reponses). */
  channel: CourseChannel;
}

/**
 * Etat 6 — vue d'un forum (f_type 'Thread').
 * Discussion sous forme de post + reponses. Contenu a implementer.
 */
const ForumView: React.FC<ForumViewProps> = ({ course, channel }) => {
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
          Forum de discussion.
          <br />
          Les sujets et leurs réponses seront affichés ici (à implémenter).
        </p>
      </div>
    </>
  );
};

export default ForumView;
