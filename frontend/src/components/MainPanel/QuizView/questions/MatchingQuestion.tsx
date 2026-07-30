import React, { useMemo, useState } from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { ArrowRight } from '../../../../assets/ArrowRight';
import { GripVertical } from '../../../../assets/GripVertical';
import { type QuestionViewProps } from './types';
import { defaultQuestionLabels } from './questionLabels';

/** Réserve (éléments non classés). */
const POOL = '__pool__';

/** Hash déterministe d'un id (Knuth) : ordonne le pool de façon pseudo-aléatoire mais STABLE. */
const shuffleKey = (id: number): number => Math.imul(id, 0x9e3779b1) >>> 0;

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

/**
 * Association : l'étudiant glisse chaque étiquette depuis la réserve vers la
 * catégorie qui convient (drag & drop natif). Les catégories disponibles sont les
 * `group_name` distincts de la question. En révision, une ligne par élément montre
 * la catégorie choisie et si elle est correcte (✓/✗).
 */
export function MatchingQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
  labels,
}: QuestionViewProps): React.ReactElement {
  const t = { ...defaultQuestionLabels, ...labels };
  // Enveloppé pour STABILISER l'identité (sinon `?? []` recrée un tableau à chaque rendu, ce qui
  // ferait recalculer les useMemo qui en dépendent à chaque fois).
  const items = useMemo(() => question.dragItems ?? [], [question.dragItems]);
  const byId = new Map(items.map((d) => [d.id, d]));
  const placement = answer?.kind === 'matching' ? answer.placement : {};

  // Ordre d'affichage du pool MÉLANGÉ (tri par hash des ids) : dé-corrèle l'ordre affiché de
  // l'ordre en base (regroupement des items), pour ne donner aucun indice sur les catégories.
  // Déterministe → stable entre les rendus ET les rechargements (les items ne sautent pas).
  const displayItems = useMemo(
    () => [...items].sort((a, b) => shuffleKey(a.id) - shuffleKey(b.id)),
    [items]
  );

  // Catégories (zones de dépôt) : fournies par le backend (`question.groups`, exposées même en
  // passation où le groupe correct de chaque item est masqué) ; à défaut, dérivées des items
  // (éditeur / révision, où `groupName` est présent).
  const groups =
    question.groups && question.groups.length > 0
      ? question.groups
      : [...new Set(items.map((d) => d.groupName).filter((g): g is string => !!g))].sort();

  // Glissement par Pointer Events (souris + tactile) : `drag` porte l'étiquette
  // saisie et la position du pointeur (pour le fantôme) ; `overZone` la zone survolée.
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null);
  const [overZone, setOverZone] = useState<string | null>(null);

  if (mode === 'review') {
    const rows = result?.matching ?? [];
    return (
      <div className={styles.orderList}>
        {rows.map((m) => {
          const item = byId.get(m.itemId);
          return (
            <div
              key={m.itemId}
              className={[styles.matchRow, m.correct ? styles.optionCorrect : styles.optionWrong].join(
                ' '
              )}
            >
              <span
                className={[styles.statusIcon, m.correct ? styles.statusOk : styles.statusBad].join(
                  ' '
                )}
              >
                {m.correct ? <Check width={14} height={14} /> : <X width={12} height={12} />}
              </span>
              <span className={styles.matchRowItem}>{item?.content}</span>
              <span className={styles.matchRowArrow} aria-hidden>
                <ArrowRight width={14} height={14} />
              </span>
              <span className={styles.matchRowGroup}>{m.chosenGroup ?? t.unplacedGroup}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function placeInto(itemId: number, zone: string) {
    const group = zone === POOL ? null : zone;
    onChange({ kind: 'matching', placement: { ...placement, [itemId]: group } });
  }

  const inZone = (zone: string) =>
    displayItems.filter((d) => (placement[d.id] ?? null) === (zone === POOL ? null : zone));

  /** Zone (`data-zone`) sous le point (x, y), ou null. */
  function zoneAt(x: number, y: number): string | null {
    return document.elementFromPoint(x, y)?.closest('[data-zone]')?.getAttribute('data-zone') ?? null;
  }

  function startDrag(e: React.PointerEvent, id: number) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    setDrag({ id, x: e.clientX, y: e.clientY });

    // Auto-scroll : quand le pointeur approche du bord haut/bas du conteneur défilant, on le
    // fait défiler (vitesse proportionnelle à la proximité). Une boucle rAF entretient le
    // défilement même si le pointeur reste immobile près du bord.
    const scroller = getScrollableParent(e.currentTarget as HTMLElement);
    const EDGE = 64; // zone sensible (px) depuis chaque bord
    const MAX_SPEED = 16; // vitesse max (px / frame)
    let px = e.clientX;
    let py = e.clientY;
    let raf = 0;
    const autoScroll = () => {
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
      let dy = 0;
      if (py < top + EDGE) dy = -MAX_SPEED * Math.min(1, (top + EDGE - py) / EDGE);
      else if (py > bottom - EDGE) dy = MAX_SPEED * Math.min(1, (py - (bottom - EDGE)) / EDGE);
      if (dy !== 0) {
        if (scroller) scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        // Le contenu défile sous le pointeur → la zone survolée peut changer.
        setOverZone(zoneAt(px, py));
      }
      raf = requestAnimationFrame(autoScroll);
    };
    raf = requestAnimationFrame(autoScroll);

    const onMove = (ev: PointerEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
      setOverZone(zoneAt(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const zone = zoneAt(ev.clientX, ev.clientY);
      // Ne réécrit que si la zone cible diffère de la zone actuelle (pas de no-op au tap).
      if (zone) {
        const target = zone === POOL ? null : zone;
        if (target !== (placement[id] ?? null)) placeInto(id, zone);
      }
      setDrag(null);
      setOverZone(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function Chip({ id, content }: { id: number; content: string }): React.ReactElement {
    return (
      <span
        className={[styles.chip, drag?.id === id ? styles.chipDragging : ''].filter(Boolean).join(' ')}
        onPointerDown={(e) => startDrag(e, id)}
      >
        <GripVertical width={12} height={12} aria-hidden />
        <span className={styles.chipText}>{content}</span>
      </span>
    );
  }

  return (
    <div>
      <p className={styles.helper}>{t.matchingHelper}</p>

      {/* Réserve des étiquettes non classées. */}
      <div
        className={[styles.pool, overZone === POOL ? styles.poolOver : ''].filter(Boolean).join(' ')}
        data-zone={POOL}
      >
        {inZone(POOL).map((d) => (
          <Chip key={d.id} id={d.id} content={d.content} />
        ))}
      </div>

      {/* Catégories cibles. */}
      <div className={styles.groupGrid}>
        {groups.map((group) => (
          <div
            key={group}
            className={[styles.group, overZone === group ? styles.groupOver : '']
              .filter(Boolean)
              .join(' ')}
            data-zone={group}
          >
            <span className={styles.groupLabel}>{group}</span>
            <div className={styles.groupItems}>
              {inZone(group).map((d) => (
                <Chip key={d.id} id={d.id} content={d.content} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Étiquette « fantôme » qui suit le pointeur pendant le glissement. */}
      {drag && (
        <span className={styles.dragGhost} style={{ left: drag.x, top: drag.y }}>
          <GripVertical width={12} height={12} aria-hidden />
          <span className={styles.chipText}>{byId.get(drag.id)?.content}</span>
        </span>
      )}
    </div>
  );
}
