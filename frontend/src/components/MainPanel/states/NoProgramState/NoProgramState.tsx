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
  /** Ouvre le formulaire d'ajout / d'adhesion a un programme (action reservee a l'admin). */
  onAddProgram?: () => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<NoProgramStateLabels>;
}

/**
 * Etat 1 — l'utilisateur n'a rejoint aucun programme.
 * Affiche un message de bienvenue et, pour un admin, une action pour en ajouter un.
 */
const NoProgramState: React.FC<NoProgramStateProps> = ({ isAdmin = false, onAddProgram, labels }) => {
  const t = { ...defaultLabels, ...labels };

  return (
    <div className={styles.emptyMainState}>
      <div className={styles.emptyMainIcon} aria-hidden="true">
        <img src={gradCapIcon} alt="" className={styles.emptyMainIconImage} />
      </div>

      <h1 className={styles.emptyMainTitle}>{t.title}</h1>
      <p className={styles.emptyMainSubtitle}>{isAdmin ? t.adminSubtitle : t.userSubtitle}</p>

      {isAdmin && (
        <button type="button" className={styles.emptyMainAction} onClick={onAddProgram}>
          +<span>{t.addProgram}</span>
        </button>
      )}
    </div>
  );
};

export default NoProgramState;
