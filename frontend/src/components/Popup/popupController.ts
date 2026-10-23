import { useState } from 'react';

export type CloseAction = (...args: unknown[]) => unknown;

/**
 * Poignée de fermeture d'une popup, à créer avec `usePopupController()` dans le composant qui
 * rend `<Popup controller={…}>`. `requestClose(action)` joue l'animation de sortie puis exécute
 * `action` (par défaut le `onClose` de la popup). Tant que la popup n'est pas montée, l'action est
 * exécutée immédiatement.
 */
export class PopupController {
  private impl: ((action?: CloseAction) => void) | null = null;

  /** Interne : liaison posée par `Popup` au montage, retirée au démontage. */
  bind(impl: ((action?: CloseAction) => void) | null): void {
    this.impl = impl;
  }

  requestClose = (action?: CloseAction): void => {
    if (this.impl) this.impl(action);
    else action?.();
  };
}

export function usePopupController(): PopupController {
  return useState(() => new PopupController())[0];
}
