import React, { useEffect, useRef, useState } from 'react';
import styles from './AddCoursePopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { CODE_MAX_LENGTH, NAME_MAX_LENGTH, defaultLabels } from './labels.ts';
import type {
  AddCoursePopupLabels,
  Establishment,
  MaybePromise,
  NewCourse,
  Program,
} from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type { AddCoursePopupLabels, Establishment, MaybePromise, NewCourse, Program } from './types.ts';

interface AddCoursePopupProps {
  onClose: (...args: unknown[]) => unknown;
  /**
   * Émise à la sauvegarde avec le cours saisi ; le parent persiste comme il veut.
   * Peut être async (POST) : le popup attend sa résolution avant de se fermer,
   * et reste ouvert en affichant une erreur si elle rejette.
   */
  onSave: (course: NewCourse) => MaybePromise<unknown>;
  /** Charge la liste des établissements (dropdown). Appelé une fois à l'ouverture. */
  loadEstablishments: () => Promise<Establishment[]>;
  /**
   * Charge les programmes de l'établissement où l'utilisateur peut AJOUTER un cours (admin/prof, ou
   * tous s'il est admin global/gardien). Rappelé à chaque changement d'établissement.
   */
  loadPrograms: (establishmentId: number) => Promise<Program[]>;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<AddCoursePopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

export function AddCoursePopup({
  onClose,
  onSave,
  loadEstablishments,
  loadPrograms,
  labels,
}: AddCoursePopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  /** Ids des programmes rattachés au cours. */
  const [programIds, setProgramIds] = useState<number[]>([]);
  /** Menu déroulant (programmes) ouvert ? */
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  /** Établissements chargés (dropdown) + celui qui est sélectionné. */
  const [establishments, setEstablishments] = useState<Establishment[]>([]);
  const [establishmentId, setEstablishmentId] = useState<number | null>(null);
  /** Dropdown établissement (mono-choix, calqué sur celui des programmes) ouvert ? + recherche. */
  const [estOpen, setEstOpen] = useState(false);
  const [estSearch, setEstSearch] = useState('');
  /** Programmes GÉRABLES de l'établissement sélectionné (chargés à la volée). */
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loadingPrograms, setLoadingPrograms] = useState(false);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  /** Conteneur du champ programmes (pour le click-outside du menu). */
  const fieldRef = useRef<HTMLElement | null>(null);
  /** Conteneur du champ établissement (pour le click-outside de son menu). */
  const estFieldRef = useRef<HTMLElement | null>(null);

  /** Sauvegarde async en cours : pilote le spinner et empêche les doubles déclenchements. */
  const [pending, setPending] = useState(false);
  /** Message d'erreur de la dernière sauvegarde (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  /** Composant monté ? Ignore les réponses async qui reviennent après démontage. */
  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées (race conditions). */
  const requestRef = useRef(0);

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Chargement des établissements (dropdown) à l'ouverture.
  useEffect(() => {
    let cancelled = false;
    loadEstablishments()
      .then((list) => {
        if (!cancelled) setEstablishments(list);
      })
      .catch(() => {
        if (!cancelled) setEstablishments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadEstablishments]);

  // Chargement des programmes GÉRABLES à chaque changement d'établissement (réinitialise la
  // sélection : les programmes disponibles dépendent de l'établissement).
  useEffect(() => {
    if (establishmentId === null) {
      setPrograms([]);
      return;
    }
    let cancelled = false;
    setLoadingPrograms(true);
    setPrograms([]);
    setProgramIds([]);
    setIsOpen(false);
    loadPrograms(establishmentId)
      .then((list) => {
        if (!cancelled) setPrograms(list);
      })
      .catch(() => {
        if (!cancelled) setPrograms([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPrograms(false);
      });
    return () => {
      cancelled = true;
    };
  }, [establishmentId, loadPrograms]);

  // Ferme le menu (programmes) quand on clique en dehors du champ.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isOpen]);

  // Ferme le menu (établissement) quand on clique en dehors de son champ.
  useEffect(() => {
    if (!estOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (estFieldRef.current && !estFieldRef.current.contains(event.target as Node)) {
        setEstOpen(false);
        setEstSearch('');
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [estOpen]);

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

  /** Programmes rattachés (dans l'ordre de sélection). */
  function attachedPrograms(): Program[] {
    return programIds
      .map((id) => programs.find((p) => p.id === id))
      .filter((p): p is Program => p !== undefined);
  }

  /** Candidats = programmes non rattachés, filtrés par la recherche. */
  function candidatePrograms(): Program[] {
    const query = search.trim().toLowerCase();
    return programs.filter((p) => {
      if (programIds.includes(p.id)) return false;
      if (query === '') return true;
      return `${p.name} ${p.code} ${p.cohort}`.toLowerCase().includes(query);
    });
  }

  function toggleOpen() {
    if (establishmentId === null) return; // pas de programmes tant qu'aucun établissement n'est choisi
    setIsOpen((prev) => !prev);
    setSearch('');
  }

  function addProgram(id: number) {
    setProgramIds((prev) => [...prev, id]);
    setSearch('');
  }

  function removeProgram(id: number) {
    setProgramIds((prev) => prev.filter((pid) => pid !== id));
  }

  const canSave = code.trim() !== '' && title.trim() !== '' && programIds.length > 0;

  async function save() {
    if (!canSave || pending) return;
    const course: NewCourse = { title: title.trim(), code: code.trim(), programIds };
    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      // onSave peut être async (POST) : on attend sa résolution avant de fermer.
      await onSave(course);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      requestClose(onClose); // succès → ferme via onClose
    } catch {
      // Échec → le popup reste ouvert et affiche l'erreur.
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(false);
    }
  }

  return (
    <>
      <div
        className={`${styles['add-course']}${isClosing ? ` ${styles.closing}` : ''}`}
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

          <section className={styles.programs} ref={estFieldRef}>
            <span className={styles['field-label']}>{t.establishmentLabel}</span>
            <div className={styles['field-control']}>
              <div
                className={`${styles['tags-input']}${estOpen ? ` ${styles.open}` : ''}`}
                onClick={() => {
                  setEstOpen((prev) => !prev);
                  setEstSearch('');
                }}
              >
                {establishmentId === null ? (
                  <span className={styles.placeholder}>{t.establishmentPlaceholder}</span>
                ) : (
                  <span className={styles['selected-value']}>
                    {establishments.find((e) => e.id === establishmentId)?.name ?? ''}
                  </span>
                )}
              </div>
              <Chevron
                className={`${styles.chevron}${estOpen ? ` ${styles['chevron-open']}` : ''}`}
                width="1rem"
                height="1rem"
              />
            </div>
            {estOpen && (
              <div className={styles.picker}>
                <div className={styles['picker-search']}>
                  <MagnifyingGlass width="1rem" height="1rem" />
                  <input
                    type="text"
                    placeholder={t.establishmentSearchPlaceholder}
                    autoFocus
                    value={estSearch}
                    onChange={(e) => setEstSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEstOpen(false);
                    }}
                  />
                </div>
                <ul>
                  {(() => {
                    const q = estSearch.trim().toLowerCase();
                    const list = establishments.filter(
                      (e) => q === '' || e.name.toLowerCase().includes(q)
                    );
                    if (list.length === 0) {
                      return (
                        <li className={styles['picker-empty']}>
                          {q === '' ? t.noEstablishments : t.noResults}
                        </li>
                      );
                    }
                    return list.map((est) => (
                      <li key={est.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setEstablishmentId(est.id);
                            setEstOpen(false);
                            setEstSearch('');
                          }}
                        >
                          <div>
                            <span>{est.name}</span>
                          </div>
                        </button>
                      </li>
                    ));
                  })()}
                </ul>
              </div>
            )}
          </section>

          <section className={styles.programs} ref={fieldRef}>
            <span className={styles['field-label']}>{t.programsLabel}</span>
            <div className={styles['field-control']}>
              <div
                className={`${styles['tags-input']}${isOpen ? ` ${styles.open}` : ''}`}
                onClick={toggleOpen}
              >
                {programIds.length === 0 ? (
                  <span className={styles.placeholder}>
                    {establishmentId === null ? t.programsPickEstablishment : t.programsPlaceholder}
                  </span>
                ) : (
                  attachedPrograms().map((program) => (
                    <span
                      key={program.id}
                      className={styles.chip}
                      style={{ ['--chip-color']: program.color } as React.CSSProperties}
                      role="button"
                      aria-label={`Retirer ${program.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeProgram(program.id);
                      }}
                    >
                      <span>
                        {program.code} - {program.cohort}
                      </span>
                      <button
                        type="button"
                        aria-label={`Retirer ${program.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          removeProgram(program.id);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <Chevron
                className={`${styles.chevron}${isOpen ? ` ${styles['chevron-open']}` : ''}`}
                width="1rem"
                height="1rem"
              />
            </div>
            {isOpen && (
              <div className={styles.picker}>
                <div className={styles['picker-search']}>
                  <MagnifyingGlass width="1rem" height="1rem" />
                  <input
                    type="text"
                    placeholder={t.searchPlaceholder}
                    autoFocus
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setIsOpen(false);
                    }}
                  />
                </div>
                <ul>
                  {candidatePrograms().length === 0 ? (
                    <li className={styles['picker-empty']}>
                      {loadingPrograms ? (
                        <Spinner />
                      ) : search.trim() === '' ? (
                        t.noManageablePrograms
                      ) : (
                        t.noResults
                      )}
                    </li>
                  ) : (
                    candidatePrograms().map((program) => (
                      <li key={program.id}>
                        <button type="button" onClick={() => addProgram(program.id)}>
                          <span className={styles.swatch} style={{ background: program.color }}>
                            <span style={{ color: contrastingTextColor(program.color) }}>
                              {program.code}
                            </span>
                          </span>
                          <div>
                            <span>{program.name}</span>
                            <span>Cohorte {program.cohort}</span>
                          </div>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            )}
          </section>

          <label className={styles.field}>
            <span>{t.codeLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.codePlaceholder}
                maxLength={CODE_MAX_LENGTH}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
          </label>

          <label className={styles.field}>
            <span>{t.titleLabel}</span>
            <div>
              <input
                type="text"
                placeholder={t.titlePlaceholder}
                maxLength={NAME_MAX_LENGTH}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
          </label>

          <footer>
            <button type="button" onClick={() => requestClose(onClose)}>
              {t.cancel}
            </button>
            <button type="button" onClick={save} disabled={!canSave || pending}>
              {pending ? <Spinner /> : t.save}
            </button>
          </footer>
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
