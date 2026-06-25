import React, { useState } from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { GripVertical } from '../../../../assets/GripVertical';
import { type QuestionViewProps } from './types';

/**
 * Remise en ordre : l'étudiant glisse les éléments (drag & drop natif HTML5) pour
 * les réordonner. En révision, chaque ligne montre si l'élément est à la bonne
 * position (✓/✗) d'après `result.correctOrder`.
 */
export function OrderingQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
}: QuestionViewProps): React.ReactElement {
  const items = question.dragItems ?? [];
  const byId = new Map(items.map((d) => [d.id, d]));
  const order = answer?.kind === 'ordering' ? answer.itemIds : items.map((d) => d.id);

  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  const reviewOrder = result?.submittedOrder ?? order;
  const correctOrder = result?.correctOrder ?? [];
  const displayed = mode === 'review' ? reviewOrder : order;

  function move(fromId: number, toId: number) {
    if (fromId === toId) return;
    const next = [...order];
    const from = next.indexOf(fromId);
    const to = next.indexOf(toId);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    onChange({ kind: 'ordering', itemIds: next });
  }

  return (
    <div>
      {mode === 'answer' && <p className={styles.helper}>Glisse les éléments pour les réordonner.</p>}
      <ol className={styles.orderList} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {displayed.map((itemId, index) => {
          const item = byId.get(itemId);
          if (!item) return null;

          const correct = mode === 'review' && correctOrder[index] === itemId;
          const wrong = mode === 'review' && correctOrder[index] !== itemId;

          const rowClass = [
            styles.orderRow,
            mode === 'answer' ? styles.orderRowDraggable : '',
            dragId === itemId ? styles.orderRowDragging : '',
            overId === itemId && dragId !== itemId ? styles.orderRowOver : '',
            wrong ? styles.optionWrong : '',
            correct ? styles.optionCorrect : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li
              key={itemId}
              className={rowClass}
              draggable={mode === 'answer'}
              onDragStart={() => setDragId(itemId)}
              onDragOver={(e) => {
                if (mode !== 'answer') return;
                e.preventDefault();
                setOverId(itemId);
              }}
              onDrop={(e) => {
                if (mode !== 'answer' || dragId == null) return;
                e.preventDefault();
                move(dragId, itemId);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              {mode === 'answer' && (
                <span className={styles.grip} aria-hidden>
                  <GripVertical width={16} height={16} />
                </span>
              )}
              <span className={styles.orderNum}>{index + 1}</span>
              <span className={styles.orderText}>{item.content}</span>
              {mode === 'review' && (
                <span
                  className={[styles.statusIcon, correct ? styles.statusOk : styles.statusBad].join(
                    ' '
                  )}
                >
                  {correct ? <Check width={14} height={14} /> : <X width={12} height={12} />}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
