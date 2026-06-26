import React, { useEffect, useRef, useState } from 'react';
import styles from './RoleEditorPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { initials } from './helpers.ts';
import { defaultLabels } from './labels.ts';
import type { MaybePromise, Role, RoleChange, RoleEditorPopupLabels, User } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type { MaybePromise, Role, RoleChange, RoleEditorPopupLabels, User } from './types.ts';

interface RoleEditorPopupProps {
  onClose: (...args: unknown[]) => unknown;
  /** Rôles à éditer, fournis par le parent. L'ordre du tableau = ordre d'affichage des sections. */
  roles?: Role[];
  /** Liste des utilisateurs (avec leurs rôles) à partir de laquelle les sections sont bâties. */
  users: User[];
  /**
   * Émise à chaque modification d'assignation ; le parent persiste comme il veut (l'endpoint vit chez lui).
   * Peut être async (INSERT/DELETE) : le composant affiche un spinner et attend sa résolution.
   * Si elle rejette, la modification optimiste est annulée et une erreur s'affiche.
   */
  onChange?: (change: RoleChange) => MaybePromise<unknown>;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<RoleEditorPopupLabels>;
}

/** Opération d'assignation async en cours (pilote le spinner et le verrouillage). */
interface Pending {
  type: 'assign' | 'unassign';
  roleId: number;
  userId: number;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

export function RoleEditorPopup({
  onClose,
  roles = [],
  users: initialUsers,
  onChange,
  labels,
}: RoleEditorPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };
  const [users, setUsers] = useState<User[]>(initialUsers);
  /** Section dont le sélecteur d'ajout est ouvert (null = aucun). */
  const [addingRoleId, setAddingRoleId] = useState<number | null>(null);
  /** Texte de recherche du sélecteur d'ajout. */
  const [search, setSearch] = useState('');

  /** Assignation async en cours : pilote le spinner et empêche les doubles déclenchements. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Message d'erreur de la dernière assignation (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  /** Composant monté ? Ignore les réponses async qui reviennent après démontage. */
  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées (race conditions). */
  const requestRef = useRef(0);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  /** Header de la section dont le sélecteur est ouvert (pour le click-outside). */
  const openSectionRef = useRef<HTMLElement | null>(null);

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Persiste une assignation optimiste : notifie `onChange`, et si l'appel échoue,
   * annule le changement (`rollback`) et affiche une erreur. Garde anti-périmé/démontage.
   */
  async function runChange(kind: Pending, change: RoleChange, rollback: () => void) {
    if (!onChange) return;
    const reqId = ++requestRef.current;
    setError(null);
    setPending(kind);
    try {
      await onChange(change);
      if (!mountedRef.current || requestRef.current !== reqId) return;
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      rollback();
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  // Ferme le sélecteur d'ajout quand on clique en dehors de sa section.
  useEffect(() => {
    if (addingRoleId === null) return;
    function onPointerDown(event: MouseEvent) {
      if (openSectionRef.current && !openSectionRef.current.contains(event.target as Node)) {
        setAddingRoleId(null);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [addingRoleId]);

  /** Joue l'animation de sortie puis exécute l'action (fermeture immédiate si reduced-motion). */
  function requestClose(action: () => void) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    pendingAction.current = action;
    setIsClosing(true);
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) {
      pendingAction.current?.();
      pendingAction.current = null;
    }
  }

  /** Utilisateurs d'une section = ceux dont les role_ids contiennent ce rôle. */
  function usersFor(roleId: number): User[] {
    return users.filter((user) => user.role_ids.includes(roleId));
  }

  /** Candidats à l'ajout = utilisateurs n'ayant pas encore ce rôle, filtrés par la recherche. */
  function candidatesFor(roleId: number): User[] {
    const query = search.trim().toLowerCase();
    return users.filter((user) => {
      if (user.role_ids.includes(roleId)) return false;
      if (query === '') return true;
      const haystack =
        `${user.firstName} ${user.lastName} ${user.email} ${user.username}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  /** Ouvre/ferme le sélecteur d'une section et réinitialise la recherche. */
  function toggleAdding(roleId: number) {
    setAddingRoleId((prev) => (prev === roleId ? null : roleId));
    setSearch('');
  }

  /** Retire le rôle de l'utilisateur (sans le supprimer de la liste). Optimiste + rollback. */
  function removeUser(roleId: number, userId: number) {
    if (pending !== null) return;
    setUsers((prev) =>
      prev.map((user) =>
        user.id === userId
          ? { ...user, role_ids: user.role_ids.filter((id) => id !== roleId) }
          : user
      )
    );
    runChange({ type: 'unassign', roleId, userId }, { type: 'unassign', roleId, userId }, () => {
      // Rollback : on réassigne le rôle retiré.
      setUsers((prev) =>
        prev.map((user) =>
          user.id === userId && !user.role_ids.includes(roleId)
            ? { ...user, role_ids: [...user.role_ids, roleId] }
            : user
        )
      );
    });
  }

  /** Ajoute le rôle à l'utilisateur. Optimiste + rollback. */
  function addUser(roleId: number, userId: number) {
    if (pending !== null) return;
    setUsers((prev) =>
      prev.map((user) =>
        user.id === userId ? { ...user, role_ids: [...user.role_ids, roleId] } : user
      )
    );
    // On ferme le sélecteur AVANT de notifier : l'UX ne dépend pas du callback parent.
    setAddingRoleId(null);
    setSearch('');
    runChange({ type: 'assign', roleId, userId }, { type: 'assign', roleId, userId }, () => {
      // Rollback : on retire le rôle ajouté.
      setUsers((prev) =>
        prev.map((user) =>
          user.id === userId
            ? { ...user, role_ids: user.role_ids.filter((id) => id !== roleId) }
            : user
        )
      );
    });
  }

  return (
    <>
      <div
        className={`${styles['role-editor-popup']}${isClosing ? ` ${styles.closing}` : ''}`}
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
          {roles.length === 0 && <p className={styles.empty}>{t.emptyRoles}</p>}
          {roles.map((role) => (
            <section key={role.id} data-role-id={role.id}>
              <header ref={addingRoleId === role.id ? openSectionRef : undefined}>
                <h2>
                  {role.name} · {usersFor(role.id).length}
                </h2>
                <button className={styles.add} onClick={() => toggleAdding(role.id)}>
                  +<span>{t.addButton}</span>
                </button>
                {addingRoleId === role.id && (
                  <div className={styles.picker}>
                    <div className={styles['picker-search']}>
                      <MagnifyingGlass width="1rem" height="1rem" />
                      <input
                        type="text"
                        placeholder={t.searchPlaceholder}
                        autoFocus
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <ul>
                      {candidatesFor(role.id).length === 0 ? (
                        <li className={styles['picker-empty']}>
                          {search.trim() === '' ? t.noCandidates : t.noResults}
                        </li>
                      ) : (
                        candidatesFor(role.id).map((user) => (
                          <li key={user.id}>
                            <button
                              disabled={pending !== null}
                              onClick={() => addUser(role.id, user.id)}
                            >
                              <span style={{ background: user.avatarColor }}>
                                <span style={{ color: contrastingTextColor(user.avatarColor) }}>
                                  {initials(user)}
                                </span>
                              </span>
                              <div>
                                <span>
                                  {user.firstName} {user.lastName}
                                </span>
                                <span>{user.email}</span>
                              </div>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                )}
              </header>
              {usersFor(role.id).length === 0 ? (
                <p className={styles.empty}>{t.emptyRole}</p>
              ) : (
                <ul>
                  {usersFor(role.id).map((user) => (
                    <li key={user.id}>
                      <div>
                        <span style={{ background: user.avatarColor }}>
                          <span style={{ color: contrastingTextColor(user.avatarColor) }}>
                            {initials(user)}
                          </span>
                        </span>
                        <div>
                          <span>
                            {user.firstName} {user.lastName}
                          </span>
                          <span>{user.email}</span>
                        </div>
                      </div>
                      <button
                        className={styles.delete}
                        disabled={pending !== null}
                        onClick={() => removeUser(role.id, user.id)}
                      >
                        {pending?.type === 'unassign' &&
                        pending.roleId === role.id &&
                        pending.userId === user.id ? (
                          <Spinner />
                        ) : (
                          <TrashCan width="1rem" height="1rem" />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </div>

      {error && (
        <ErrorPopup
          content={error}
          labels={{ title: t.errorTitle, close: t.errorClose }}
          onClose={() => setError(null)}
        />
      )}
    </>
  );
}
