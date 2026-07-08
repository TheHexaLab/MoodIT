import React from 'react';
import styles from './NoProgramState.module.css';
import gradCapIcon from '../../../../assets/grad-cap.svg';
import { defaultLabels } from './labels.ts';
import type { NoProgramStateLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ce type depuis ce module.
export type { NoProgramStateLabels } from './types.ts';

interface NoProgramStateProps {
  /** Utilisateur administrateur : affiche le sous-titre admin et le bouton d'ajout. */
  isAdmin?: boolean;
  /** Ouvre le menu d'ajout / de gestion d'un programme (action reservee a l'admin). */
  onAddProgram?: () => void;
  /** Ouvre le popup « rejoindre un programme » (action offerte a TOUS : admin et utilisateur). */
  onJoinProgram?: () => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<NoProgramStateLabels>;
}

/**
 * Etat 1 — l'utilisateur n'a rejoint aucun programme. Tout le monde peut « rejoindre un
 * programme » ; l'admin peut en plus en « ajouter » un (menu créer / gérer les établissements).
 */
const NoProgramState: React.FC<NoProgramStateProps> = ({
  isAdmin = false,
  onAddProgram,
  onJoinProgram,
  labels,
}) => {
  const t = { ...defaultLabels, ...labels };

  return (
    <div className={styles.emptyMainState}>
      <div className={styles.emptyMainIcon} aria-hidden="true">
        <img src={gradCapIcon} alt="" className={styles.emptyMainIconImage} />
      </div>

      <h1 className={styles.emptyMainTitle}>{t.title}</h1>
      <p className={styles.emptyMainSubtitle}>{isAdmin ? t.adminSubtitle : t.userSubtitle}</p>

      <div className={styles.emptyCourseActions}>
        <button type="button" className={styles.emptyMainAction} onClick={onJoinProgram}>
          +<span>{t.joinProgram}</span>
        </button>
        {isAdmin && (
          <button
            type="button"
            className={styles.emptyMainActionOutline}
            onClick={onAddProgram}
          >
            +<span>{t.addProgram}</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default NoProgramState;
