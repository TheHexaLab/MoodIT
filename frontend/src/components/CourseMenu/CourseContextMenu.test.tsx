import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { CourseContextMenu } from './CourseContextMenu';
import { defaultLabels } from './labels';

afterEach(cleanup);

function renderMenu(props: Partial<React.ComponentProps<typeof CourseContextMenu>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <CourseContextMenu x={10} y={20} courseCode="IFT101" onClose={onClose} {...props} />
  );
  return { onClose, ...utils };
}

function labelsOf(menu: HTMLElement): string[] {
  return within(menu)
    .queryAllByRole('menuitem')
    .map((el) => el.textContent ?? '');
}

describe('CourseContextMenu', () => {
  it('porte un libellé accessible contenant le code du cours', () => {
    renderMenu();
    expect(screen.getByRole('menu', { name: defaultLabels.contextMenuAria('IFT101') })).toBeTruthy();
  });

  it('ne rend que les items dont le callback est fourni, dans l’ordre attendu', () => {
    renderMenu({
      onEditCourse: vi.fn(),
      onOpenMcp: vi.fn(),
      onDeleteCourse: vi.fn(),
      onLeaveCourse: vi.fn(),
    });
    expect(labelsOf(screen.getByRole('menu'))).toEqual([
      defaultLabels.contextEditCourse,
      defaultLabels.contextMcpManagement,
      defaultLabels.contextDeleteCourse,
      defaultLabels.contextLeaveCourse,
    ]);
    // Actions admin + « quitter » → séparateur présent.
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('« Quitter » seul (non-admin) : pas de séparateur', () => {
    renderMenu({ onLeaveCourse: vi.fn() });
    expect(labelsOf(screen.getByRole('menu'))).toEqual([defaultLabels.contextLeaveCourse]);
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('chaque item déclenche son propre callback', () => {
    const onEditCourse = vi.fn();
    const onOpenMcp = vi.fn();
    const onDeleteCourse = vi.fn();
    const onLeaveCourse = vi.fn();
    renderMenu({ onEditCourse, onOpenMcp, onDeleteCourse, onLeaveCourse });
    fireEvent.click(screen.getByRole('menuitem', { name: defaultLabels.contextMcpManagement }));
    expect(onOpenMcp).toHaveBeenCalledTimes(1);
    expect(onEditCourse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('menuitem', { name: defaultLabels.contextEditCourse }));
    expect(onEditCourse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('menuitem', { name: defaultLabels.contextDeleteCourse }));
    expect(onDeleteCourse).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('menuitem', { name: defaultLabels.contextLeaveCourse }));
    expect(onLeaveCourse).toHaveBeenCalledTimes(1);
  });

  it('Échap appelle onClose ; une autre touche non', () => {
    const { onClose } = renderMenu({ onLeaveCourse: vi.fn() });
    fireEvent.keyDown(document, { key: 'a' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown extérieur ferme ; mousedown dans le menu ne ferme pas', () => {
    const { onClose } = renderMenu({ onLeaveCourse: vi.fn() });
    fireEvent.mouseDown(screen.getByRole('menuitem'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resize et scroll ferment le menu', () => {
    const { onClose } = renderMenu({ onLeaveCourse: vi.fn() });
    fireEvent(window, new Event('resize'));
    fireEvent.scroll(document);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('est positionné à la coordonnée demandée (recalée dans le viewport)', () => {
    renderMenu({ onLeaveCourse: vi.fn() });
    const menu = screen.getByRole('menu');
    // jsdom mesure 0×0 : la position reste celle demandée (> marge de 8 px).
    expect(menu.style.left).toBe('10px');
    expect(menu.style.top).toBe('20px');
  });

  it('le menu natif est bloqué sur le menu lui-même', () => {
    renderMenu({ onLeaveCourse: vi.fn() });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    screen.getByRole('menu').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
