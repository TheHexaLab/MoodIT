import React from 'react';
import styles from './questions.module.css';
import { Check } from '../../../../assets/Check';
import { X } from '../../../../assets/X';
import { GripVertical } from '../../../../assets/GripVertical';
import { usePointerReorder } from '../../../QuizEditor/usePointerReorder';
import { type QuestionViewProps } from './types';
import { defaultQuestionLabels } from './questionLabels';

/**
 * Remise en ordre : l'étudiant glisse les éléments par la poignée pour les
 * réordonner. Glisser via **Pointer Events** (`usePointerReorder`) : fonctionne
 * souris ET tactile (le drag HTML5 ne marche pas au doigt). En révision, chaque
 * ligne montre si l'élément est à la bonne position (✓/✗) d'après `result.correctOrder`.
 */
export function OrderingQuestion({
  question,
  mode,
  answer,
  result,
  onChange,
  labels,
}: QuestionViewProps): React.ReactElement {
  const t = { ...defaultQuestionLabels, ...labels };
  const items = question.dragItems ?? [];
  const byId = new Map(items.map((d) => [d.id, d]));
  const baseOrder = answer?.kind === 'ordering' ? answer.itemIds : items.map((d) => d.id);

  const reorder = usePointerReorder(baseOrder, (ids) => onChange({ kind: 'ordering', itemIds: ids }));

  const review = mode === 'review';
  const correctOrder = result?.correctOrder ?? [];
  const displayed = review ? (result?.submittedOrder ?? baseOrder) : reorder.order;

  return (
    <div>
      {!review && <p className={styles.helper}>{t.orderingHelper}</p>}
      <ol className={styles.orderList} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {displayed.map((itemId, index) => {
          const item = byId.get(itemId);
          if (!item) return null;

          const correct = review && correctOrder[index] === itemId;
          const wrong = review && correctOrder[index] !== itemId;

          const rowClass = [
            styles.orderRow,
            !review ? styles.orderRowDraggable : '',
            !review && reorder.draggingId === itemId ? styles.orderRowDragging : '',
            wrong ? styles.optionWrong : '',
            correct ? styles.optionCorrect : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li key={itemId} className={rowClass} data-reorder-id={!review ? itemId : undefined}>
              {!review && (
                <span
                  className={styles.grip}
                  aria-hidden
                  onPointerDown={(e) => reorder.onGripPointerDown(e, itemId)}
                >
                  <GripVertical width={16} height={16} />
                </span>
              )}
              <span className={styles.orderNum}>{index + 1}</span>
              <span className={styles.orderText}>{item.content}</span>
              {review && (
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
