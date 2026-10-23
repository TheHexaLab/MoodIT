import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Popup } from './Popup';
import { usePopupController } from './popupController';
import { PopupVariant } from './popupVariant';

// jsdom ne fournit pas matchMedia ; reduced-motion → fermeture immédiate (pas d'animationend).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});

function Host({
  onClose,
  variant = PopupVariant.Form,
  closeOnEscape,
  nested,
}: {
  onClose: () => void;
  variant?: PopupVariant;
  closeOnEscape?: boolean;
  nested?: React.ReactNode;
}) {
  const popup = usePopupController();
  return (
    <Popup
      variant={variant}
      label="Titre du test"
      onClose={onClose}
      controller={popup}
      closeOnEscape={closeOnEscape}
    >
      <h1>Titre du test</h1>
      <input placeholder="Nom" />
      <button type="button" onClick={() => popup.requestClose(onClose)}>
        Annuler
      </button>
      <button type="button" onClick={() => popup.requestClose(() => onClose())}>
        Valider
      </button>
      {nested}
    </Popup>
  );
}

const focused = () => document.activeElement;

describe('Popup', () => {
  it('est un dialogue modal nommé, porté dans body, dont le panneau est le div enfant du voile', () => {
    const { container } = render(<Host onClose={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'Titre du test' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.contains(dialog)).toBe(false); // portail
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.dataset.variant).toBe('form');
    expect(overlay.firstElementChild).toBe(dialog);
  });

  it("déplace le focus sur le premier champ à l'ouverture et le rend au déclencheur à la fermeture", () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<Host onClose={() => {}} />);
    expect(focused()).toBe(screen.getByPlaceholderText('Nom'));
    unmount();
    expect(focused()).toBe(trigger);
    trigger.remove();
  });

  it('confine Tab et Maj+Tab dans le panneau', () => {
    render(<Host onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const input = screen.getByPlaceholderText('Nom');
    const last = screen.getByRole('button', { name: 'Valider' });
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(focused()).toBe(input);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(focused()).toBe(last);
  });

  it('Échap et le clic sur le voile ferment ; un bouton ferme via le contrôleur', () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    // Clic qui COMMENCE dans le panneau et finit sur le voile (sélection de texte) : ne ferme pas.
    fireEvent.mouseDown(screen.getByRole('dialog'));
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("Échap peut être désactivé, et un Échap déjà traité par le contenu n'est pas repris", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Host onClose={onClose} closeOnEscape={false} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    unmount();

    render(<Host onClose={onClose} />);
    const input = screen.getByPlaceholderText('Nom');
    input.addEventListener('keydown', (e) => e.preventDefault());
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Échap dans une popup imbriquée ne ferme pas la popup parente', () => {
    const onCloseParent = vi.fn();
    const onCloseChild = vi.fn();
    render(
      <Host
        onClose={onCloseParent}
        nested={
          <Popup variant={PopupVariant.Confirm} label="Confirmer" onClose={onCloseChild}>
            <h2>Confirmer</h2>
            <button type="button">OK</button>
          </Popup>
        }
      />
    );
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Confirmer' }), { key: 'Escape' });
    expect(onCloseChild).toHaveBeenCalledTimes(1);
    expect(onCloseParent).not.toHaveBeenCalled();
  });

  it('la variante Alert a le rôle alertdialog', () => {
    render(<Host onClose={() => {}} variant={PopupVariant.Alert} />);
    expect(screen.getByRole('alertdialog', { name: 'Titre du test' })).toBeTruthy();
  });
});
