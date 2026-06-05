import React, { useRef, useState } from 'react';
import styles from './SectionEditor.module.css';
import { Pencil } from '../../assets/Pencil.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { DeleteConfirmationBox } from '../DeleteConfirmationBox/DeleteConfirmationBox.tsx';

export interface Item {
  id: string;
  name: string;
}

interface SectionEditorProps {
  /** Préfixe affiché devant chaque nom (ex. « # »). */
  prefix?: string;
  onClose: (...args: unknown[]) => unknown;
  itemList: Item[];
  onChange: (change: ItemChange) => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<SectionEditorLabels>;
}

/**
 * Décrit une modification appliquée à la liste.
 * Émise via `onChange` ; le parent persiste comme il veut (l'endpoint vit chez lui).
 */
export type ItemChange =
  | { type: 'create'; item: Item }
  | { type: 'rename'; id: string; name: string }
  | { type: 'delete'; id: string }
  | { type: 'reorder'; orderedIds: string[] };

/**
 * Tous les textes affichés par le composant.
 * Passés via la prop `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface SectionEditorLabels {
  /** Titre du panneau. */
  title: string;
  /** Description sous le titre. */
  subtitle: string;
  /** Libellé du bouton d'ajout. */
  addButton: string;
  /** Message affiché quand la liste est vide. */
  emptyMessage: string;
  /** Titre du formulaire en mode ajout. */
  addTitle: string;
  /** Titre du formulaire en mode édition. */
  editTitle: string;
  /** Titre de la confirmation de suppression. */
  deleteTitle: string;
  /** Corps de la confirmation ; reçoit l'item et le préfixe (pas de duplication). */
  deleteBody: (item: Item, prefix: string) => string;
  /** Bouton « annuler » du formulaire. */
  cancel: string;
  /** Bouton « enregistrer » du formulaire. */
  save: string;
  /** Aide sous le champ quand la saisie est valide. */
  hint: string;
  /** Aide sous le champ quand la saisie est invalide (format). */
  hintInvalid: string;
  /** Aide sous le champ quand le nom existe déjà dans la liste. */
  hintDuplicate: string;
}

/**
 * Tous les textes par défaut affichés par le composant.
 */
const defaultLabels: SectionEditorLabels = {
  title: 'Modifier les éléments',
  subtitle: 'Glisse pour réorganiser · ajoute, modifie ou supprime un élément',
  addButton: 'Ajouter un élément',
  emptyMessage: 'Aucun élément pour le moment.',
  addTitle: 'Nouvel élément',
  editTitle: "Modifier l'élément",
  deleteTitle: "Supprimer l'élément ?",
  deleteBody: (item, prefix) =>
    `L'élément « ${prefix ? `${prefix} ` : ''}${item.name} » et tous ses messages seront définitivement supprimés. Cette action est irréversible.`,
  cancel: 'Annuler',
  save: 'Enregistrer',
  hint: 'Lettres minuscules, chiffres et tirets uniquement',
  hintInvalid: '⚠  Lettres minuscules, chiffres et tirets uniquement',
  hintDuplicate: '⚠  Ce nom existe déjà',
};

const namePattern = /^[a-zà-öø-ÿ0-9-]+$/;

export function SectionEditor({
  prefix = '#',
  onClose,
  itemList,
  onChange,
  labels,
}: SectionEditorProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };
  const [items, setItems] = useState<Item[]>(itemList);
  const dragIndex = useRef<number | null>(null);
  const orderBeforeDrag = useRef<string[] | null>(null);
  const [handleHeldId, setHandleHeldId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  function startEdit(item: Item) {
    setIsAdding(false);
    setEditingId(item.id);
    setDraftName(item.name);
  }

  function startAdd() {
    setEditingId(null);
    setIsAdding(true);
    setDraftName('');
  }

  function cancelEdit() {
    setEditingId(null);
    setIsAdding(false);
    setDraftName('');
  }

  function confirmDelete() {
    const id = deletingId;
    if (id === null) return;
    setItems((prev) => prev.filter((item) => item.id !== id));
    setDeletingId(null);
    onChange({ type: 'delete', id });
  }

  function isNameTaken(name: string) {
    return items.some((item) => item.name === name && item.id !== editingId);
  }

  function saveEdit() {
    const trimmed = draftName.trim();
    if (!namePattern.test(trimmed) || isNameTaken(trimmed)) return;

    let change: ItemChange;
    if (isAdding) {
      const item: Item = { id: crypto.randomUUID(), name: trimmed };
      setItems((prev) => [...prev, item]);
      change = { type: 'create', item };
    } else if (editingId !== null) {
      const id = editingId;
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, name: trimmed } : item)));
      change = { type: 'rename', id, name: trimmed };
    } else {
      return;
    }
    // On ferme le formulaire AVANT de notifier : l'UX ne dépend pas du callback parent.
    cancelEdit();
    onChange(change);
  }

  function requestClose(action?: () => void) {
    const act = action ?? (() => {});

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      act();
      return;
    }
    pendingAction.current = act;
    setIsClosing(true);
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) {
      pendingAction.current?.();
      pendingAction.current = null;
    }
  }

  function handleDragStart(index: number) {
    dragIndex.current = index;
    orderBeforeDrag.current = items.map((item) => item.id);
    setDraggingId(items[index].id);
  }

  function handleDragEnter(overIndex: number) {
    const from = dragIndex.current;
    if (from === null || from === overIndex) return;
    setItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(overIndex, 0, moved);
      return next;
    });
    dragIndex.current = overIndex;
  }

  function handleDragEnd() {
    dragIndex.current = null;
    setDraggingId(null);
    setHandleHeldId(null);

    const before = orderBeforeDrag.current;
    orderBeforeDrag.current = null;
    if (!before) return;

    const orderedIds = items.map((item) => item.id);
    // On notifie seulement si l'ordre a réellement changé.
    if (before.join(' ') !== orderedIds.join(' ')) {
      onChange({ type: 'reorder', orderedIds });
    }
  }

  const draftTrimmed = draftName.trim();
  const isDraftInvalid = !namePattern.test(draftTrimmed);
  const isDraftDuplicate = draftTrimmed !== '' && isNameTaken(draftTrimmed);
  const draftHasError = isDraftInvalid || isDraftDuplicate;
  const draftHint = isDraftDuplicate ? t.hintDuplicate : isDraftInvalid ? t.hintInvalid : t.hint;
  const deletingItem = items.find((item) => item.id === deletingId) ?? null;

  function editRowInner(titleText: string) {
    return (
      <>
        <h2>{titleText}</h2>
        <div>
          <div className={draftHasError ? styles.invalid : undefined}>
            <span>{prefix}</span>
            <input
              type="text"
              value={draftName}
              autoFocus
              onChange={(e) => setDraftName(e.target.value.toLowerCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                if (e.key === 'Escape') cancelEdit();
              }}
            />
          </div>
          <p className={draftHasError ? styles.invalid : undefined}>{draftHint}</p>
        </div>
        <div>
          <button onClick={cancelEdit}>{t.cancel}</button>
          <button onClick={saveEdit} disabled={draftTrimmed === '' || draftHasError}>
            {t.save}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div
        className={`${styles['section-editor']}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div onAnimationEnd={handleAnimationEnd}>
          <header>
            <div>
              <h1>{t.title}</h1>
              <p>{t.subtitle}</p>
            </div>
            <button onClick={() => requestClose(onClose)}>✕</button>
          </header>
          <main>
            {items.length === 0 && !isAdding ? (
              <p className={styles.empty}>{t.emptyMessage}</p>
            ) : (
              <ol>
                {items.map((item, index) =>
                  editingId === item.id ? (
                    <li key={item.id} className={styles['edit-row']}>
                      {editRowInner(t.editTitle)}
                    </li>
                  ) : (
                    <li
                      key={item.id}
                      draggable={handleHeldId === item.id}
                      onDragStart={() => handleDragStart(index)}
                      onDragEnter={() => handleDragEnter(index)}
                      onDragOver={(e) => e.preventDefault()}
                      onDragEnd={handleDragEnd}
                      className={draggingId === item.id ? styles.dragging : undefined}
                    >
                      <div>
                        <span
                          className={styles.handle}
                          onMouseDown={() => setHandleHeldId(item.id)}
                          onMouseUp={() => setHandleHeldId(null)}
                        >
                          ⠿
                        </span>
                        <span>
                          {prefix} {item.name}
                        </span>
                      </div>
                      <div>
                        <Pencil onClick={() => startEdit(item)} />
                        <TrashCan onClick={() => setDeletingId(item.id)} />
                      </div>
                    </li>
                  )
                )}
              </ol>
            )}
          </main>
          <footer>
            {isAdding ? (
              <div className={styles['edit-row']}>{editRowInner(t.addTitle)}</div>
            ) : (
              <button onClick={startAdd}>
                +<span>{t.addButton}</span>
              </button>
            )}
          </footer>
        </div>
      </div>
      {deletingItem && (
        <DeleteConfirmationBox
          title={t.deleteTitle}
          content={t.deleteBody(deletingItem, prefix)}
          onDeleteConfirmation={confirmDelete}
          onClose={() => setDeletingId(null)}
        />
      )}
    </>
  );
}
