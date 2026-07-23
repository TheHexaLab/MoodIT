import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './SectionEditorPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { DeleteConfirmationPopup } from '../DeleteConfirmationPopup/DeleteConfirmationPopup.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { defaultLabels } from './labels.ts';
import type { Item, ItemChange, MaybePromise, SectionEditorPopupLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type { Item, ItemChange, MaybePromise, SectionEditorPopupLabels } from './types.ts';

interface SectionEditorPopupProps {
  /** Icône/préfixe affiché devant chaque nom (ex. `<ChannelTypeIcon />`). */
  prefix?: React.ReactNode;
  onClose: (...args: unknown[]) => unknown;
  itemList: Item[];
  /**
   * Émise à chaque modification ; le parent persiste comme il veut (l'endpoint vit chez lui).
   * Peut être async (POST/PATCH/DELETE) : le composant affiche un spinner et attend sa résolution.
   * Si elle rejette, la modification optimiste est annulée et une erreur s'affiche.
   */
  onChange?: (change: ItemChange) => MaybePromise<unknown>;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<SectionEditorPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

export function SectionEditorPopup({
  prefix = '#',
  onClose,
  itemList,
  onChange,
  labels,
}: SectionEditorPopupProps): React.ReactElement {
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

  /** Modification async en cours ? Pilote le spinner et empêche les doubles déclenchements. */
  const [pending, setPending] = useState(false);
  /** Message d'erreur de la dernière modification (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  /** Composant monté ? Ignore les réponses async qui reviennent après démontage. */
  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées (race conditions). */
  const requestRef = useRef(0);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Persiste une modification optimiste : notifie `onChange`, et si l'appel échoue,
   * annule le changement (`rollback`) et affiche une erreur. Garde anti-périmé/démontage.
   * Utilisé pour les actions sans formulaire persistant (suppression, réordonnancement).
   */
  async function runChange(change: ItemChange, rollback: () => void) {
    if (!onChange) return;
    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      await onChange(change);
      if (!mountedRef.current || requestRef.current !== reqId) return;
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      rollback();
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(false);
    }
  }

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
    // Suppression optimiste : on retire l'item, et on le réinsère à sa place si l'appel échoue.
    const index = items.findIndex((item) => item.id === id);
    const removed = items[index];
    setItems((prev) => prev.filter((item) => item.id !== id));
    setDeletingId(null);
    runChange({ type: 'delete', id }, () => {
      setItems((prev) => {
        const next = [...prev];
        next.splice(index, 0, removed);
        return next;
      });
    });
  }

  function isNameTaken(name: string) {
    return items.some((item) => item.name === name && item.id !== editingId);
  }

  async function saveEdit() {
    const trimmed = draftName.trim();
    if (!trimmed || isNameTaken(trimmed) || pending) return;

    // On garde le formulaire ouvert (avec spinner) jusqu'à la résolution : la liste
    // n'est mise à jour qu'après un succès, et l'erreur laisse la saisie intacte.
    let change: ItemChange;
    // `apply` reçoit le changement RENVOYÉ par onChange (le backend y met l'id réel du
    // forum créé) : on l'utilise pour poser le bon id, sinon un renommage/suppression
    // enchaîné dans ce popup enverrait l'id temporaire (crypto.randomUUID) au serveur.
    let apply: (result?: ItemChange | void) => void;
    if (isAdding) {
      const item: Item = { id: crypto.randomUUID(), name: trimmed };
      change = { type: 'create', item };
      apply = (result) => {
        const realId = result && result.type === 'create' ? result.item.id : undefined;
        setItems((prev) => [...prev, realId ? { ...item, id: realId } : item]);
      };
    } else if (editingId !== null) {
      const id = editingId;
      change = { type: 'rename', id, name: trimmed };
      apply = () =>
        setItems((prev) =>
          prev.map((item) => (item.id === id ? { ...item, name: trimmed } : item))
        );
    } else {
      return;
    }

    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      const result = onChange ? await onChange(change) : undefined;
      if (!mountedRef.current || requestRef.current !== reqId) return;
      apply(result as ItemChange | void);
      cancelEdit();
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(false);
    }
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
      // Réordonnancement optimiste : on rétablit l'ordre d'avant le drag si l'appel échoue.
      runChange({ type: 'reorder', orderedIds }, () => {
        setItems((prev) => {
          const byId = new Map(prev.map((item) => [item.id, item]));
          return before
            .map((id) => byId.get(id))
            .filter((item): item is Item => item !== undefined);
        });
      });
    }
  }

  const draftTrimmed = draftName.trim();
  const isDraftInvalid = !draftTrimmed;
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
              onChange={(e) => setDraftName(e.target.value)}
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
          <button onClick={saveEdit} disabled={draftTrimmed === '' || draftHasError || pending}>
            {pending ? <Spinner /> : t.save}
          </button>
        </div>
      </>
    );
  }

  // Porté vers <body> : un modal en position:fixed doit vivre à la racine, sinon
  // il est rogné par un ancêtre (ex. la sidebar CourseMenu en overflow:hidden).
  return createPortal(
    <>
      <div
        className={`${styles['section-editor-popup']}${isClosing ? ` ${styles.closing}` : ''}`}
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
                          <span>{prefix}</span>
                          <span>{item.name}</span>
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
        <DeleteConfirmationPopup
          title={t.deleteTitle}
          content={t.deleteBody(deletingItem)}
          onDeleteConfirmation={confirmDelete}
          onClose={() => setDeletingId(null)}
        />
      )}
      {error && (
        <ErrorPopup
          content={error}
          labels={{ title: t.errorTitle, close: t.errorClose }}
          onClose={() => setError(null)}
        />
      )}
    </>,
    document.body
  );
}
