import React from 'react';
import styles from './EmptyCourseState.module.css';
import messageSquareIcon from '../../../../assets/message-square-lines.svg';
import { defaultLabels } from './labels.ts';
import type { EmptyCourseStateLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ce type depuis ce module.
export type { EmptyCourseStateLabels } from './types.ts';

interface EmptyCourseStateProps {
  /** Utilisateur administrateur : affiche le sous-titre admin et les boutons de creation. */
  isAdmin?: boolean;
  /** Ouvre le formulaire de creation de canal texte (action reservee a l'admin). */
  onCreateChannel?: () => void;
  /** Ouvre le formulaire de creation de quiz (action reservee a l'admin). */
  onCreateQuiz?: () => void;
  /** Ouvre le formulaire de creation de forum (action reservee a l'admin). */
  onCreateForum?: () => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<EmptyCourseStateLabels>;
}

/**
 * Etat 3 — le cours selectionne ne contient aucun canal, forum ni quiz.
 */
const EmptyCourseState: React.FC<EmptyCourseStateProps> = ({
  isAdmin = false,
  onCreateChannel,
  onCreateQuiz,
  onCreateForum,
  labels,
}) => {
  const t = { ...defaultLabels, ...labels };

  return (
    <div className={styles.emptyMainState}>
      <div className={styles.emptyMainIcon} aria-hidden="true">
        <img src={messageSquareIcon} alt="" className={styles.emptyMainIconImage} />
      </div>

      <h1 className={styles.emptyMainTitle}>{t.title}</h1>
      <p className={styles.emptyMainSubtitle}>{isAdmin ? t.adminSubtitle : t.userSubtitle}</p>

      {isAdmin && (
        <div className={styles.emptyCourseActions}>
          <button type="button" className={styles.emptyMainAction} onClick={onCreateChannel}>
            +<span>{t.createChannel}</span>
          </button>
          <button type="button" className={styles.emptyMainActionOutline} onClick={onCreateQuiz}>
            +<span>{t.createQuiz}</span>
          </button>
          <button type="button" className={styles.emptyMainActionOutline} onClick={onCreateForum}>
            +<span>{t.createForum}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default EmptyCourseState;
