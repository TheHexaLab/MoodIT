import React, { useEffect, useRef, useState } from 'react';
import styles from './AddCoursePopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { CODE_MAX_LENGTH, NAME_MAX_LENGTH, defaultLabels } from './labels.ts';
import type { AddCoursePopupLabels, MaybePromise, NewCourse, Program } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type { AddCoursePopupLabels, MaybePromise, NewCourse, Program } from './types.ts';

interface AddCoursePopupProps {
  onClose: (...args: unknown[]) => unknown;
  /**
   * Émise à la sauvegarde avec le cours saisi ; le parent persiste comme il veut.
   * Peut être async (POST) : le popup attend sa résolution avant de se fermer,
   * et reste ouvert en affichant une erreur si elle rejette.
   */
  onSave: (course: NewCourse) => MaybePromise<unknown>;
  /** Programmes sélectionnables, fournis par le parent. */
  programs?: Program[];
  /** Programmes préselectionnés à l'ouverture (ex. le programme courant). */
  initialProgramIds?: number[];
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
  programs = [],
  initialProgramIds = [],
  labels,
}: AddCoursePopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  /** Ids des programmes rattachés au cours (préremplis avec le programme courant). */
  const [programIds, setProgramIds] = useState<number[]>(initialProgramIds);
  /** Menu déroulant ouvert ? */
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);
  /** Conteneur du champ programmes (pour le click-outside du menu). */
  const fieldRef = useRef<HTMLElement | null>(null);

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

  // Ferme le menu quand on clique en dehors du champ.
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

          <section className={styles.programs} ref={fieldRef}>
            <span className={styles['field-label']}>{t.programsLabel}</span>
            <div className={styles['field-control']}>
              <div
                className={`${styles['tags-input']}${isOpen ? ` ${styles.open}` : ''}`}
                onClick={toggleOpen}
              >
                {programIds.length === 0 ? (
                  <span className={styles.placeholder}>{t.programsPlaceholder}</span>
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
                      {search.trim() === '' ? t.noCandidates : t.noResults}
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
