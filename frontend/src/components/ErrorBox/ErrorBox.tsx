import React, { useRef, useState } from 'react';
import styles from './ErrorBox.module.css';

interface ErrorBoxProps {
  /** Titre du panneau (défaut : « Une erreur est survenue »). */
  title?: string;
  /** Message décrivant l'erreur. */
  content: string;
  /** Fermeture (clic en dehors, bouton « fermer »). */
  onClose: (...args: unknown[]) => unknown;
  /** Si fourni, affiche un bouton « réessayer » qui exécute cette action. */
  onRetry?: (...args: unknown[]) => unknown;
  /** Libellé du bouton de fermeture (défaut « Fermer »). */
  closeLabel?: string;
  /** Libellé du bouton de réessai (défaut « Réessayer »). */
  retryLabel?: string;
}

/**
 * Petit popup d'erreur réutilisable (même esprit que DeleteConfirmationBox).
 * Affiche un titre, un message, un bouton « fermer » et, optionnellement, « réessayer ».
 */
export function ErrorBox({
  title = 'Une erreur est survenue',
  content,
  onClose,
  onRetry,
  closeLabel = 'Fermer',
  retryLabel = 'Réessayer',
}: ErrorBoxProps): React.ReactElement {
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
      className={`${styles['error-box']}${isClosing ? ` ${styles.closing}` : ''}`}
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
          <button
            type="button"
            className={onRetry ? styles.secondary : styles.primary}
            onClick={() => requestClose(onClose)}
          >
            {closeLabel}
          </button>
          {onRetry && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => requestClose(onRetry)}
            >
              {retryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
