import React, { useEffect, useRef, useState } from 'react';
import styles from './ErrorPopup.module.css';
import { defaultLabels } from './labels.ts';
import type { ErrorPopupLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ce type depuis ce module.
export type { ErrorPopupLabels } from './types.ts';

interface ErrorPopupProps {
  /** Message décrivant l'erreur. */
  content: string;
  /** Fermeture (clic en dehors, bouton « fermer »). */
  onClose: (...args: unknown[]) => unknown;
  /** Si fourni, affiche un bouton « réessayer » qui exécute cette action. */
  onRetry?: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<ErrorPopupLabels>;
}

/**
 * Petit popup d'erreur réutilisable (même esprit que DeleteConfirmationPopup).
 * Affiche un titre, un message, un bouton « fermer » et, optionnellement, « réessayer ».
 */
export function ErrorPopup({
  content,
  onClose,
  onRetry,
  labels,
}: ErrorPopupProps): React.ReactElement {
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

  // « Entrée » ferme le popup (raccourci, comme un clic sur « fermer »).
  // Ecoute en phase CAPTURE + stopPropagation : on intercepte la touche avant
  // qu'elle n'atteigne un champ sous-jacent (ex. la zone de saisie de ChannelView,
  // qui sinon enverrait un message en meme temps qu'on ferme le popup).
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (!isClosing) requestClose(onClose);
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isClosing, onClose]);

  return (
    <div
      className={`${styles['error-popup']}${isClosing ? ` ${styles.closing}` : ''}`}
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
            <button type="button" className={styles.primary} onClick={() => requestClose(onRetry)}>
              {t.retry}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
