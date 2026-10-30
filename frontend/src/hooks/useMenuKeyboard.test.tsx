import React, { useRef, useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  OPTION_SELECTOR,
  isContextMenuKey,
  useMenuKeyboard,
  type MenuInitialFocus,
} from './useMenuKeyboard';

afterEach(cleanup);

interface HarnessProps {
  initialFocus?: MenuInitialFocus;
  withEscape?: boolean;
  /** Liste d'options (listbox) plutôt que menu ; `selected` = option choisie. */
  listbox?: { selected?: string };
  onParentKeyDown?: () => void;
}

/** Déclencheur + menu à trois éléments suivis d'un élément désactivé (ou liste à recherche). */
function Harness({ initialFocus, withEscape = true, listbox, onParentKeyDown }: HarnessProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const onKeyDown = useMenuKeyboard({
    open,
    containerRef,
    initialFocus,
    itemSelector: listbox ? `input, ${OPTION_SELECTOR}` : undefined,
    onEscape: withEscape ? () => setOpen(false) : undefined,
    returnFocus: () => triggerRef.current,
  });
  const items = ['Un', 'Deux', 'Trois'];
  return (
    <div onKeyDown={onParentKeyDown}>
      <button type="button" ref={triggerRef} onClick={() => setOpen(true)}>
        Ouvrir
      </button>
      {open && (
        <div
          ref={containerRef}
          role={listbox ? 'listbox' : 'menu'}
          aria-label="Liste"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {listbox && <input aria-label="Recherche" />}
          {items.map((label) => (
            <button
              key={label}
              type="button"
              role={listbox ? 'option' : 'menuitem'}
              aria-selected={listbox ? listbox.selected === label : undefined}
            >
              {label}
            </button>
          ))}
          {!listbox && (
            <button type="button" role="menuitem" disabled>
              Désactivé
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const focused = () => document.activeElement?.textContent || document.activeElement?.getAttribute('aria-label');

async function openWith(props: HarnessProps = {}) {
  const user = userEvent.setup();
  render(<Harness {...props} />);
  await user.click(screen.getByRole('button', { name: 'Ouvrir' }));
  return user;
}

describe('useMenuKeyboard', () => {
  it('focus sur le premier élément à l’ouverture (défaut), flèches circulaires', async () => {
    const user = await openWith();
    expect(focused()).toBe('Un');
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Deux');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    // Le dernier élément (désactivé) est sauté : retour au premier.
    expect(focused()).toBe('Un');
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Trois');
  });

  it('Début et Fin vont au premier et au dernier élément actif', async () => {
    const user = await openWith();
    await user.keyboard('{End}');
    expect(focused()).toBe('Trois');
    await user.keyboard('{Home}');
    expect(focused()).toBe('Un');
  });

  it('focus sur le conteneur : ↓ mène au premier élément, ↑ au dernier', async () => {
    const user = await openWith({ initialFocus: 'container' });
    expect(document.activeElement).toBe(screen.getByRole('menu'));
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Un');
    screen.getByRole('menu').focus();
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Trois');
  });

  it('focus sur l’option choisie (listbox), sinon la première', async () => {
    await openWith({ initialFocus: 'selected', listbox: { selected: 'Deux' } });
    expect(focused()).toBe('Deux');
    cleanup();
    await openWith({ initialFocus: 'selected', listbox: {} });
    expect(focused()).toBe('Recherche');
  });

  it('`none` ne déplace pas le focus ; ↓ depuis la recherche mène aux options', async () => {
    const user = await openWith({ initialFocus: 'none', listbox: {} });
    expect(focused()).toBe('Ouvrir');
    screen.getByRole('textbox', { name: 'Recherche' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(focused()).toBe('Un');
    await user.keyboard('{ArrowUp}');
    expect(focused()).toBe('Recherche');
  });

  it('Début/Fin dans un champ texte restent au champ (curseur)', async () => {
    const user = await openWith({ initialFocus: 'none', listbox: {} });
    const input = screen.getByRole('textbox', { name: 'Recherche' });
    input.focus();
    await user.keyboard('{End}{Home}');
    expect(document.activeElement).toBe(input);
  });

  it('Échap ferme, rend le focus au déclencheur et ne remonte pas au parent', async () => {
    const onParentKeyDown = vi.fn();
    const user = await openWith({ onParentKeyDown });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(focused()).toBe('Ouvrir');
    expect(onParentKeyDown).not.toHaveBeenCalled();
  });

  it('sans onEscape, Échap n’est pas traité (remonte au parent)', async () => {
    const onParentKeyDown = vi.fn();
    const user = await openWith({ withEscape: false, onParentKeyDown });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(onParentKeyDown).toHaveBeenCalled();
  });

  it('une autre touche n’est pas interceptée', async () => {
    await openWith();
    expect(fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Un' }), { key: 'a' })).toBe(true);
    expect(focused()).toBe('Un');
  });

  it('sans élément navigable, les flèches ne font rien', () => {
    function Empty() {
      const containerRef = useRef<HTMLDivElement | null>(null);
      const onKeyDown = useMenuKeyboard({ open: true, containerRef });
      return <div ref={containerRef} role="menu" aria-label="Vide" tabIndex={-1} onKeyDown={onKeyDown} />;
    }
    render(<Empty />);
    expect(fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })).toBe(true);
  });
});

describe('isContextMenuKey', () => {
  const key = (init: Partial<React.KeyboardEvent>) => init as React.KeyboardEvent;
  it('reconnaît la touche Menu et Maj+F10, pas F10 seule', () => {
    expect(isContextMenuKey(key({ key: 'ContextMenu', shiftKey: false }))).toBe(true);
    expect(isContextMenuKey(key({ key: 'F10', shiftKey: true }))).toBe(true);
    expect(isContextMenuKey(key({ key: 'F10', shiftKey: false }))).toBe(false);
    expect(isContextMenuKey(key({ key: 'Enter', shiftKey: true }))).toBe(false);
  });
});
