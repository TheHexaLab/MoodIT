import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { Dropdown, type DropdownOption } from './Dropdown';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS: DropdownOption[] = [
  { value: 'py', label: 'Python' },
  { value: 'c', label: 'C' },
  { value: 'js', label: 'JavaScript' },
];

function renderDropdown(value = 'py', onChange = vi.fn(), parentKeyDown = vi.fn()) {
  const utils = render(
    // Parent qui écoute les touches : simule la coquille Popup (ferme sur Échap non traité).
    <div onKeyDown={parentKeyDown}>
      <button type="button">Dehors</button>
      <Dropdown value={value} options={OPTIONS} onChange={onChange} ariaLabel="Langage" />
    </div>
  );
  return { onChange, parentKeyDown, ...utils };
}

function control(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Langage/ }) as HTMLButtonElement;
}

/** Simule la position du contrôle à l'écran (jsdom ne fait pas de mise en page). */
function mockControlRect(rect: { top: number; bottom: number; left: number; width: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('aria-label')?.startsWith('Langage')) {
      return { ...rect, right: rect.left + rect.width, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}) } as DOMRect;
    }
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
}

describe('Dropdown', () => {
  it('affiche le libellé de l’option courante, menu fermé', () => {
    renderDropdown('c');
    expect(control().textContent).toBe('C');
    expect(control().getAttribute('aria-expanded')).toBe('false');
    expect(control().getAttribute('aria-haspopup')).toBe('listbox');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('nom accessible : libellé du contrôle suivi de l’option affichée (WCAG 2.5.3)', () => {
    renderDropdown('js');
    expect(screen.getByRole('button', { name: 'Langage : JavaScript' })).toBeTruthy();
  });

  it('valeur inconnue → nom accessible réduit au libellé du contrôle', () => {
    renderDropdown('inconnu');
    expect(screen.getByRole('button', { name: 'Langage' })).toBeTruthy();
  });

  it('valeur inconnue → libellé vide', () => {
    renderDropdown('inconnu');
    expect(control().textContent).toBe('');
  });

  it('clic sur le contrôle : ouvre le menu (porté dans body) puis le referme', () => {
    const { container } = renderDropdown('c');
    fireEvent.click(control());
    expect(control().getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    // Porté hors du conteneur du composant.
    expect(container.contains(listbox)).toBe(false);
    expect(document.body.contains(listbox)).toBe(true);
    // Option courante marquée sélectionnée, les autres non.
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(control());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('choisir une option appelle onChange avec sa valeur et ferme le menu', () => {
    const { onChange } = renderDropdown('py');
    fireEvent.click(control());
    fireEvent.click(screen.getByRole('option', { name: 'JavaScript' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('js');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(control().getAttribute('aria-expanded')).toBe('false');
  });

  it('Échap (menu ouvert) : ferme, rend le focus au contrôle et ne remonte PAS au parent', () => {
    const { parentKeyDown } = renderDropdown();
    fireEvent.click(control());
    const option = screen.getByRole('option', { name: 'C' });
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(control());
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('Échap (menu fermé) : remonte au parent (la popup peut se fermer)', () => {
    const { parentKeyDown } = renderDropdown();
    fireEvent.keyDown(control(), { key: 'Escape' });
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  it('une autre touche (menu ouvert) ne ferme pas le menu et remonte au parent', () => {
    const { parentKeyDown } = renderDropdown();
    fireEvent.click(control());
    fireEvent.keyDown(control(), { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
  });

  it('Échap au niveau du document (hors du composant) ferme le menu', () => {
    renderDropdown();
    fireEvent.click(control());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('clic extérieur ferme le menu ; clic dans le menu ou le contrôle non', () => {
    renderDropdown();
    fireEvent.click(control());
    fireEvent.mouseDown(screen.getByRole('option', { name: 'C' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(control());
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Dehors' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('défilement de la page ferme le menu ; défilement interne de la liste non', () => {
    renderDropdown();
    fireEvent.click(control());
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.scroll(document);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('place le menu sous le contrôle quand il y a la place', () => {
    mockControlRect({ top: 100, bottom: 130, left: 20, width: 200 });
    renderDropdown();
    fireEvent.click(control());
    const style = screen.getByRole('listbox').style;
    expect(style.position).toBe('fixed');
    expect(style.top).toBe('134px');
    expect(style.left).toBe('20px');
    expect(style.width).toBe('200px');
    expect(style.visibility).toBe('');
  });

  it('bascule le menu au-dessus quand il manque de place en dessous', () => {
    // jsdom : innerHeight = 768 → 38 px sous le contrôle (< 160), plus de place au-dessus.
    mockControlRect({ top: 700, bottom: 730, left: 0, width: 100 });
    renderDropdown();
    fireEvent.click(control());
    const style = screen.getByRole('listbox').style;
    expect(style.bottom).toBe(`${window.innerHeight - 700 + 4}px`);
    expect(style.top).toBe('auto');
  });

  it('recalcule la position au redimensionnement de la fenêtre', () => {
    mockControlRect({ top: 100, bottom: 130, left: 20, width: 200 });
    renderDropdown();
    fireEvent.click(control());
    expect(screen.getByRole('listbox').style.top).toBe('134px');
    vi.restoreAllMocks();
    mockControlRect({ top: 300, bottom: 340, left: 50, width: 120 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const style = screen.getByRole('listbox').style;
    expect(style.top).toBe('344px');
    expect(style.left).toBe('50px');
    expect(style.width).toBe('120px');
  });
});
