import React, { useRef, useState } from 'react';
import styles from './DeleteConfirmationPopup.module.css';
import { defaultLabels } from './labels.ts';
import type { DeleteConfirmationPopupLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ce type depuis ce module.
export type { DeleteConfirmationPopupLabels } from './types.ts';

interface DeleteConfirmationPopupProps {
  title: string;
  content: string;
  onDeleteConfirmation: (...args: unknown[]) => unknown;
  onClose: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<DeleteConfirmationPopupLabels>;
}

export function DeleteConfirmationPopup({
  title,
  content,
  onDeleteConfirmation,
  onClose,
  labels,
}: DeleteConfirmationPopupProps): React.ReactElement {
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
      className={`${styles['delete-confirmation-popup']}${isClosing ? ` ${styles.closing}` : ''}`}
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
