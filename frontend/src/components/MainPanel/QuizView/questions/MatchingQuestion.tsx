import React, { useState } from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { ArrowRight } from '../../../../assets/ArrowRight';
import { GripVertical } from '../../../../assets/GripVertical';
import { type QuestionViewProps } from './types';

/** Réserve (éléments non classés). */
const POOL = '__pool__';

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
}: QuestionViewProps): React.ReactElement {
  const items = question.dragItems ?? [];
  const byId = new Map(items.map((d) => [d.id, d]));
  const placement = answer?.kind === 'matching' ? answer.placement : {};

  // Catégories distinctes, dans l'ordre d'apparition.
  const groups = [...new Set(items.map((d) => d.groupName).filter((g): g is string => !!g))];

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
              <span className={styles.matchRowGroup}>{m.chosenGroup ?? '—'}</span>
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
    items.filter((d) => (placement[d.id] ?? null) === (zone === POOL ? null : zone));

  /** Zone (`data-zone`) sous le point (x, y), ou null. */
  function zoneAt(x: number, y: number): string | null {
    return document.elementFromPoint(x, y)?.closest('[data-zone]')?.getAttribute('data-zone') ?? null;
  }

  function startDrag(e: React.PointerEvent, id: number) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    setDrag({ id, x: e.clientX, y: e.clientY });
    const onMove = (ev: PointerEvent) => {
      setDrag((d) => (d ? { ...d, x: ev.clientX, y: ev.clientY } : d));
      setOverZone(zoneAt(ev.clientX, ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
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
      <p className={styles.helper}>Glisse chaque étiquette dans la catégorie qui convient.</p>

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
