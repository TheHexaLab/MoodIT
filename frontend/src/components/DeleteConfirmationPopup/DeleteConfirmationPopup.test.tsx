import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { DeleteConfirmationPopup } from './DeleteConfirmationPopup';
import { defaultLabels } from './labels';

// Fermeture immédiate (pas d'attente d'animationend, non émis par jsdom) via reduced-motion.
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

/**
 * Fin d'animation : jsdom n'expose pas `AnimationEvent`, donc React écoute le nom préfixé
 * `webkitAnimationEnd` (et non `animationend`) — on dispatch ce nom-là.
 */
function fireAnimationEnd(el: HTMLElement) {
  fireEvent(el, new Event('webkitAnimationEnd', { bubbles: true }));
}

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof DeleteConfirmationPopup>> = {}) {
  const onClose = vi.fn();
  const onDeleteConfirmation = vi.fn();
  const utils = render(
    <DeleteConfirmationPopup
      title="Supprimer le cours ?"
      content="Cette action est irréversible."
      onClose={onClose}
      onDeleteConfirmation={onDeleteConfirmation}
      {...overrides}
    />
  );
  return { onClose, onDeleteConfirmation, ...utils };
}

describe('DeleteConfirmationPopup', () => {
  it('affiche le titre et le contenu reçus', () => {
    renderPopup();
    expect(screen.getByRole('heading').textContent).toBe('Supprimer le cours ?');
    expect(screen.getByText('Cette action est irréversible.')).toBeTruthy();
  });

  it('affiche les boutons annuler et supprimer par défaut', () => {
    renderPopup();
    expect(screen.getByText(defaultLabels.cancel)).toBeTruthy();
    expect(screen.getByText(defaultLabels.confirm)).toBeTruthy();
  });

  it('« Annuler » appelle onClose et pas onDeleteConfirmation', () => {
    const { onClose, onDeleteConfirmation } = renderPopup();
    fireEvent.click(screen.getByText(defaultLabels.cancel));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDeleteConfirmation).not.toHaveBeenCalled();
  });

  it('« Supprimer » appelle onDeleteConfirmation et pas onClose', () => {
    const { onClose, onDeleteConfirmation } = renderPopup();
    fireEvent.click(screen.getByText(defaultLabels.confirm));
    expect(onDeleteConfirmation).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cliquer sur le voile (hors de la boîte) ferme le popup', () => {
    const { onClose, container } = renderPopup();
    fireEvent.click(container.firstElementChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cliquer dans la boîte ne ferme pas le popup', () => {
    const { onClose } = renderPopup();
    fireEvent.click(screen.getByText('Cette action est irréversible.'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('surcharge des libellés via labels', () => {
    renderPopup({ labels: { cancel: 'Non', confirm: 'Oui, supprimer' } });
    expect(screen.getByText('Non')).toBeTruthy();
    expect(screen.getByText('Oui, supprimer')).toBeTruthy();
  });

  it('sans reduced-motion, l’action attend la fin de l’animation de sortie', () => {
    stubReducedMotion(false);
    const { onDeleteConfirmation, container } = renderPopup();
    fireEvent.click(screen.getByText(defaultLabels.confirm));
    // Pas encore exécutée : on attend animationend sur la boîte.
    expect(onDeleteConfirmation).not.toHaveBeenCalled();
    const box = (container.firstElementChild as HTMLElement).firstElementChild as HTMLElement;
    fireAnimationEnd(box);
    expect(onDeleteConfirmation).toHaveBeenCalledTimes(1);
  });
});
