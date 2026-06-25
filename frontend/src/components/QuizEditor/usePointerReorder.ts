import React, { useEffect, useRef, useState } from 'react';

export interface PointerReorder {
  /** Ordre courant des ids (à utiliser pour rendre la liste). */
  order: number[];
  /** Id de la ligne en cours de glissement (pour le style), sinon null. */
  draggingId: number | null;
  /** À poser sur la poignée (⋮⋮) de chaque ligne. */
  onGripPointerDown: (e: React.PointerEvent, id: number) => void;
}

/**
 * Réordonnancement par glisser sur la poignée, via **Pointer Events** : fonctionne
 * souris ET tactile (contrairement au drag-and-drop HTML5, inopérant au doigt). La
 * poignée capture le pointeur ; à chaque déplacement, la ligne survolée (repérée par
 * son attribut `data-reorder-id`) est détectée et l'élément glissé y est déplacé en
 * direct. `onReorder` n'est appelé qu'au relâchement (un seul commit).
 *
 * L'ordre affiché est DÉRIVÉ : `dragOrder` (état local) pendant un glissement, sinon
 * directement `ids` (la source). Au relâchement, le parent persiste l'ordre → `ids`
 * reflète le nouvel ordre et `dragOrder` repasse à null sans à-coup.
 *
 * Côté rendu : chaque ligne doit porter `data-reorder-id={id}` et sa poignée
 * `onPointerDown={(e) => onGripPointerDown(e, id)}` + `touch-action: none`.
 */
export function usePointerReorder(
  ids: number[],
  onReorder: (ids: number[]) => void
): PointerReorder {
  // Ordre transitoire pendant un glissement (null = pas de glissement → on suit `ids`).
  const [dragOrder, setDragOrder] = useState<number[] | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);

  const order = dragOrder ?? ids;

  // Refs « miroir » lues au relâchement du pointeur (mises à jour en effet, pas au rendu).
  const orderRef = useRef(order);
  const onReorderRef = useRef(onReorder);
  useEffect(() => {
    orderRef.current = order;
  });
  useEffect(() => {
    onReorderRef.current = onReorder;
  });

  function onGripPointerDown(e: React.PointerEvent, id: number) {
    // Souris : bouton gauche uniquement. Tactile/stylet : toujours.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDraggingId(id);
    const startIds = ids;
    setDragOrder(startIds);

    const handle = e.currentTarget as HTMLElement;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture peut échouer si le pointeur est déjà relâché : sans gravité. */
    }

    const onMove = (ev: PointerEvent) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const row = el?.closest('[data-reorder-id]');
      if (!row) return;
      const overId = Number(row.getAttribute('data-reorder-id'));
      if (Number.isNaN(overId) || overId === id) return;
      setDragOrder((cur) => {
        const base = cur ?? startIds;
        const from = base.indexOf(id);
        const to = base.indexOf(overId);
        if (from < 0 || to < 0 || from === to) return base;
        const next = [...base];
        next.splice(from, 1);
        next.splice(to, 0, id);
        return next;
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const finalOrder = orderRef.current;
      setDraggingId(null);
      setDragOrder(null);
      // Ne persiste que si l'ordre a réellement changé (évite un commit sur simple clic).
      const changed =
        finalOrder.length !== startIds.length || finalOrder.some((v, i) => v !== startIds[i]);
      if (changed) onReorderRef.current(finalOrder);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  return { order, draggingId, onGripPointerDown };
}
