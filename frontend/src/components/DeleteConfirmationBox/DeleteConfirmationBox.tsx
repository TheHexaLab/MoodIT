import React, { useRef, useState } from 'react';
import styles from './DeleteConfirmationBox.module.css';

interface DeleteConfirmationBoxProps {
  title: string;
  content: string;
  onDeleteConfirmation: (...args: unknown[]) => unknown;
  onClose: (...args: unknown[]) => unknown;
}

export function DeleteConfirmationBox({
  title,
  content,
  onDeleteConfirmation,
  onClose,
}: DeleteConfirmationBoxProps): React.ReactElement {
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
          <button onClick={() => requestClose(onClose)}>Annuler</button>
          <button onClick={() => requestClose(onDeleteConfirmation)}>Supprimer</button>
        </div>
      </div>
    </div>
  );
}
