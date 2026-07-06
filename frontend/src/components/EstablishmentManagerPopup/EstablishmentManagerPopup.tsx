import React, { useEffect, useRef, useState } from 'react';
import styles from './EstablishmentManagerPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { DeleteConfirmationPopup } from '../DeleteConfirmationPopup/DeleteConfirmationPopup.tsx';
import type { ManagedEstablishment } from '../../types/domain.ts';

/** Valeur synchrone ou asynchrone : un callback d'API peut retourner une Promise. */
export type MaybePromise<T> = T | Promise<T>;

interface EstablishmentManagerPopupProps {
  onClose: () => void;
  /** Charge la liste des établissements (GET). Appelé au montage. */
  onLoad: () => MaybePromise<ManagedEstablishment[]>;
  /** Crée un établissement ; résout avec l'établissement persisté. */
  onCreate: (name: string, domainEmail: string) => MaybePromise<ManagedEstablishment>;
  /** Modifie un établissement ; résout avec l'établissement à jour. */
  onUpdate: (
    id: number,
    update: { name: string; domainEmail: string }
  ) => MaybePromise<ManagedEstablishment>;
  /** Supprime un établissement (DESTRUCTIF : cascade programmes/cours/membres). */
  onDelete: (id: number) => MaybePromise<unknown>;
}

function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

/** Brouillon d'un formulaire d'ajout / d'édition. */
interface Draft {
  name: string;
  domainEmail: string;
}

const EMPTY_DRAFT: Draft = { name: '', domainEmail: '' };

/**
 * Gestionnaire des établissements (réservé aux gardiens) : liste + ajout / édition / suppression.
 * Accédé depuis le menu « + Ajouter un programme » (3e option). Chaque mutation est persistée via
 * les callbacks, puis reflétée dans la liste locale.
 */
export function EstablishmentManagerPopup({
  onClose,
  onLoad,
  onCreate,
  onUpdate,
  onDelete,
}: EstablishmentManagerPopupProps): React.ReactElement {
  const [establishments, setEstablishments] = useState<ManagedEstablishment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Ligne en cours d'édition (id), ou 'new' pour le formulaire d'ajout, ou null. */
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** Id en cours de persistance (spinner + verrou anti double-clic). */
  const [pendingId, setPendingId] = useState<number | 'new' | null>(null);
  /** Établissement dont on demande confirmation de suppression. */
  const [confirmDelete, setConfirmDelete] = useState<ManagedEstablishment | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const data = await onLoad();
        if (!cancelled) setEstablishments([...data].sort((a, b) => a.name.localeCompare(b.name)));
      } catch {
        if (!cancelled) setLoadError('Impossible de charger les établissements. Réessaie.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onLoad]);

  const draftValid = draft.name.trim() !== '' && draft.domainEmail.trim() !== '';

  function startAdd() {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
  }

  function startEdit(est: ManagedEstablishment) {
    setEditing(est.id);
    setDraft({ name: est.name, domainEmail: est.domainEmail ?? '' });
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  async function saveDraft() {
    if (!draftValid || pendingId !== null) return;
    const name = draft.name.trim();
    const domainEmail = draft.domainEmail.trim();
    setError(null);

    if (editing === 'new') {
      setPendingId('new');
      try {
        const created = await onCreate(name, domainEmail);
        if (!mountedRef.current) return;
        setEstablishments((prev) =>
          [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
        );
        cancelEdit();
      } catch {
        if (mountedRef.current) setError("La création de l'établissement a échoué. Réessaie.");
      } finally {
        if (mountedRef.current) setPendingId(null);
      }
      return;
    }

    if (typeof editing === 'number') {
      const id = editing;
      setPendingId(id);
      try {
        const updated = await onUpdate(id, { name, domainEmail });
        if (!mountedRef.current) return;
        setEstablishments((prev) =>
          prev.map((e) => (e.id === id ? updated : e)).sort((a, b) => a.name.localeCompare(b.name))
        );
        cancelEdit();
      } catch {
        if (mountedRef.current) setError("La modification de l'établissement a échoué. Réessaie.");
      } finally {
        if (mountedRef.current) setPendingId(null);
      }
    }
  }

  async function confirmDeletion() {
    const target = confirmDelete;
    if (!target) return;
    setConfirmDelete(null);
    setError(null);
    setPendingId(target.id);
    try {
      await onDelete(target.id);
      if (!mountedRef.current) return;
      setEstablishments((prev) => prev.filter((e) => e.id !== target.id));
    } catch {
      if (mountedRef.current) setError("La suppression de l'établissement a échoué. Réessaie.");
    } finally {
      if (mountedRef.current) setPendingId(null);
    }
  }

  /** Formulaire d'ajout / d'édition (name + domaine courriel). */
  const form = (
    <div className={styles.form}>
      <input
        type="text"
        placeholder="Nom de l'établissement"
        value={draft.name}
        autoFocus
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
      />
      <input
        type="text"
        placeholder="Domaine courriel (ex. usherbrooke.ca)"
        value={draft.domainEmail}
        onChange={(e) => setDraft((d) => ({ ...d, domainEmail: e.target.value }))}
      />
      <div className={styles.formActions}>
        <button type="button" onClick={cancelEdit} disabled={pendingId !== null}>
          Annuler
        </button>
        <button
          type="button"
          className={styles.primary}
          onClick={saveDraft}
          disabled={!draftValid || pendingId !== null}
        >
          {pendingId === editing ? <Spinner /> : 'Enregistrer'}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div
        className={styles.overlay}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.card}>
          <header>
            <div>
              <h1>Gérer les établissements</h1>
              <p>Ajoute, modifie ou supprime des établissements de la plateforme.</p>
            </div>
            <button type="button" aria-label="Fermer" onClick={onClose}>
              ✕
            </button>
          </header>

          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.addBtn}
              onClick={startAdd}
              disabled={editing === 'new' || pendingId !== null}
            >
              + Ajouter un établissement
            </button>
          </div>

          {editing === 'new' && form}

          {loading ? (
            <div className={styles.center}>
              <BaseSpinner size={28} />
            </div>
          ) : loadError ? (
            <p className={styles.empty}>{loadError}</p>
          ) : establishments.length === 0 && editing !== 'new' ? (
            <p className={styles.empty}>Aucun établissement pour l'instant.</p>
          ) : (
            <ul className={styles.list}>
              {establishments.map((est) =>
                editing === est.id ? (
                  <li key={est.id}>{form}</li>
                ) : (
                  <li key={est.id}>
                    <div className={styles.info}>
                      <span className={styles.name}>{est.name}</span>
                      <span className={styles.meta}>
                        {est.domainEmail}
                        {typeof est.programCount === 'number' && (
                          <> · {est.programCount} programme{est.programCount > 1 ? 's' : ''}</>
                        )}
                      </span>
                    </div>
                    <div className={styles.rowActions}>
                      {pendingId === est.id ? (
                        <Spinner />
                      ) : (
                        <>
                          <button
                            type="button"
                            aria-label="Modifier"
                            onClick={() => startEdit(est)}
                            disabled={pendingId !== null || editing !== null}
                          >
                            <Pencil width="1rem" height="1rem" />
                          </button>
                          <button
                            type="button"
                            className={styles.danger}
                            aria-label="Supprimer"
                            onClick={() => setConfirmDelete(est)}
                            disabled={pendingId !== null || editing !== null}
                          >
                            <TrashCan width="1rem" height="1rem" />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              )}
            </ul>
          )}
        </div>
      </div>

      {confirmDelete && (
        <DeleteConfirmationPopup
          title="Supprimer l'établissement"
          content={
            `Supprimer « ${confirmDelete.name} » ?` +
            (confirmDelete.programCount
              ? ` Ses ${confirmDelete.programCount} programme(s) et tout leur contenu (cours, membres) seront aussi supprimés.`
              : '') +
            ' Cette action est irréversible.'
          }
          onDeleteConfirmation={confirmDeletion}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {error && <ErrorPopup content={error} onClose={() => setError(null)} />}
    </>
  );
}
