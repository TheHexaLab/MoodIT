import React, { useLayoutEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { usePointerReorder } from './usePointerReorder';
import { GripVertical } from '../../assets/GripVertical';
import { Pencil } from '../../assets/Pencil';
import { TrashCan } from '../../assets/TrashCan';
import { Plus } from '../../assets/Plus';
import { Spinner } from '../Spinner/Spinner';
import { type Quiz } from '../../types/domain';
import { defaultQuizListLabels, type QuizListLabels } from './quizListLabels';

interface QuizListBodyProps {
  /** Quiz du cours (ordre d'affichage = `position`). */
  quizzes: Quiz[];
  /** Chargement initial de la liste en cours (1er fetch non encore résolu). */
  loading?: boolean;
  /** Quiz dont le détail charge (clic sur le crayon) : spinner sur ce crayon. */
  openingQuizId?: number | null;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuizListLabels>;
  onCreate: () => void;
  onEdit: (quiz: Quiz) => void;
  onDelete: (quiz: Quiz) => void;
  /** Réordonnancement (ids dans le nouvel ordre) — persisté par le parent. */
  onReorder: (quizIds: number[]) => void;
}

/** Icône éclair (quiz du jour) — même tracé que l'icône de type quiz. Pleine si actif. */
function Bolt({ on }: { on: boolean }): React.ReactElement {
  return (
    <span className={[styles.bolt, on ? styles.boltOn : ''].filter(Boolean).join(' ')}>
      <svg width={16} height={16} viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'}>
        <path
          d="M13 2 3 14h9l-1 8 10-12h-9z"
          stroke="currentColor"
          strokeWidth="1.8"
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
  loading = false,
  openingQuizId = null,
  labels,
  onCreate,
  onEdit,
  onDelete,
  onReorder,
}: QuizListBodyProps): React.ReactElement {
  const t = { ...defaultQuizListLabels, ...labels };
  // Réordonnancement souris + tactile (poignée), cf. usePointerReorder.
  const { order, draggingId, onGripPointerDown } = usePointerReorder(
    quizzes.map((q) => q.id),
    onReorder
  );
  /** Mobile : ligne dont les actions sont révélées au tap. */
  const [revealedId, setRevealedId] = useState<number | null>(null);

  const byId = new Map(quizzes.map((q) => [q.id, q]));
  const ordered = order.map((id) => byId.get(id)).filter((q): q is Quiz => !!q);

  // Plafonne la liste à EXACTEMENT 5 lignes (« flush ») : on mesure la hauteur réelle des 5
  // premières lignes (gaps compris) plutôt que de deviner un rem. Au-delà de 5 → scroll interne.
  const listRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const rows = list.querySelectorAll<HTMLElement>('[data-reorder-id]');
      if (rows.length > 5) {
        setMaxHeight(rows[4].offsetTop + rows[4].offsetHeight - rows[0].offsetTop);
      } else {
        setMaxHeight(undefined);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) measure();
    });
    return () => {
      cancelled = true;
      window.removeEventListener('resize', measure);
    };
  }, [ordered.length]);

  return (
    <>
      <div
        ref={listRef}
        className={[styles.list, styles.quizList, maxHeight != null ? styles.quizListScroll : '']
          .filter(Boolean)
          .join(' ')}
        style={maxHeight != null ? { maxHeight } : undefined}
      >
        {loading && ordered.length === 0 && (
          <div className={styles.listLoading} role="status" aria-live="polite" aria-busy="true">
            <Spinner size={26} />
            <span>{t.loading}</span>
          </div>
        )}
        {!loading && ordered.length === 0 && (
          <p className={styles.listEmpty}>{t.empty}</p>
        )}
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
            <Bolt on={!!quiz.isDaily} />
            <div className={styles.rowBody}>
              <div className={styles.rowTitleLine}>
                <span className={styles.rowTitle}>{quiz.title}</span>
                <span
                  className={[
                    styles.badge,
                    quiz.isPublished ? styles.badgePublished : styles.badgeDraft,
                  ].join(' ')}
                >
                  {quiz.isPublished ? t.published : t.draft}
                </span>
              </div>
              <span className={styles.rowSub}>
                {t.questionsCount(quiz.questions?.length ?? quiz.questionCount ?? 0)}
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
                aria-label={t.editAria(quiz.title)}
                aria-busy={openingQuizId === quiz.id}
                disabled={openingQuizId === quiz.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(quiz);
                }}
              >
                {openingQuizId === quiz.id ? (
                  <Spinner size={15} />
                ) : (
                  <Pencil width={15} height={15} />
                )}
              </button>
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label={t.deleteAria(quiz.title)}
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
          <Plus width={14} height={14} /> {t.create}
        </button>
      </EditorFooter>
    </>
  );
}
