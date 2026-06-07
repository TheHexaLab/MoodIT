import React, { useRef, useState } from 'react';
import styles from './ErrorBox.module.css';

interface ErrorBoxProps {
  /** Message décrivant l'erreur. */
  content: string;
  /** Fermeture (clic en dehors, bouton « fermer »). */
  onClose: (...args: unknown[]) => unknown;
  /** Si fourni, affiche un bouton « réessayer » qui exécute cette action. */
  onRetry?: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<ErrorBoxLabels>;
}

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface ErrorBoxLabels {
  /** Titre du panneau. */
  title: string;
  /** Libellé du bouton de fermeture. */
  close: string;
  /** Libellé du bouton de réessai. */
  retry: string;
}

/**
 * Tous les textes par défaut affichés par le composant.
 */
const defaultLabels: ErrorBoxLabels = {
  title: 'Une erreur est survenue',
  close: 'Fermer',
  retry: 'Réessayer',
};

/**
 * Petit popup d'erreur réutilisable (même esprit que DeleteConfirmationBox).
 * Affiche un titre, un message, un bouton « fermer » et, optionnellement, « réessayer ».
 */
export function ErrorBox({
  content,
  onClose,
  onRetry,
  labels,
}: ErrorBoxProps): React.ReactElement {
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
      className={`${styles['error-box']}${isClosing ? ` ${styles.closing}` : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose(onClose);
      }}
    >
      <div onAnimationEnd={handleAnimationEnd}>
        <div>
          <h1>{t.title}</h1>
          <p>{content}</p>
        </div>
        <div>
          <button
            type="button"
            className={onRetry ? styles.secondary : styles.primary}
            onClick={() => requestClose(onClose)}
          >
            {t.close}
          </button>
          {onRetry && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => requestClose(onRetry)}
            >
              {t.retry}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
