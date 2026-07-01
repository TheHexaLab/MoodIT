import React, { useEffect, useRef, useState } from 'react';
import styles from './JoinCoursesPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { Check } from '../../assets/Check.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { defaultLabels } from './labels.ts';
import type { JoinableCourse, JoinCoursesPopupLabels, MaybePromise } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ces types depuis ce module.
export type { JoinableCourse, JoinCoursesPopupLabels, MaybePromise } from './types.ts';

interface JoinCoursesPopupProps {
  /** Nom du programme ciblé (affiché dans le sous-titre). */
  programName: string;
  /** Couleur du programme (pastilles des cours). */
  programColor?: string;
  /** Charge la liste des cours du programme. Un retour non-tableau = erreur. */
  loadCourses: () => MaybePromise<JoinableCourse[]>;
  /** Charge les ids des cours déjà rattachés à l'utilisateur (pré-cochés, désélectionnables). */
  loadJoinedCourseIds: () => MaybePromise<number[]>;
  /** Émis à la validation avec les ids des cours choisis. Peut être async (POST). */
  onJoin: (courseIds: number[]) => MaybePromise<unknown>;
  /** Ferme le popup. */
  onClose: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<JoinCoursesPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

export function JoinCoursesPopup({
  programName,
  programColor = '#0d9488',
  loadCourses,
  loadJoinedCourseIds,
  onJoin,
  onClose,
  labels,
}: JoinCoursesPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const [courses, setCourses] = useState<JoinableCourse[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /** Incrémenté par « réessayer » pour relancer le chargement. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Adhésion async en cours : pilote le spinner et empêche les doubles déclenchements. */
  const [pending, setPending] = useState(false);
  /** Message d'erreur d'enregistrement (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées. */
  const requestRef = useRef(0);
  const pendingAction = useRef<(() => void) | null>(null);
  /** Loaders dans des refs : l'effet de chargement ne dépend pas de leur identité. */
  const loadCoursesRef = useRef(loadCourses);
  const loadJoinedCourseIdsRef = useRef(loadJoinedCourseIds);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Garde les loaders à jour sans que l'effet de chargement ne dépende de leur identité.
  useEffect(() => {
    loadCoursesRef.current = loadCourses;
    loadJoinedCourseIdsRef.current = loadJoinedCourseIds;
  }, [loadCourses, loadJoinedCourseIds]);

  // Chargement au montage (+ « réessayer » via reloadKey) : la liste des cours du
  // programme ET les ids des cours déjà rattachés à l'utilisateur (qui pilotent la
  // pré-sélection, indépendamment de l'état du Dashboard). Aucun setState SYNCHRONE
  // dans le corps de l'effet : `loading` démarre déjà à true et reload() le repositionne.
  useEffect(() => {
    const reqId = ++requestRef.current;
    let cancelled = false;
    Promise.all([
      Promise.resolve().then(() => loadCoursesRef.current()),
      Promise.resolve().then(() => loadJoinedCourseIdsRef.current()),
    ])
      .then(([coursesData, joinedData]) => {
        if (cancelled || !mountedRef.current || requestRef.current !== reqId) return;
        if (!Array.isArray(coursesData) || !Array.isArray(joinedData)) {
          setLoadError(true);
          return;
        }
        setCourses(coursesData);
        setSelectedIds(joinedData);
      })
      .catch(() => {
        if (cancelled || !mountedRef.current || requestRef.current !== reqId) return;
        setLoadError(true);
      })
      .finally(() => {
        if (!cancelled && mountedRef.current && requestRef.current === reqId) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  /** Relance le chargement (bouton « réessayer ») : remet l'état de chargement. */
  function reload() {
    setLoading(true);
    setLoadError(false);
    setReloadKey((key) => key + 1);
  }

  /** Joue l'animation de sortie puis exécute l'action (immédiat si reduced-motion). */
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

  function toggle(id: number) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((cid) => cid !== id) : [...prev, id]));
  }

  async function join() {
    // Aucune sélection est autorisé : se désinscrire de tous les cours du programme.
    if (pending) return;
    const reqId = ++requestRef.current;
    setError(null);
    setPending(true);
    try {
      await onJoin(selectedIds);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      requestClose(onClose); // succès → ferme via onClose
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(false);
    }
  }

  const query = search.trim().toLowerCase();
  const filtered =
    query === ''
      ? courses
      : courses.filter((course) => `${course.code} ${course.title}`.toLowerCase().includes(query));

  const hasCourses = !loading && !loadError && courses.length > 0;
  // 0 cours sélectionné est valide (désinscription complète du programme).
  const canJoin = hasCourses && !pending;

  return (
    <>
      <div
        className={`${styles.scrim}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div className={styles.dialog} onAnimationEnd={handleAnimationEnd}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h1>{t.title}</h1>
              <p>{t.subtitle(programName)}</p>
            </div>
            <button type="button" className={styles.close} onClick={() => requestClose(onClose)}>
              ✕
            </button>
          </header>

          {hasCourses && (
            <div className={styles.search}>
              <MagnifyingGlass width="1rem" height="1rem" />
              <input
                type="text"
                placeholder={t.searchPlaceholder}
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          )}

          <div className={styles.body}>
            {loading ? (
              <div className={styles.stateMsg} role="status" aria-live="polite">
                <Spinner />
              </div>
            ) : loadError ? (
              <div className={styles.stateMsg} role="alert">
                <p>{t.loadError}</p>
                <button type="button" className={styles.retry} onClick={reload}>
                  {t.retry}
                </button>
              </div>
            ) : courses.length === 0 ? (
              <div className={styles.stateMsg}>{t.noCourses}</div>
            ) : (
              <ul className={styles.list}>
                {filtered.length === 0 ? (
                  <li className={styles.empty}>{t.noResults}</li>
                ) : (
                  filtered.map((course) => {
                    const selected = selectedIds.includes(course.id);
                    return (
                      <li key={course.id}>
                        <button
                          type="button"
                          className={`${styles.itemBtn}${selected ? ` ${styles.selected}` : ''}`}
                          aria-pressed={selected}
                          onClick={() => toggle(course.id)}
                        >
                          <span
                            className={styles.swatch}
                            style={{ background: programColor, color: contrastingTextColor(programColor) }}
                          >
                            {course.code.slice(0, 3)}
                          </span>
                          <span className={styles.info}>
                            <span className={styles.courseTitle}>{course.title}</span>
                            <span className={styles.courseCode}>{course.code}</span>
                          </span>
                          {selected && <Check className={styles.check} width="1rem" height="1rem" />}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>

          <footer className={styles.footer}>
            <button type="button" className={styles.cancelBtn} onClick={() => requestClose(onClose)}>
              {t.cancel}
            </button>
            <button type="button" className={styles.joinBtn} onClick={join} disabled={!canJoin}>
              {pending ? <Spinner /> : t.join}
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
