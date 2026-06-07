import React, { useRef, useState } from 'react';
import styles from './DeleteConfirmationBox.module.css';

interface DeleteConfirmationBoxProps {
  title: string;
  content: string;
  onDeleteConfirmation: (...args: unknown[]) => unknown;
  onClose: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<DeleteConfirmationBoxLabels>;
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface DeleteConfirmationBoxLabels {
  /** Bouton « annuler ». */
  cancel: string;
  /** Bouton de confirmation de suppression. */
  confirm: string;
}

/**
 * Tous les textes par défaut affichés par le composant.
 */
const defaultLabels: DeleteConfirmationBoxLabels = {
  cancel: 'Annuler',
  confirm: 'Supprimer',
};

export function DeleteConfirmationBox({
  title,
  content,
  onDeleteConfirmation,
  onClose,
  labels,
}: DeleteConfirmationBoxProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<((...args: unknown[]) => unknown) | null>(null);

  function requestClose(action: (...args: unknown[]) => unknown) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    pendingAction.current = action;
    setIsClosing(true);
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) {
      pendingAction.current?.();
      pendingAction.current = null;
    }
  }

  return (
    <div
      className={`${styles['delete-confirmation-box']}${isClosing ? ` ${styles.closing}` : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose(onClose);
      }}
    >
      <div onAnimationEnd={handleAnimationEnd}>
        <div>
          <h1>{title}</h1>
          <p>{content}</p>
        </div>
        <div>
          <button onClick={() => requestClose(onClose)}>{t.cancel}</button>
          <button onClick={() => requestClose(onDeleteConfirmation)}>{t.confirm}</button>
        </div>
      </div>
    </div>
  );
}
