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
import { Spinner } from '../Spinner/Spinner';
import {
  QUESTION_TYPE_LABELS,
  type Language,
  type QuestionType,
  type QuestionTypeOption,
} from '../../types/domain';
import {
  FALLBACK_LANGUAGES,
  defaultStartCode,
  emptyQuestionDraft,
  type AnswerDraft,
  type DragItemDraft,
  type QuestionDraft,
  type TestCaseDraft,
} from './editorTypes';
import { defaultQuestionFormLabels, type QuestionFormLabels } from './questionFormLabels';

interface QuestionFormBodyProps {
  /** Brouillon initial (création = `emptyQuestionDraft`, édition = `questionToDraft`). */
  draft: QuestionDraft;
  isNew?: boolean;
  saving?: boolean;
  error?: string | null;
  /** Langages disponibles pour les questions Code. */
  languages?: Language[];
  /** Demande le chargement (paresseux) des langages — appelé quand le type est Code. */
  onRequestLanguages?: () => void;
  /** Types de question proposés (sélecteur). Repli local si non fourni. */
  questionTypes?: QuestionTypeOption[];
  /** Demande le chargement (paresseux) des types — appelé à l'ouverture de l'éditeur. */
  onRequestQuestionTypes?: () => void;
  /** Textes (surcharge partielle des défauts). */
  labels?: Partial<QuestionFormLabels>;
  /** Annule (bouton « Annuler ») : retour au formulaire de quiz — pas de fermeture. */
  onCancel: () => void;
  onSave: (draft: QuestionDraft) => void;
  /** Ouvre la page « Harnais de test » avec le brouillon courant (édits en cours). */
  onManageHarness: (draft: QuestionDraft) => void;
  /** Ouvre la page « Tester » (prévisualisation étudiant) avec le brouillon courant. */
  onTest: (draft: QuestionDraft) => void;
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

/** Repli des types de question, tant qu'ils ne sont pas chargés via l'API. */
const FALLBACK_QUESTION_TYPES: QuestionTypeOption[] = TYPE_ORDER.map((slug, i) => ({
  id: i + 1,
  slug,
  label: QUESTION_TYPE_LABELS[slug],
}));

/**
 * Validité du corps selon le type (en plus de l'énoncé + barème) :
 * - choix unique / multiple : au moins 2 choix, aucun vide (espaces compris) et au
 *   moins une bonne réponse cochée ;
 * - remise en ordre : au moins 2 éléments, tous remplis (non vides) ;
 * - association : au moins 2 éléments, chacun avec élément ET catégorie remplis ;
 * - code : au moins un harnais de test (les harnais eux-mêmes sont validés — nom +
 *   poids > 0 — dans leur propre éditeur) ;
 * - autres types (dont Vrai/Faux, à options figées) : non concernés → toujours valides.
 */
function isBodyValid(d: QuestionDraft): boolean {
  if (d.qType === 'single_choice' || d.qType === 'multiple_choice') {
    const answers = d.answers ?? [];
    return (
      answers.length > 1 &&
      answers.every((a) => a.content.trim() !== '') &&
      answers.some((a) => a.isCorrect)
    );
  }
  if (d.qType === 'ordering') {
    const items = d.dragItems ?? [];
    return items.length > 1 && items.every((item) => item.content.trim() !== '');
  }
  if (d.qType === 'matching') {
    const items = d.dragItems ?? [];
    return (
      items.length > 1 &&
      items.every((item) => item.content.trim() !== '' && (item.groupName ?? '').trim() !== '')
    );
  }
  if (d.qType === 'coding') {
    return (d.testCases ?? []).length >= 1;
  }
  return true;
}

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
  languages = FALLBACK_LANGUAGES,
  onRequestLanguages,
  questionTypes = FALLBACK_QUESTION_TYPES,
  onRequestQuestionTypes,
  labels,
  onCancel,
  onSave,
  onManageHarness,
  onTest,
}: QuestionFormBodyProps): React.ReactElement {
  const t = { ...defaultQuestionFormLabels, ...labels };
  const [draft, setDraft] = useState<QuestionDraft>(initialDraft);
  // Saisie du barème en TEXTE local : permet un champ vide / intermédiaire pendant la
  // frappe (sinon le forçage à ≥ 1 à chaque touche empêche de remplacer la valeur).
  // Borné à un entier ≥ 1 au `blur`. `draft.totalScore` suit (0 tant que vide → bloque
  // l'enregistrement via canSave).
  const [pointsText, setPointsText] = useState<string>(String(initialDraft.totalScore));
  /** Mobile (associations) : index de la ligne active dont la flèche devient poubelle. */
  const [activeMatch, setActiveMatch] = useState<number | null>(null);
  const matchingListRef = useRef<HTMLDivElement>(null);

  // Ouverture de l'éditeur de question (ajout/modif) : charge les types de question.
  useEffect(() => {
    onRequestQuestionTypes?.();
  }, [onRequestQuestionTypes]);

  // Question Code (à l'ouverture OU au passage au type Code) : charge les langages
  // (paresseux ; l'éditeur met en cache, donc appels répétés sans coût).
  useEffect(() => {
    if (draft.qType === 'coding') onRequestLanguages?.();
  }, [draft.qType, onRequestLanguages]);

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

  const canSave =
    draft.prompt.trim() !== '' && draft.totalScore > 0 && isBodyValid(draft);

  return (
    <>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t.promptLabel}</span>
        <MarkdownEditor
          embedded
          autoFocus={false}
          value={draft.prompt}
          placeholder={t.promptPlaceholder}
          onChange={(prompt) => patch({ prompt })}
        />
      </div>

      <div className={styles.row2}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t.typeLabel}</span>
          <Dropdown
            ariaLabel={t.typeLabel}
            value={draft.qType}
            options={questionTypes.map((t) => ({ value: t.slug, label: t.label }))}
            onChange={(v) => changeType(v as QuestionType)}
          />
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t.pointsLabel}</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            step={1}
            value={pointsText}
            onChange={(e) => {
              const raw = e.target.value;
              setPointsText(raw);
              patch({ totalScore: raw === '' ? 0 : Number(raw) });
            }}
            onBlur={() => {
              const n = Math.trunc(Number(pointsText));
              const clamped = n >= 1 ? n : 1;
              patch({ totalScore: clamped });
              setPointsText(String(clamped));
            }}
          />
        </label>
      </div>

      {renderBody()}

      {error && <span className={styles.errorText}>{error}</span>}

      <EditorFooter>
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.outlineButton}
            title={t.testTitle}
            disabled={!canSave}
            onClick={() => onTest(draft)}
          >
            {t.test}
          </button>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.ghostButton} onClick={onCancel}>
            {t.cancel}
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canSave || saving}
            onClick={() => onSave(draft)}
          >
            {saving ? <Spinner tone="current" size={16} /> : isNew ? t.add : t.save}
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
          <span className={styles.sectionTitle}>{t.answersSection}</span>
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
                aria-label={t.markCorrectAria}
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
                placeholder={fixed ? '' : t.answerPlaceholder}
                disabled={fixed}
                onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
              />
              {!fixed && (
                <button
                  type="button"
                  className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                  aria-label={t.deleteAnswerAria}
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
            + {t.addAnswer}
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
          <span className={styles.sectionTitle}>{t.orderingSection}</span>
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
                  placeholder={t.elementPlaceholder}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === id ? { ...x, content: e.target.value } : x)))
                  }
                />
                <button
                  type="button"
                  className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                  aria-label={t.deleteItemAria}
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
          + {t.addItem}
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
          <span className={styles.sectionTitle}>{t.matchingSection}</span>
        </div>
        <div className={[styles.list, styles.matchingList].join(' ')} ref={matchingListRef}>
          {items.map((d, i) => (
            <div
              key={i}
              className={[styles.answerRow, styles.matchingRow, styles.association].join(' ')}
              // Active la ligne (→ poubelle) au clic n'importe où sur la ligne, en plus
              // du focus d'un input. Les boutons de suppression stoppent la propagation
              // pour ne pas ré-activer la ligne après l'avoir supprimée.
              onClick={() => setActiveMatch(i)}
            >
              <input
                className={[styles.input, styles.answerInput].join(' ')}
                value={d.content}
                placeholder={t.elementPlaceholder}
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
                aria-label={activeMatch === i ? t.deleteAssociationAria : t.associationOptionsAria}
                onClick={(e) => {
                  e.stopPropagation(); // ne pas re-déclencher le onClick de la ligne
                  if (activeMatch === i) {
                    setItems(items.filter((_, j) => j !== i));
                    setActiveMatch(null);
                  } else {
                    setActiveMatch(i);
                  }
                }}
              >
                <ArrowRight className={styles.matchSlotArrow} width={16} height={16} />
                <TrashCan className={styles.matchSlotTrash} width={16} height={16} />
              </button>
              <input
                className={[styles.input, styles.groupSelect, d.groupName ? styles.groupSelectTeal : '']
                  .filter(Boolean)
                  .join(' ')}
                value={d.groupName ?? ''}
                placeholder={t.categoryPlaceholder}
                onFocus={() => setActiveMatch(i)}
                onChange={(e) =>
                  setItems(items.map((x, j) => (j === i ? { ...x, groupName: e.target.value, correctOrder: 0 } : x)))
                }
              />
              <button
                type="button"
                className={[styles.iconButton, styles.iconButtonDanger].join(' ')}
                aria-label={t.deleteAssociationAria}
                onClick={(e) => {
                  e.stopPropagation(); // évite de ré-activer la ligne après suppression
                  setItems(items.filter((_, j) => j !== i));
                }}
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
          + {t.addAssociation}
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
          <span className={styles.fieldLabel}>{t.languageLabel}</span>
          <Dropdown
            ariaLabel={t.languageLabel}
            value={String(draft.languageId ?? languages[0]?.id ?? '')}
            options={languages.map((l) => ({ value: String(l.id), label: l.name }))}
            onChange={(v) => changeLanguage(Number(v))}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t.startCodeLabel}</span>
          <CodeEditor
            value={draft.startCode ?? ''}
            onChange={(startCode) => patch({ startCode })}
            language={languageName}
            placeholder={t.startCodePlaceholder}
            ariaLabel={t.startCodeAria}
          />
        </div>

        <div className={styles.harnessSummary}>
          <div className={styles.harnessSummaryText}>
            <span className={styles.harnessSummaryTitle}>{t.harnessTitle}</span>
            <span className={styles.harnessSummarySub}>
              {t.harnessCount(tests.length)}
            </span>
          </div>
          <button type="button" className={styles.outlineButton} onClick={() => onManageHarness(draft)}>
            {t.manageHarness} <ArrowRight width={14} height={14} />
          </button>
        </div>
      </>
    );
  }
}

/** Réexport pratique pour les drafts (utilisé par le contrôleur). */
export type { TestCaseDraft };
