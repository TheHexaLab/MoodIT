import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { usePointerReorder } from './usePointerReorder';

afterEach(cleanup);

/**
 * Le hook s'appuie sur les Pointer Events globaux (window), document.elementFromPoint,
 * data-reorder-id et setPointerCapture. On simule ces éléments dans jsdom.
 */

// --- Helpers pour construire des rangées DOM détectables via data-reorder-id --------------
function buildRows(ids: number[]) {
  const container = document.createElement('div');
  const rowById = new Map<number, HTMLElement>();
  ids.forEach((id) => {
    const row = document.createElement('div');
    row.setAttribute('data-reorder-id', String(id));
    container.appendChild(row);
    rowById.set(id, row);
  });
  document.body.appendChild(container);
  return { container, rowById };
}

// Fabrique un React.PointerEvent minimal pour onGripPointerDown.
function makeGripEvent(pointerType: 'mouse' | 'touch' = 'mouse', button = 0) {
  const handle = document.createElement('span');
  document.body.appendChild(handle);
  const setPointerCapture = vi.fn();
  (handle as unknown as { setPointerCapture: unknown }).setPointerCapture = setPointerCapture;
  return {
    event: {
      pointerType,
      button,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: handle,
    } as unknown as React.PointerEvent,
    handle,
    setPointerCapture,
  };
}

// jsdom n'implémente pas elementFromPoint : on l'installe pour pouvoir le stubber.
function setElementFromPoint(el: Element | null) {
  (document as unknown as { elementFromPoint: (x: number, y: number) => Element | null })
    .elementFromPoint = () => el;
}

// Fait pointer elementFromPoint vers la rangée d'un id donné.
function pointElementAt(rowById: Map<number, HTMLElement>, id: number) {
  setElementFromPoint(rowById.get(id)!);
}

function firePointerMove(x = 0, y = 0) {
  const ev = new Event('pointermove') as PointerEvent;
  Object.assign(ev, { clientX: x, clientY: y });
  window.dispatchEvent(ev);
}

function firePointerUp() {
  window.dispatchEvent(new Event('pointerup'));
}

describe('usePointerReorder', () => {
  it('expose l\'ordre initial = ids, sans glissement', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    expect(result.current.order).toEqual([1, 2, 3]);
    expect(result.current.draggingId).toBeNull();
    expect(typeof result.current.onGripPointerDown).toBe('function');
  });

  it('ignore un clic droit de souris (button !== 0)', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event, setPointerCapture } = makeGripEvent('mouse', 2);
    act(() => result.current.onGripPointerDown(event, 1));
    expect(result.current.draggingId).toBeNull();
    expect(setPointerCapture).not.toHaveBeenCalled();
  });

  it('démarre un glissement au pointerdown gauche : draggingId + capture', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event, setPointerCapture } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 2));
    expect(result.current.draggingId).toBe(2);
    expect(result.current.order).toEqual([1, 2, 3]);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(setPointerCapture).toHaveBeenCalledWith(1);
    // nettoyage : relâche
    act(() => firePointerUp());
  });

  it('réordonne pendant le déplacement au-dessus d\'une autre rangée', () => {
    const onReorder = vi.fn();
    const { rowById } = buildRows([1, 2, 3]);
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 1));

    // On glisse la ligne 1 au-dessus de la ligne 3.
    pointElementAt(rowById, 3);
    act(() => firePointerMove(10, 30));
    expect(result.current.order).toEqual([2, 3, 1]);
  });

  it('commit onReorder au relâchement seulement si l\'ordre a changé', () => {
    const onReorder = vi.fn();
    const { rowById } = buildRows([1, 2, 3]);
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 1));
    pointElementAt(rowById, 2);
    act(() => firePointerMove(10, 20));
    expect(result.current.order).toEqual([2, 1, 3]);
    act(() => firePointerUp());
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith([2, 1, 3]);
    expect(result.current.draggingId).toBeNull();
    // après relâchement, order suit à nouveau ids
    expect(result.current.order).toEqual([1, 2, 3]);
  });

  it('ne commit PAS onReorder sur un simple clic (aucun déplacement)', () => {
    const onReorder = vi.fn();
    buildRows([1, 2, 3]);
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 1));
    act(() => firePointerUp());
    expect(onReorder).not.toHaveBeenCalled();
    expect(result.current.draggingId).toBeNull();
  });

  it('ignore un survol de sa propre rangée (overId === id)', () => {
    const onReorder = vi.fn();
    const { rowById } = buildRows([1, 2, 3]);
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 2));
    pointElementAt(rowById, 2);
    act(() => firePointerMove(0, 0));
    expect(result.current.order).toEqual([1, 2, 3]);
    act(() => firePointerUp());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignore un déplacement hors de toute rangée (elementFromPoint null)', () => {
    const onReorder = vi.fn();
    buildRows([1, 2, 3]);
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event } = makeGripEvent('mouse', 0);
    act(() => result.current.onGripPointerDown(event, 1));
    setElementFromPoint(null);
    act(() => firePointerMove(999, 999));
    expect(result.current.order).toEqual([1, 2, 3]);
    act(() => firePointerUp());
  });

  it('accepte un pointeur tactile quel que soit le bouton', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const { event, setPointerCapture } = makeGripEvent('touch', 5);
    act(() => result.current.onGripPointerDown(event, 3));
    expect(result.current.draggingId).toBe(3);
    expect(setPointerCapture).toHaveBeenCalled();
    act(() => firePointerUp());
  });

  it('survit à un setPointerCapture qui lève', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() => usePointerReorder([1, 2, 3], onReorder));
    const handle = document.createElement('span');
    (handle as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {
      throw new Error('boom');
    };
    const event = {
      pointerType: 'mouse',
      button: 0,
      pointerId: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: handle,
    } as unknown as React.PointerEvent;
    expect(() => act(() => result.current.onGripPointerDown(event, 1))).not.toThrow();
    expect(result.current.draggingId).toBe(1);
    act(() => firePointerUp());
  });
});
