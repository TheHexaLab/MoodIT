import React, { useEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { EditorFooter } from './EditorShell';
import { CodeEditor } from './CodeEditor';
import { Dropdown } from './Dropdown';
import { usePointerReorder } from './usePointerReorder';
import { MarkdownEditor } from '../MainPanel/ForumView/MarkdownEditor';
import { GripVertical } from '../../assets/GripVertical';
import { TrashCan } from '../../assets/TrashCan';
import { Check } from '../../assets/Check';
import { ArrowRight } from '../../assets/ArrowRight';
import {
  QUESTION_TYPE_LABELS,
  type Language,
  type QuestionType,
} from '../../types/domain';
import {
  DEFAULT_LANGUAGES,
  defaultStartCode,
  emptyQuestionDraft,
  type AnswerDraft,
  type DragItemDraft,
  type QuestionDraft,
  type TestCaseDraft,
} from './editorTypes';

interface QuestionFormBodyProps {
  /** Brouillon initial (création = `emptyQuestionDraft`, édition = `questionToDraft`). */
  draft: QuestionDraft;
  isNew?: boolean;
  saving?: boolean;
  error?: string | null;
  /** Langages disponibles pour les questions Code. */
  languages?: Language[];
  /** Annule (bouton « Annuler ») : retour au formulaire de quiz — pas de fermeture. */
  onCancel: () => void;
  onSave: (draft: QuestionDraft) => void;
  /** Ouvre la page « Harnais de test » avec le brouillon courant (édits en cours). */
  onManageHarness: (draft: QuestionDraft) => void;
}

/** Types proposés dans le sélecteur, dans l'ordre du modèle. */
const TYPE_ORDER: QuestionType[] = [
  'true_false',
  'single_choice',
  'multiple_choice',
  'ordering',
  'matching',
  'coding',
];

/**
 * Éditeur d'une question (tous types). L'énoncé est en Markdown (champ avec
 * barre d'outils + aperçu). Le corps change selon le type sélectionné : options
 * (choix), éléments (ordre), associations (groupes) ou code + harnais. « Tester »
 * est un point d'extension (prévisualisation) ; ici inactif sans backend.
 */
export function QuestionFormBody({
  draft: initialDraft,
  isNew,
  saving,
  error,
  languages = DEFAULT_LANGUAGES,
  onCancel,
  onSave,
  onManageHarness,
}: QuestionFormBodyProps): React.ReactElement {
  const [draft, setDraft] = useState<QuestionDraft>(initialDraft);
  /** Mobile (associations) : index de la ligne active dont la flèche devient poubelle. */
  const [activeMatch, setActiveMatch] = useState<number | null>(null);
  const matchingListRef = useRef<HTMLDivElement>(null);

  // Désactive la ligne active (→ la poubelle redevient flèche) dès qu'on clique en
  // dehors de la liste des associations.
  useEffect(() => {
    if (activeMatch === null) return;
    function onPointerDown(e: PointerEvent) {
      if (matchingListRef.current && !matchingListRef.current.contains(e.target as Node)) {
        setActiveMatch(null);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [activeMatch]);

  const patch = (p: Partial<QuestionDraft>) => setDraft((d) => ({ ...d, ...p }));

  // Réordonnancement (souris + tactile) des éléments à ordonner (« Remise en ordre »).
  // Les ids sont les INDICES courants — stables le temps du glissé (`dragItems` ne
  // change pas pendant le geste), l'ordre n'étant persisté qu'au relâchement.
  const orderReorder = usePointerReorder(
    (draft.dragItems ?? []).map((_, i) => i),
    (orderedIndices) => {
      const cur = draft.dragItems ?? [];
      patch({
        dragItems: orderedIndices
          .map((i) => cur[i])
          .filter((d): d is DragItemDraft => !!d)
          .map((d, idx) => ({ ...d, correctOrder: idx })),
      });
    }
  );

  /** Changement de type : on repart d'un brouillon vierge du type, en gardant énoncé + points. */
  function changeType(qType: QuestionType) {
    setDraft((d) => ({ ...emptyQuestionDraft(qType), id: d.id, prompt: d.prompt, totalScore: d.totalScore }));
  }

  /**
   * Changement de langage (question Code) : le code de départ et les harnais sont
   * liés au langage. On repose donc le squelette du nouveau langage et on vide les
   * harnais (ils ne sont plus valides dans l'autre langage).
   */
  function changeLanguage(languageId: number) {
    const language = languages.find((l) => l.id === languageId);
    patch({ languageId, startCode: defaultStartCode(language), testCases: [] });
  }

  const canSave = draft.prompt.trim() !== '' && draft.totalScore > 0;

  return (
    <>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>Énoncé</span>
        <MarkdownEditor
          embedded
          autoFocus={false}
          value={draft.prompt}
          placeholder="Écris l'énoncé de la question…"
          onChange={(prompt) => patch({ prompt })}
        />
      </div>

      <div className={styles.row2}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Type de question</span>
          <Dropdown
            ariaLabel="Type de question"
            value={draft.qType}
            options={TYPE_ORDER.map((t) => ({ value: t, label: QUESTION_TYPE_LABELS[t] }))}
            onChange={(v) => changeType(v as QuestionType)}
          />
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Points</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            value={draft.totalScore}
            onChange={(e) => patch({ totalScore: Math.max(1, Number(e.target.value) || 1) })}
          />
        </label>
      </div>

      {renderBody()}

      {error && <span className={styles.errorText}>{error}</span>}

      <EditorFooter>
        <div className={styles.footer}>
          <button type="button" className={styles.outlineButton} title="Prévisualiser / tester" disabled>
            Tester
          </button>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            Annuler
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canSave || saving}
            onClick={() => onSave(draft)}
          >
            {saving ? <span className={styles.spinner} /> : isNew ? 'Ajouter' : 'Enregistrer'}
          </button>
        </div>
      </EditorFooter>
    </>
  );

  // ───────────────────────────── Corps par type ─────────────────────────────

  function renderBody(): React.ReactElement {
    switch (draft.qType) {
      case 'true_false':
      case 'single_choice':
      case 'multiple_choice':
        return renderChoice();
      case 'ordering':
        return renderOrdering();
      case 'matching':
        return renderMatching();
      case 'coding':
        return renderCoding();
    }
  }

  function renderChoice(): React.ReactElement {
    const multiple = draft.qType === 'multiple_choice';
    const fixed = draft.qType === 'true_false'; // 2 options figées
    const answers = draft.answers ?? [];

    const setAnswers = (next: AnswerDraft[]) => patch({ answers: next });

    function pick(index: number) {
      if (multiple) {
        setAnswers(answers.map((a, i) => (i === index ? { ...a, isCorrect: !a.isCorrect } : a)));
      } else {
        setAnswers(answers.map((a, i) => ({ ...a, isCorrect: i === index })));
      }
    }

    return (
      <div className={styles.field}>
        <div className={styles.sectionBar}>
          <span className={styles.sectionTitle}>Réponses</span>
        </div>
        <div className={styles.list}>
          {answers.map((a, i) => (
            <div key={i} className={styles.answerRow}>
              <button
                type="button"
                className={[
                  styles.answerControl,
                  multiple ? styles.answerControlCheckbox : styles.answerControlRadio,
                  a.isCorrect ? styles.answerControlOn : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-label="Marquer comme correcte"
                onClick={() => pick(i)}
              >
                {a.isCorrect &&
                  (multiple ? <Check width={12} height={12} /> : <span className={styles.answerControlDot} />)}
              </button>
              <input
                className={[styles.input, styles.answerInput, a.isCorrect ? styles.answerInputSelected : '']
                  .filter(Boolean)
                  .join(' ')}
                value={a.content}
                placeholder={fixed ? '' : 'Réponse…'}
                disabled={fixed}
                onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
              />
              {!fixed && (
                <button
                  type="button"
                  className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                  aria-label="Supprimer la réponse"
                  onClick={() => setAnswers(answers.filter((_, j) => j !== i))}
                >
                  <TrashCan width={15} height={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {!fixed && (
          <button
            type="button"
            className={styles.addButton}
            onClick={() => setAnswers([...answers, { content: '', isCorrect: false }])}
          >
            + Ajouter une réponse
          </button>
        )}
      </div>
    );
  }

  function renderOrdering(): React.ReactElement {
    const items = draft.dragItems ?? [];
    const setItems = (next: DragItemDraft[]) =>
      patch({ dragItems: next.map((d, i) => ({ ...d, correctOrder: i })) });

    return (
      <div className={styles.field}>
        <div className={styles.sectionBar}>
          <span className={styles.sectionTitle}>Éléments à ordonner</span>
        </div>
        <div className={styles.list}>
          {orderReorder.order.map((id, position) => {
            const d = items[id];
            if (!d) return null;
            return (
              <div
                key={id}
                data-reorder-id={id}
                className={[
                  styles.answerRow,
                  orderReorder.draggingId === id ? styles.listRowDragging : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span
                  className={styles.grip}
                  aria-hidden
                  onPointerDown={(e) => orderReorder.onGripPointerDown(e, id)}
                >
                  <GripVertical width={16} height={16} />
                </span>
                <span className={styles.orderNum}>{position + 1}</span>
                <input
                  className={[styles.input, styles.answerInput].join(' ')}
                  value={d.content}
                  placeholder="Élément…"
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === id ? { ...x, content: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                  aria-label="Supprimer l'élément"
                  onClick={() => setItems(items.filter((_, j) => j !== id))}
                >
                  <TrashCan width={15} height={15} />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setItems([...items, { content: '', correctOrder: items.length }])}
        >
          + Ajouter un élément
        </button>
      </div>
    );
  }

  function renderMatching(): React.ReactElement {
    const items = draft.dragItems ?? [];
    const setItems = (next: DragItemDraft[]) => patch({ dragItems: next });

    return (
      <div className={styles.field}>
        <div className={styles.sectionBar}>
          <span className={styles.sectionTitle}>Associations</span>
        </div>
        <div className={[styles.list, styles.matchingList].join(' ')} ref={matchingListRef}>
          {items.map((d, i) => (
            <div key={i} className={[styles.answerRow, styles.matchingRow, styles.association].join(' ')}>
              <input
                className={[styles.input, styles.answerInput].join(' ')}
                value={d.content}
                placeholder="Élément…"
                onFocus={() => setActiveMatch(i)}
                onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
              />
              {/* Slot central : flèche par défaut ; devient une poubelle (suppression)
                  en mobile quand la ligne est active (champ focalisé ou flèche tapée).
                  Inerte en desktop (la poubelle de bout de ligne gère la suppression). */}
              <button
                type="button"
                className={styles.matchSlot}
                data-active={activeMatch === i}
                aria-label={activeMatch === i ? "Supprimer l'association" : "Options de l'association"}
                onClick={() => {
                  if (activeMatch === i) {
                    setItems(items.filter((_, j) => j !== i));
                    setActiveMatch(null);
                  } else {
                    setActiveMatch(i);
                  }
                }}
              >
                <ArrowRight className={styles.matchSlotArrow} width={14} height={14} />
                <TrashCan className={styles.matchSlotTrash} width={15} height={15} />
              </button>
              <input
                className={[styles.input, styles.groupSelect, d.groupName ? styles.groupSelectTeal : '']
                  .filter(Boolean)
                  .join(' ')}
                value={d.groupName ?? ''}
                placeholder="Catégorie"
                onFocus={() => setActiveMatch(i)}
                onChange={(e) =>
                  setItems(items.map((x, j) => (j === i ? { ...x, groupName: e.target.value, correctOrder: 0 } : x)))
                }
              />
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label="Supprimer l'association"
                onClick={() => setItems(items.filter((_, j) => j !== i))}
              >
                <TrashCan width={15} height={15} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={styles.addButton}
          onClick={() => setItems([...items, { content: '', correctOrder: 0, groupName: '' }])}
        >
          + Ajouter une association
        </button>
      </div>
    );
  }

  function renderCoding(): React.ReactElement {
    const tests = draft.testCases ?? [];
    const languageName = languages.find((l) => l.id === draft.languageId)?.name;

    return (
      <>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Langage</span>
          <Dropdown
            ariaLabel="Langage"
            value={String(draft.languageId ?? languages[0]?.id ?? '')}
            options={languages.map((l) => ({ value: String(l.id), label: l.name }))}
            onChange={(v) => changeLanguage(Number(v))}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>Code de départ</span>
          <CodeEditor
            value={draft.startCode ?? ''}
            onChange={(startCode) => patch({ startCode })}
            language={languageName}
            placeholder={'def fonction():\n    # à compléter\n    pass'}
            ariaLabel="Code de départ"
          />
        </div>

        <div className={styles.harnessSummary}>
          <div className={styles.harnessSummaryText}>
            <span className={styles.harnessSummaryTitle}>Harnais de test</span>
            <span className={styles.harnessSummarySub}>
              {tests.length} harnais
            </span>
          </div>
          <button type="button" className={styles.outlineButton} onClick={() => onManageHarness(draft)}>
            Gérer <ArrowRight width={14} height={14} />
          </button>
        </div>
      </>
    );
  }
}

/** Réexport pratique pour les drafts (utilisé par le contrôleur). */
export type { TestCaseDraft };
