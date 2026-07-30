import React, { useEffect, useRef, useState } from 'react';

export interface PointerReorder<Id extends string | number = number> {
  /** Ordre courant des ids (à utiliser pour rendre la liste). */
  order: Id[];
  /** Id de la ligne en cours de glissement (pour le style), sinon null. */
  draggingId: Id | null;
  /** À poser sur la poignée (⋮⋮) de chaque ligne : démarre TOUJOURS un glissement. */
  onGripPointerDown: (e: React.PointerEvent, id: Id) => void;
  /**
   * À poser sur la RANGÉE entière : la ligne se saisit n'importe où (comme les canaux),
   * SAUF si l'appui vient d'un élément interactif (bouton/lien/champ ou `[data-no-drag]`)
   * — leurs clics passent alors intacts. Souris/stylet uniquement : au tactile on n'arme
   * rien pour laisser le doigt défiler la liste (le glissement tactile passe par la poignée).
   */
  onRowPointerDown: (e: React.PointerEvent, id: Id) => void;
}

// Descendants dont l'appui ne doit JAMAIS armer le glissement de la rangée : leur clic
// (édition, suppression, saisie) doit rester fiable — cf. le même principe que les canaux.
const INTERACTIVE = 'button, a, input, textarea, select, [contenteditable="true"], [data-no-drag]';

/** Ancêtre défilant verticalement le plus proche (ou null → on défilera la fenêtre). */
function getScrollableParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

// Auto-scroll pendant le glissement : zone sensible (px) depuis chaque bord + vitesse max (px/frame).
const AUTOSCROLL_EDGE = 64;
const AUTOSCROLL_MAX_SPEED = 16;

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
export function usePointerReorder<Id extends string | number = number>(
  ids: Id[],
  onReorder: (ids: Id[]) => void
): PointerReorder<Id> {
  // Ordre transitoire pendant un glissement (null = pas de glissement → on suit `ids`).
  const [dragOrder, setDragOrder] = useState<Id[] | null>(null);
  const [draggingId, setDraggingId] = useState<Id | null>(null);

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
  function beginDrag(e: React.PointerEvent, id: Id, captureEl: HTMLElement) {
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

    // Détecte la ligne survolée (par (cx, cy)) et déplace l'élément saisi dessus. Factorisé pour
    // être appelé au pointermove ET par la boucle d'auto-scroll (le contenu défile sous le curseur).
    const detectOver = (cx: number, cy: number) => {
      const el = document.elementFromPoint(cx, cy);
      const row = el?.closest('[data-reorder-id]');
      if (!row) return;
      // L'attribut DOM est toujours une chaîne : on compare par String(...) pour gérer
      // indifféremment des ids numériques (quiz) ou chaînes (canaux : UUID).
      const overAttr = row.getAttribute('data-reorder-id');
      if (overAttr === null || overAttr === String(id)) return;
      setDragOrder((cur) => {
        const base = cur ?? startIds;
        const from = base.indexOf(id);
        const to = base.findIndex((x) => String(x) === overAttr);
        if (from < 0 || to < 0 || from === to) return base;
        moved = true;
        const next = [...base];
        next.splice(from, 1);
        next.splice(to, 0, id);
        return next;
      });
    };

    // Auto-scroll : quand le pointeur approche du bord haut/bas du conteneur défilant, on le fait
    // défiler (vitesse proportionnelle à la proximité). Une boucle rAF entretient le défilement
    // même si le pointeur reste immobile près du bord, et poursuit le réordonnancement au passage.
    const scroller = getScrollableParent(captureEl);
    let px = e.clientX;
    let py = e.clientY;
    let raf = 0;
    const autoScroll = () => {
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      let dy = 0;
      if (py < top + AUTOSCROLL_EDGE) {
        dy = -AUTOSCROLL_MAX_SPEED * Math.min(1, (top + AUTOSCROLL_EDGE - py) / AUTOSCROLL_EDGE);
      } else if (py > bottom - AUTOSCROLL_EDGE) {
        dy = AUTOSCROLL_MAX_SPEED * Math.min(1, (py - (bottom - AUTOSCROLL_EDGE)) / AUTOSCROLL_EDGE);
      }
      if (dy !== 0) {
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        detectOver(px, py);
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const onMove = (ev: PointerEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      detectOver(ev.clientX, ev.clientY);
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
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

  function onGripPointerDown(e: React.PointerEvent, id: Id) {
    // La poignée isole son geste de la rangée : son appui n'atteint pas onRowPointerDown
    // (pas de double armement) et son clic ne bascule pas les actions.
    e.stopPropagation();
    beginDrag(e, id, e.currentTarget as HTMLElement);
  }

  function onRowPointerDown(e: React.PointerEvent, id: Id) {
    // Tactile : on laisse le doigt défiler la liste ; le glissement tactile passe par la
    // poignée (touch-action:none). Souris/stylet : toute la rangée est saisissable.
    if (e.pointerType === 'touch') return;
    // Appui sur un contrôle interactif → on n'arme rien : le clic doit passer intact.
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    beginDrag(e, id, e.currentTarget as HTMLElement);
  }

  return { order, draggingId, onGripPointerDown, onRowPointerDown };
}
