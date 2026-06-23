import React from 'react';
import styles from './NoActiveChannelState.module.css';
import messageSquareIcon from '../../../../assets/message-square-lines.svg';
import { defaultLabels } from './labels.ts';
import type { NoActiveChannelStateLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ce type depuis ce module.
export type { NoActiveChannelStateLabels } from './types.ts';

interface NoActiveChannelStateProps {
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<NoActiveChannelStateLabels>;
}

/**
 * Etat 4 — le cours contient du contenu mais aucun canal/forum/quiz n'est
 * actuellement selectionne ("aucun forum actif").
 */
const NoActiveChannelState: React.FC<NoActiveChannelStateProps> = ({ labels }) => {
  const t = { ...defaultLabels, ...labels };

  return (
    <div className={styles.emptyMainState}>
      <div className={styles.emptyMainIcon} aria-hidden="true">
        <img src={messageSquareIcon} alt="" className={styles.emptyMainIconImage} />
      </div>

      <h1 className={styles.emptyMainTitle}>{t.title}</h1>
      <p className={styles.emptyMainSubtitle}>{t.subtitle}</p>
    </div>
  );
};

export default NoActiveChannelState;
