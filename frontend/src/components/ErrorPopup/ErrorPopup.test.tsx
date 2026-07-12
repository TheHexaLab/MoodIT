import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ErrorPopup } from './ErrorPopup';
import { defaultLabels } from './labels';

// Le composant déclenche l'action de fermeture immédiatement quand l'utilisateur préfère
// « reduced motion » (pas d'attente d'animationend). On force ce mode pour tester la logique
// sans dépendre d'événements d'animation (non émis par jsdom).
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

beforeEach(() => {
  localStorage.clear();
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ErrorPopup', () => {
  it('affiche le titre par défaut et le message', () => {
    render(<ErrorPopup content="Boom" onClose={vi.fn()} />);
    expect(screen.getByRole('heading').textContent).toBe(defaultLabels.title);
    expect(screen.getByText('Boom')).toBeTruthy();
  });

  it('affiche un titre personnalisé via labels', () => {
    render(
      <ErrorPopup content="x" onClose={vi.fn()} labels={{ title: 'Oups' }} />
    );
    expect(screen.getByRole('heading').textContent).toBe('Oups');
  });

  it('sans onRetry, n’affiche que le bouton fermer', () => {
    render(<ErrorPopup content="x" onClose={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe(defaultLabels.close);
  });

  it('avec onRetry, affiche fermer et réessayer', () => {
    render(<ErrorPopup content="x" onClose={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText(defaultLabels.close)).toBeTruthy();
    expect(screen.getByText(defaultLabels.retry)).toBeTruthy();
  });

  it('le bouton fermer appelle onClose', () => {
    const onClose = vi.fn();
    render(<ErrorPopup content="x" onClose={onClose} />);
    fireEvent.click(screen.getByText(defaultLabels.close));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('le bouton réessayer appelle onRetry (pas onClose)', () => {
    const onClose = vi.fn();
    const onRetry = vi.fn();
    render(<ErrorPopup content="x" onClose={onClose} onRetry={onRetry} />);
    fireEvent.click(screen.getByText(defaultLabels.retry));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('la touche Entrée ferme le popup (appelle onClose)', () => {
    const onClose = vi.fn();
    render(<ErrorPopup content="x" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('libellés personnalisés des boutons', () => {
    render(
      <ErrorPopup
        content="x"
        onClose={vi.fn()}
        onRetry={vi.fn()}
        labels={{ close: 'Non', retry: 'Encore' }}
      />
    );
    expect(screen.getByText('Non')).toBeTruthy();
    expect(screen.getByText('Encore')).toBeTruthy();
  });
});
