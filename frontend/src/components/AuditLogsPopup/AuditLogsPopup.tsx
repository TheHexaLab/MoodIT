import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './AuditLogsPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { X } from '../../assets/X.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { defaultLabels } from './labels.ts';
import type { AuditLogEntry, AuditLogQuery, AuditLogsPopupLabels } from './types.ts';

// Ré-export de l'API publique : les consommateurs importent ces types depuis ce module.
export type { AuditLogEntry, AuditLogQuery, AuditLogsPopupLabels } from './types.ts';

interface AuditLogsPopupProps {
  /** Fermeture (clic en dehors, bouton « fermer »). */
  onClose: (...args: unknown[]) => unknown;
  /** Charge UNE page du journal (pagination par curseur + recherche/filtre serveur). */
  load: (query: AuditLogQuery) => Promise<AuditLogEntry[]>;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<AuditLogsPopupLabels>;
}

/** Sentinelle du filtre « tous les types ». */
const ALL = '__all__';
/** Taille d'une page (doit ≤ MAX_LIMIT backend). */
const PAGE_SIZE = 30;
/** Délai de debounce de la recherche réseau (ms). */
const SEARCH_DEBOUNCE_MS = 300;
/** Distance au bas de la liste (px) déclenchant le chargement de la page suivante. */
const SCROLL_THRESHOLD_PX = 140;

/** Teinte (H de HSL) par type d'entité → badge coloré (lisible clair ET sombre). */
const HUE: Record<string, number> = {
  ROLE: 265,
  PROGRAM: 215,
  COURSE: 175,
  FORUM: 35,
  QUIZ: 330,
  ESTABLISHMENT: 150,
  ENROLLMENT: 95,
  MCP: 245,
};

/** Style coloré d'un badge à partir de la teinte du type (gris neutre si type inconnu). */
function badgeStyle(entityType: string): React.CSSProperties {
  const hue = HUE[entityType];
  if (hue === undefined) {
    return {};
  }
  return {
    color: `hsl(${hue} 62% 45%)`,
    background: `hsl(${hue} 62% 45% / 0.13)`,
    borderColor: `hsl(${hue} 62% 45% / 0.32)`,
  };
}

/** Formatte un instant ISO (UTC) en date/heure locale lisible (fr-CA). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Journal d'audit (Gardien uniquement). Recherche plein-texte et filtre par type sont faits
 * CÔTÉ SERVEUR ; la liste se pagine EN SCROLL (curseur `beforeId`). Le chargement est délégué au
 * parent via `load` ; erreurs de première page affichées en popup (ErrorPopup) avec « réessayer ».
 */
export function AuditLogsPopup({
  onClose,
  load,
  labels,
}: AuditLogsPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState(''); // saisie brute
  const [debouncedQuery, setDebouncedQuery] = useState(''); // ce qui part au réseau
  const [type, setType] = useState<string>(ALL);
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<((...args: unknown[]) => unknown) | null>(null);
  const mountedRef = useRef(true);
  // Jeton de la requête de PREMIÈRE page : invalide les réponses (page 1 ou suivantes) périmées.
  const reqRef = useRef(0);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Debounce de la recherche : setState dans un timeout (asynchrone), pas dans le corps de l'effet.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const typeParam = type === ALL ? null : type;

  // Première page : rejouée à chaque changement de recherche/filtre (ou « réessayer »). Aucun
  // setState synchrone dans le corps de l'effet — tout passe par la chaîne de promesses.
  useEffect(() => {
    const token = ++reqRef.current;
    let cancelled = false;
    Promise.resolve()
      .then(() => {
        if (!cancelled && mountedRef.current && reqRef.current === token) {
          setPhase('loading');
          setOpenId(null);
        }
      })
      .then(() => loadRef.current({ q: debouncedQuery, type: typeParam, limit: PAGE_SIZE }))
      .then((rows) => {
        if (cancelled || !mountedRef.current || reqRef.current !== token) return;
        const page = Array.isArray(rows) ? rows : [];
        setEntries(page);
        setHasMore(page.length === PAGE_SIZE);
        setPhase('ready');
      })
      .catch(() => {
        if (cancelled || !mountedRef.current || reqRef.current !== token) return;
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
    // typeParam dérive de `type` ; le lister éviterait un recalcul, on garde `type`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, type, reloadKey]);

  // Page suivante (scroll) : ajoute au bas, sans toucher à la chaîne de première page.
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || phase !== 'ready' || entries.length === 0) return;
    const token = reqRef.current; // invalidé si la recherche/filtre change entre-temps
    const beforeId = entries[entries.length - 1].id;
    setLoadingMore(true);
    loadRef
      .current({ beforeId, q: debouncedQuery, type: typeParam, limit: PAGE_SIZE })
      .then((rows) => {
        if (!mountedRef.current || reqRef.current !== token) return;
        const page = Array.isArray(rows) ? rows : [];
        setEntries((prev) => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch(() => {
        // Échec d'une page suivante : on garde ce qui est déjà affiché (pas de popup bloquant).
      })
      .finally(() => {
        if (mountedRef.current && reqRef.current === token) setLoadingMore(false);
      });
  }, [loadingMore, hasMore, phase, entries, debouncedQuery, typeParam]);

  function onListScroll(event: React.UIEvent<HTMLUListElement>) {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD_PX) {
      loadMore();
    }
  }

  function reload() {
    setReloadKey((k) => k + 1);
  }

  function requestClose(action: (...args: unknown[]) => unknown) {
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

  const entityLabel = (code: string): string => t.entityTypes[code] ?? code;
  const filtering = debouncedQuery.trim() !== '' || type !== ALL;

  return (
    <>
      <div
        className={`${styles['audit-logs-popup']}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div onAnimationEnd={handleAnimationEnd}>
          <div className={styles.header}>
            <div>
              <h1>{t.title}</h1>
              <p>{t.subtitle}</p>
            </div>
            <button
              type="button"
              className={styles.closeButton}
              aria-label={t.close}
              onClick={() => requestClose(onClose)}
            >
              ✕
            </button>
          </div>

          <div className={styles.toolbar}>
            <div className={styles.search}>
              <MagnifyingGlass className={styles.searchIcon} width="0.9rem" height="0.9rem" aria-hidden="true" />
              <input
                type="text"
                className={styles.searchInput}
                placeholder={t.searchPlaceholder}
                aria-label={t.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  type="button"
                  className={styles.clearBtn}
                  aria-label={t.searchClear}
                  onClick={() => setQuery('')}
                >
                  <X width="0.8rem" height="0.8rem" aria-hidden="true" />
                </button>
              )}
            </div>

            <div className={styles.filters} role="group" aria-label={t.title}>
              <button
                type="button"
                className={`${styles.chip}${type === ALL ? ` ${styles.chipActive}` : ''}`}
                aria-label={t.filterAll}
                aria-pressed={type === ALL}
                onClick={() => setType(ALL)}
              >
                {t.filterAll}
              </button>
              {Object.keys(t.entityTypes).map((code) => (
                <button
                  key={code}
                  type="button"
                  className={`${styles.chip}${type === code ? ` ${styles.chipActive}` : ''}`}
                  style={badgeStyle(code)}
                  aria-label={entityLabel(code)}
                  aria-pressed={type === code}
                  onClick={() => setType(code)}
                >
                  {entityLabel(code)}
                </button>
              ))}
            </div>
          </div>

          {phase === 'loading' ? (
            <div className={styles.centered} role="status" aria-busy="true">
              <BaseSpinner tone="current" size={18} />
              <span>{t.loading}</span>
            </div>
          ) : phase === 'error' ? null : entries.length === 0 ? (
            <p className={styles.centered}>{filtering ? t.emptyFiltered : t.empty}</p>
          ) : (
            <ul className={styles.list} onScroll={onListScroll}>
              {entries.map((entry) => {
                const open = openId === entry.id;
                return (
                  <li key={entry.id} className={styles.entry}>
                    <button
                      type="button"
                      className={styles.entryButton}
                      aria-expanded={open}
                      onClick={() => setOpenId(open ? null : entry.id)}
                    >
                      <span className={styles.entryMain}>
                        <span className={styles.badge} style={badgeStyle(entry.entityType)}>
                          {entityLabel(entry.entityType)}
                        </span>
                        <span className={styles.summary}>{entry.summary}</span>
                        <span className={styles.meta}>
                          <span>{entry.actorEmail ?? t.unknownActor}</span>
                          <span className={styles.metaDot}>•</span>
                          <span>{formatWhen(entry.createdAt)}</span>
                          <span className={styles.metaDot}>•</span>
                          <code className={styles.action}>{entry.action}</code>
                        </span>
                      </span>
                      <Chevron
                        className={`${styles.caret}${open ? ` ${styles.caretOpen}` : ''}`}
                        width="0.85rem"
                        height="0.85rem"
                        aria-hidden="true"
                      />
                    </button>
                    {open && (
                      <div className={styles.details}>
                        {entry.details &&
                          entry.details.split('\n').map((part, i) => (
                            <span key={i} className={styles.detailPart}>
                              {part}
                            </span>
                          ))}
                        {entry.entityId !== null && (
                          <span className={styles.detailPart}>
                            {t.entityIdLabel} : #{entry.entityId}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
              {loadingMore && (
                <li className={styles.loadingMore} role="status" aria-busy="true">
                  <BaseSpinner tone="current" size={16} />
                  <span>{t.loadingMore}</span>
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      {phase === 'error' && (
        <ErrorPopup
          content={t.loadError}
          onClose={() => requestClose(onClose)}
          onRetry={reload}
          labels={{
            title: t.errorTitle,
            close: t.errorClose,
            retry: t.errorRetry,
          }}
        />
      )}
    </>
  );
}
