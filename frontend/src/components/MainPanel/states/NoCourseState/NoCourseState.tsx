import React from 'react';
import styles from './NoCourseState.module.css';
import gradCapIcon from '../../../../assets/grad-cap.svg';
import { defaultLabels } from './labels.ts';
import type { NoCourseStateLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ce type depuis ce module.
export type { NoCourseStateLabels } from './types.ts';

interface NoCourseStateProps {
  /** Utilisateur administrateur : affiche le sous-titre admin et le bouton d'ajout. */
  isAdmin?: boolean;
  /** Ouvre le formulaire d'ajout de cours (action reservee a l'admin). */
  onAddCourse?: () => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<NoCourseStateLabels>;
}

/**
 * Etat 2 — le programme selectionne ne contient aucun cours.
 */
const NoCourseState: React.FC<NoCourseStateProps> = ({ isAdmin = false, onAddCourse, labels }) => {
  const t = { ...defaultLabels, ...labels };

  return (
    <div className={styles.emptyMainState}>
      <div className={styles.emptyMainIcon} aria-hidden="true">
        <img src={gradCapIcon} alt="" className={styles.emptyMainIconImage} />
      </div>

      <h1 className={styles.emptyMainTitle}>{t.title}</h1>
      <p className={styles.emptyMainSubtitle}>{isAdmin ? t.adminSubtitle : t.userSubtitle}</p>

      {isAdmin && (
        <button type="button" className={styles.emptyMainAction} onClick={onAddCourse}>
          +<span>{t.addCourse}</span>
        </button>
      )}
    </div>
  );
};

export default NoCourseState;
