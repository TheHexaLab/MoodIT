import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorShell, EditorFooter } from './EditorShell';

/**
 * Coquille de l'éditeur de quiz : hauteur animée = somme des rangées (en-tête, corps, pied),
 * bornée au viewport (et à `desktopMaxVh` sur grand écran) ; défilement du corps seulement si le
 * contenu est borné. jsdom ne calculant pas de mise en page, les hauteurs sont simulées.
 */

const VIEWPORT_MARGIN = 48;
let heights: { header: number; content: number; footer: number };
let mobile: boolean;
let borders: { top: string; bottom: string };
const realGetComputedStyle = window.getComputedStyle;

beforeEach(() => {
  heights = { header: 50, content: 200, footer: 40 };
  mobile = false;
  borders = { top: '', bottom: '' };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      // Mouvement réduit : fermetures immédiates. `(max-width: 30rem)` : disposition mobile.
      matches: query.includes('reduce') ? true : query.includes('max-width') ? mobile : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const c = this.className ?? '';
      if (c.includes('panelBodyInner')) return heights.content;
      if (c.includes('panelFooter')) return heights.footer;
      if (this.tagName === 'HEADER') return heights.header;
      return 0;
    },
  });
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const real = realGetComputedStyle(el, pseudo);
    if ((el as HTMLElement).getAttribute?.('role') !== 'dialog') return real;
    return { ...real, borderTopWidth: borders.top, borderBottomWidth: borders.bottom } as CSSStyleDeclaration;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { offsetHeight?: number }).offsetHeight;
});

function renderShell(props: Partial<React.ComponentProps<typeof EditorShell>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <EditorShell title="Éditeur" onClose={onClose} {...props}>
      <p>Contenu</p>
      <EditorFooter>
        <button type="button">Enregistrer</button>
      </EditorFooter>
    </EditorShell>
  );
  const panel = () => screen.getByRole('dialog');
  const body = () => panel().querySelector('[class*="panelBody"]:not([class*="panelBodyInner"])') as HTMLElement;
  return { onClose, panel, body, ...utils };
}

describe('EditorShell — hauteur du panneau', () => {
  it('contenu court : hauteur = en-tête + corps + pied, sans défilement du corps', () => {
    const { panel, body } = renderShell({ scrollBody: true });
    expect(panel().style.height).toBe('290px');
    expect(body().style.overflowY).toBe('hidden');
  });

  it('contenu trop haut : bornée au viewport (moins la marge) ; le corps défile si scrollBody', () => {
    heights.content = 2000;
    const { panel, body } = renderShell({ scrollBody: true });
    expect(panel().style.height).toBe(`${window.innerHeight - VIEWPORT_MARGIN}px`);
    expect(body().style.overflowY).toBe('auto');
  });

  it('contenu trop haut sans scrollBody : bornée, mais le corps ne défile pas', () => {
    heights.content = 2000;
    const { body } = renderShell();
    expect(body().style.overflowY).toBe('hidden');
  });

  it('bordures du panneau comptées dans la hauteur naturelle', () => {
    borders = { top: '2px', bottom: '3px' };
    const { panel } = renderShell();
    expect(panel().style.height).toBe('295px');
  });

  it('desktopMaxVh borne la hauteur sur grand écran, pas sur mobile', () => {
    heights.content = 2000;
    const desktop = renderShell({ desktopMaxVh: 50 });
    expect(desktop.panel().style.height).toBe(`${window.innerHeight * 0.5}px`);
    cleanup();
    mobile = true;
    const small = renderShell({ desktopMaxVh: 50 });
    expect(small.panel().style.height).toBe(`${window.innerHeight - VIEWPORT_MARGIN}px`);
  });

  it('redimensionner la fenêtre remesure ; le démontage retire l’écouteur', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { panel, unmount } = renderShell();
    heights.content = 300;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(panel().style.height).toBe('390px');
    unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('pas d’animation de taille à l’ouverture, puis activée à l’image suivante', () => {
    let frame: FrameRequestCallback | undefined;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { panel } = renderShell();
    expect(panel().style.transition).toBe('none');
    act(() => frame?.(0));
    expect(panel().style.transition).toBe('');
  });
});

describe('EditorShell — en-tête et navigation', () => {
  it('sous-titre affiché seulement s’il est fourni', () => {
    renderShell({ subtitle: 'Question 2' });
    expect(screen.getByText('Question 2').tagName).toBe('P');
    cleanup();
    renderShell();
    expect(screen.getByRole('dialog').querySelector('header p')).toBeNull();
  });

  it('chevron « Retour » seulement avec onBack', () => {
    const onBack = vi.fn();
    renderShell({ onBack });
    fireEvent.click(screen.getByLabelText('Retour'));
    expect(onBack).toHaveBeenCalledTimes(1);
    cleanup();
    renderShell();
    expect(screen.queryByLabelText('Retour')).toBeNull();
  });

  it('croix sans garde : ferme directement', () => {
    const { onClose } = renderShell();
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('croix avec garde : le garde décide (proceed ferme vraiment)', () => {
    let proceed: (() => void) | undefined;
    const { onClose } = renderShell({ onCloseGuard: (p) => (proceed = p) });
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(onClose).not.toHaveBeenCalled();
    proceed?.();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Échap ferme par défaut, mais pas si closeOnEscape vaut false', () => {
    const open = renderShell();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(open.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    const locked = renderShell({ closeOnEscape: false });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(locked.onClose).not.toHaveBeenCalled();
  });

  it('changer de vue (scrollResetKey) remet le corps défilé en haut', () => {
    const { body, rerender } = renderShell({ scrollResetKey: 'a' });
    body().scrollTop = 120;
    rerender(
      <EditorShell title="Éditeur" onClose={() => {}} scrollResetKey="a">
        <p>Contenu</p>
      </EditorShell>
    );
    expect(body().scrollTop).toBe(120); // même vue : position conservée
    rerender(
      <EditorShell title="Éditeur" onClose={() => {}} scrollResetKey="b">
        <p>Contenu</p>
      </EditorShell>
    );
    expect(body().scrollTop).toBe(0);
  });
});
