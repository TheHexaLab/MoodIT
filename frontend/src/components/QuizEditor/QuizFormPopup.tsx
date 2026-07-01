import React, { useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { usePointerReorder } from './usePointerReorder';
import { GripVertical } from '../../assets/GripVertical';
import { Pencil } from '../../assets/Pencil';
import { Plus } from '../../assets/Plus';
import { TrashCan } from '../../assets/TrashCan';
import { Spinner } from '../Spinner/Spinner';
import { QUESTION_TYPE_LABELS, type Question, type Quiz } from '../../types/domain';
import { type QuizMetaDraft } from './editorTypes';
import { defaultQuizFormLabels, type QuizFormLabels } from './quizFormLabels';

interface QuizFormBodyProps {
  quiz: Quiz;
  /** Quiz en cours de création (libellé du bouton « Créer le quiz »). */
  isNew?: boolean;
  saving?: boolean;
  error?: string | null;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuizFormLabels>;
  /** Annule (bouton « Annuler ») : retour à la liste — pas de fermeture. */
  onCancel: () => void;
  onSaveMeta: (meta: QuizMetaDraft) => void;
  onAddQuestion: () => void;
  onEditQuestion: (question: Question) => void;
  onDeleteQuestion: (question: Question) => void;
  onReorderQuestions: (questionIds: number[]) => void;
}

/** Interrupteur on/off (Publié, Quiz du jour). */
function Toggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={styles.toggle}
      role="switch"
      aria-checked={on}
      onClick={onToggle}
    >
      <span className={[styles.toggleTrack, on ? styles.toggleOn : ''].filter(Boolean).join(' ')}>
        <span className={styles.toggleKnob} />
      </span>
      {label}
    </button>
  );
}

/**
 * Corps « Modifier le quiz » (ou « Nouveau quiz ») : méta (titre, Publié, Quiz du
 * jour) + liste réordonnable des questions avec badges, points et actions.
 * L'ajout / l'édition / la suppression de question sont délégués au parent.
 * Rendu dans la coquille commune (`EditorShell`) par `QuizEditor`.
 */
export function QuizFormBody({
  quiz,
  isNew,
  saving,
  error,
  labels,
  onCancel,
  onSaveMeta,
  onAddQuestion,
  onEditQuestion,
  onDeleteQuestion,
  onReorderQuestions,
}: QuizFormBodyProps): React.ReactElement {
  const t = { ...defaultQuizFormLabels, ...labels };
  const [title, setTitle] = useState(quiz.title);
  const [isPublished, setIsPublished] = useState(!!quiz.isPublished);
  const [isDaily, setIsDaily] = useState(!!quiz.isDaily);
  const [allowRetry, setAllowRetry] = useState(!!quiz.allowRetry);

  const questions = quiz.questions ?? [];
  // Réordonnancement souris + tactile (poignée), cf. usePointerReorder.
  const { order, draggingId, onGripPointerDown } = usePointerReorder(
    questions.map((q) => q.id),
    onReorderQuestions
  );
  /** Mobile : ligne dont les actions (éditer/supprimer) sont révélées au tap. */
  const [revealedId, setRevealedId] = useState<number | null>(null);

  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered = order.map((id) => byId.get(id)).filter((q): q is Question => !!q);

  const totalPoints = questions.reduce((s, q) => s + q.totalScore, 0);
  const canSave = title.trim() !== '';

  return (
    <>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t.titleLabel}</span>
        <input
          className={styles.input}
          value={title}
          maxLength={128}
          placeholder={t.titlePlaceholder}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>

      <div className={styles.toggles}>
        <Toggle label={t.published} on={isPublished} onToggle={() => setIsPublished((v) => !v)} />
        <Toggle label={t.daily} on={isDaily} onToggle={() => setIsDaily((v) => !v)} />
        <Toggle label={t.allowRetry} on={allowRetry} onToggle={() => setAllowRetry((v) => !v)} />
      </div>

      <hr className={styles.divider} />

      <div className={styles.sectionBar}>
        <span className={styles.sectionTitle}>
          {t.questionsSection} <span className={styles.sectionMeta}>{t.points(totalPoints)}</span>
        </span>
        <button type="button" className={styles.addLinkButton} onClick={onAddQuestion}>
          <Plus width={14} height={14} /> {t.addQuestion}
        </button>
      </div>

      <div className={[styles.list, styles.questionList].join(' ')}>
        {ordered.map((question) => (
          <div
            key={question.id}
            data-reorder-id={question.id}
            className={[
              styles.listRow,
              draggingId === question.id ? styles.listRowDragging : '',
            ]
              .filter(Boolean)
              .join(' ')}
            // Mobile : tap sur la ligne pour révéler/masquer ses actions.
            onClick={() => setRevealedId((id) => (id === question.id ? null : question.id))}
          >
            <span
              className={styles.grip}
              aria-hidden
              onPointerDown={(e) => onGripPointerDown(e, question.id)}
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical width={16} height={16} />
            </span>
            <div className={styles.rowBody}>
              <div className={styles.rowTitleLine}>
                <span className={[styles.badge, styles.badgeType].join(' ')}>
                  {QUESTION_TYPE_LABELS[question.qType]}
                </span>
                <span className={[styles.badge, styles.badgePoints].join(' ')}>
                  {t.points(question.totalScore)}
                </span>
              </div>
              <span className={styles.rowSub}>{firstLine(question.prompt, t.noPrompt)}</span>
            </div>
            <div
              className={[
                styles.rowActions,
                revealedId === question.id ? styles.rowActionsRevealed : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <button
                type="button"
                className={styles.iconButton}
                aria-label={t.editQuestionAria}
                onClick={(e) => {
                  e.stopPropagation();
                  onEditQuestion(question);
                }}
              >
                <Pencil width={15} height={15} />
              </button>
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label={t.deleteQuestionAria}
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteQuestion(question);
                }}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && <span className={styles.errorText}>{error}</span>}

      <EditorFooter>
        <div className={styles.footer}>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            {t.cancel}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canSave || saving}
            onClick={() => onSaveMeta({ title: title.trim(), isPublished, isDaily, allowRetry })}
          >
            {saving ? <Spinner tone="current" size={16} /> : isNew ? t.create : t.save}
          </button>
        </div>
      </EditorFooter>
    </>
  );
}

/** Première ligne « parlante » du prompt Markdown (`fallback` si vide). */
function firstLine(prompt: string, fallback: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.replace(/^#+\s*/, '').replace(/[*`_]/g, '') : fallback;
}
