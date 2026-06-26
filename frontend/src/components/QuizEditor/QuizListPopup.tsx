import React, { useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { usePointerReorder } from './usePointerReorder';
import { GripVertical } from '../../assets/GripVertical';
import { Pencil } from '../../assets/Pencil';
import { TrashCan } from '../../assets/TrashCan';
import { Plus } from '../../assets/Plus';
import { type Quiz } from '../../types/domain';

interface QuizListBodyProps {
  /** Quiz du cours (ordre d'affichage = `position`). */
  quizzes: Quiz[];
  onCreate: () => void;
  onEdit: (quiz: Quiz) => void;
  onDelete: (quiz: Quiz) => void;
  /** Réordonnancement (ids dans le nouvel ordre) — persisté par le parent. */
  onReorder: (quizIds: number[]) => void;
}

/** Icône étoile (quiz du jour). Pleine si actif. */
function Star({ on }: { on: boolean }): React.ReactElement {
  return (
    <span className={[styles.star, on ? styles.starOn : ''].filter(Boolean).join(' ')}>
      <svg width={16} height={16} viewBox="0 0 16 16" fill={on ? 'currentColor' : 'none'}>
        <path
          d="M8 1.5l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.4 4.3 13l.8-4.2L2 5.9l4.2-.5L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * Corps « Modifier les quiz » : liste réordonnable des quiz d'un cours, avec
 * marqueur « quiz du jour » (★), statut (Publié/Brouillon), nombre de questions,
 * et actions éditer / supprimer / créer. Le glisser-déposer réordonne (HTML5).
 * Rendu dans la coquille commune (`EditorShell`) par `QuizEditor`.
 */
export function QuizListBody({
  quizzes,
  onCreate,
  onEdit,
  onDelete,
  onReorder,
}: QuizListBodyProps): React.ReactElement {
  // Réordonnancement souris + tactile (poignée), cf. usePointerReorder.
  const { order, draggingId, onGripPointerDown } = usePointerReorder(
    quizzes.map((q) => q.id),
    onReorder
  );
  /** Mobile : ligne dont les actions sont révélées au tap. */
  const [revealedId, setRevealedId] = useState<number | null>(null);

  const byId = new Map(quizzes.map((q) => [q.id, q]));
  const ordered = order.map((id) => byId.get(id)).filter((q): q is Quiz => !!q);

  return (
    <>
      <div className={styles.list}>
        {ordered.map((quiz) => (
          <div
            key={quiz.id}
            data-reorder-id={quiz.id}
            className={[
              styles.listRow,
              quiz.isDaily ? styles.listRowActive : '',
              draggingId === quiz.id ? styles.listRowDragging : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => setRevealedId((id) => (id === quiz.id ? null : quiz.id))}
          >
            <span
              className={styles.grip}
              aria-hidden
              onPointerDown={(e) => onGripPointerDown(e, quiz.id)}
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical width={16} height={16} />
            </span>
            <Star on={!!quiz.isDaily} />
            <div className={styles.rowBody}>
              <div className={styles.rowTitleLine}>
                <span className={styles.rowTitle}>{quiz.title}</span>
                <span
                  className={[
                    styles.badge,
                    quiz.isPublished ? styles.badgePublished : styles.badgeDraft,
                  ].join(' ')}
                >
                  {quiz.isPublished ? 'Publié' : 'Brouillon'}
                </span>
              </div>
              <span className={styles.rowSub}>
                {quiz.questions?.length ?? quiz.questionCount ?? 0} questions
              </span>
            </div>
            <div
              className={[
                styles.rowActions,
                revealedId === quiz.id ? styles.rowActionsRevealed : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Modifier ${quiz.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(quiz);
                }}
              >
                <Pencil width={15} height={15} />
              </button>
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label={`Supprimer ${quiz.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(quiz);
                }}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <EditorFooter>
        <button type="button" className={styles.addButton} onClick={onCreate}>
          <Plus width={14} height={14} /> Créer un quiz
        </button>
      </EditorFooter>
    </>
  );
}
