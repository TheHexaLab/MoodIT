import React, { useEffect, useRef, useState } from 'react';

export interface PointerReorder {
  /** Ordre courant des ids (à utiliser pour rendre la liste). */
  order: number[];
  /** Id de la ligne en cours de glissement (pour le style), sinon null. */
  draggingId: number | null;
  /** À poser sur la poignée (⋮⋮) de chaque ligne : démarre TOUJOURS un glissement. */
  onGripPointerDown: (e: React.PointerEvent, id: number) => void;
  /**
   * À poser sur la RANGÉE entière : la ligne se saisit n'importe où (comme les canaux),
   * SAUF si l'appui vient d'un élément interactif (bouton/lien/champ ou `[data-no-drag]`)
   * — leurs clics passent alors intacts. Souris/stylet uniquement : au tactile on n'arme
   * rien pour laisser le doigt défiler la liste (le glissement tactile passe par la poignée).
   */
  onRowPointerDown: (e: React.PointerEvent, id: number) => void;
}

// Descendants dont l'appui ne doit JAMAIS armer le glissement de la rangée : leur clic
// (édition, suppression, saisie) doit rester fiable — cf. le même principe que les canaux.
const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]';

/**
 * Réordonnancement par glisser via **Pointer Events** : fonctionne souris ET tactile
 * (contrairement au drag-and-drop HTML5, inopérant au doigt). Deux façons de saisir une
 * ligne : la poignée (`onGripPointerDown`, tactile inclus) ou toute la rangée
 * (`onRowPointerDown`, souris/stylet). L'élément saisi capture le pointeur ; à chaque
 * déplacement, la ligne survolée (repérée par `data-reorder-id`) est détectée et l'élément
 * y est déplacé en direct. `onReorder` n'est appelé qu'au relâchement (un seul commit).
 *
 * L'ordre affiché est DÉRIVÉ : `dragOrder` (état local) pendant un glissement, sinon
 * directement `ids` (la source). Au relâchement, le parent persiste l'ordre → `ids`
 * reflète le nouvel ordre et `dragOrder` repasse à null sans à-coup.
 *
 * Côté rendu : chaque ligne doit porter `data-reorder-id={id}`. La poignée reçoit
 * `onPointerDown={(e) => onGripPointerDown(e, id)}` + `touch-action: none` ; la rangée
 * peut recevoir `onPointerDown={(e) => onRowPointerDown(e, id)}` pour être saisie entière.
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

  // Cœur commun : arme le glissement de `id` et capture le pointeur sur `captureEl`.
  // Appelé par la poignée comme par la rangée entière ; renvoie sans effet si l'appui
  // n'est pas un clic gauche (souris).
  function beginDrag(e: React.PointerEvent, id: number, captureEl: HTMLElement) {
    // Souris : bouton gauche uniquement. Tactile/stylet : toujours.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    setDraggingId(id);
    const startIds = ids;
    setDragOrder(startIds);
    // Vrai déplacement observé ? Sert à ne PAS traiter un simple clic comme un glissement
    // (et à neutraliser le click parasite de fin de geste).
    let moved = false;

    try {
      captureEl.setPointerCapture(e.pointerId);
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
        moved = true;
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
      // Un vrai glissement s'est produit : avale le click synthétique de fin de geste, sinon
      // il déclencherait le onClick de la rangée (ex. révéler/masquer les actions). Le garde
      // se retire au premier click ; filet de sécurité si le navigateur n'en émet aucun.
      if (moved) {
        const swallow = (ce: Event) => {
          ce.stopPropagation();
          window.removeEventListener('click', swallow, true);
        };
        window.addEventListener('click', swallow, true);
        window.setTimeout(() => window.removeEventListener('click', swallow, true), 300);
      }
      // Ne persiste que si l'ordre a réellement changé (évite un commit sur simple clic).
      const changed =
        finalOrder.length !== startIds.length || finalOrder.some((v, i) => v !== startIds[i]);
      if (changed) onReorderRef.current(finalOrder);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function onGripPointerDown(e: React.PointerEvent, id: number) {
    // La poignée isole son geste de la rangée : son appui n'atteint pas onRowPointerDown
    // (pas de double armement) et son clic ne bascule pas les actions.
    e.stopPropagation();
    beginDrag(e, id, e.currentTarget as HTMLElement);
  }

  function onRowPointerDown(e: React.PointerEvent, id: number) {
    // Tactile : on laisse le doigt défiler la liste ; le glissement tactile passe par la
    // poignée (touch-action:none). Souris/stylet : toute la rangée est saisissable.
    if (e.pointerType === 'touch') return;
    // Appui sur un contrôle interactif → on n'arme rien : le clic doit passer intact.
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    beginDrag(e, id, e.currentTarget as HTMLElement);
  }

  return { order, draggingId, onGripPointerDown, onRowPointerDown };
}
