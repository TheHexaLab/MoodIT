import React, { useEffect, useRef, useState } from 'react';
import styles from './McpManagementPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { Sparkles } from '../../assets/Sparkles.tsx';
import { Check } from '../../assets/Check.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { CircleCheck } from '../../assets/CircleCheck.tsx';
import { AlertCircle } from '../../assets/AlertCircle.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { defaultLabels } from './labels.ts';
import type {
  MaybePromise,
  McpManagementPopupLabels,
  McpResponse,
  McpResponseSummary,
} from './types.ts';
import type { McpAnalysis, User } from '../../types/domain.ts';

// Ré-export de l'API publique.
export type {
  IncomingMcpHandlers,
  MaybePromise,
  McpManagementPopupLabels,
  McpResponse,
  McpResponseSummary,
  McpSocket,
} from './types.ts';

interface McpManagementPopupProps {
  /** Id du cours (clé du registre des analyses en cours). */
  courseId: number;
  /** Libellé du cours (ex. « 201-NYC-05 — Algèbre linéaire »). */
  courseLabel: string;
  /** Charge tout l'historique (résumés, tri récent → ancien). */
  loadAnalyses: () => MaybePromise<McpResponseSummary[]>;
  /** Charge le DÉTAIL complet d'une analyse (au clic sur une entrée de l'historique). */
  loadAnalysis: (id: number) => MaybePromise<McpResponse>;
  /**
   * Statut « analyse en cours » pour ce cours et l'utilisateur courant : appelé UNE fois
   * au montage pour réhydrater l'état après un rechargement de page (lien cours ↔ user).
   */
  loadPending: () => MaybePromise<boolean>;
  /**
   * S'abonne à la FIN d'un job d'analyse de ce cours (push WebSocket) : `onCreated` en cas
   * de succès (résumé ajouté à l'historique), `onFailed` en cas d'échec (analyse non créée).
   * Évite le polling : le résultat arrive quand le serveur le pousse. Renvoie le désabonnement.
   */
  subscribeCompletion: (handlers: {
    onCreated: (summary: McpResponseSummary) => void;
    onFailed: (reason?: string) => void;
    onResync: () => void;
  }) => () => void;
  /**
   * Déclenche une analyse (POST asynchrone : 202, sans résultat). Le résultat arrive plus
   * tard par WebSocket via `subscribeCompletion` — pas de retour à traiter ici.
   */
  onAnalyze: () => MaybePromise<void>;
  /** Ferme la modale. */
  onClose: (...args: unknown[]) => unknown;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<McpManagementPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

/** Parse l'analyse structurée sérialisée dans MCP_Response.content (null si invalide). */
function parseAnalysis(content: string): McpAnalysis | null {
  try {
    const parsed = JSON.parse(content) as McpAnalysis;
    if (!Array.isArray(parsed.strengths) || !Array.isArray(parsed.improvements)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })} · ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Nom affichable de l'auteur de l'analyse (prénom nom, sinon username ; '' si absent). */
function authorName(author?: User): string {
  if (!author) return '';
  return `${author.firstName} ${author.lastName}`.trim() || author.username;
}

export function McpManagementPopup({
  courseId,
  courseLabel,
  loadAnalyses,
  loadAnalysis,
  loadPending,
  subscribeCompletion,
  onAnalyze,
  onClose,
  labels,
}: McpManagementPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  // ── Liste (historique, résumés) ─────────────────────────────────────────────
  const [summaries, setSummaries] = useState<McpResponseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // ── Détail (analyse sélectionnée, fetché au clic) ───────────────────────────
  const [selectedSummary, setSelectedSummary] = useState<McpResponseSummary | null>(null);
  const [detailResponse, setDetailResponse] = useState<McpResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [tab, setTab] = useState<'strengths' | 'improvements'>('strengths');

  /** Analyse en cours ? Réhydraté au montage via loadPending (cf. effet de sondage). */
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  /** Animation de transition entre pages (liste ↔ détail) : clé (remonte) + sens. */
  const [anim, setAnim] = useState<{ key: string; dir: 'forward' | 'back' }>({
    key: 'list',
    dir: 'forward',
  });
  /** Hauteur mesurée du contenu (px) ; pilote la transition de taille de la modale. */
  const [height, setHeight] = useState<number | null>(null);

  const mountedRef = useRef(true);
  const requestRef = useRef(0);
  const detailReqRef = useRef(0);
  const pendingAction = useRef<(() => void) | null>(null);
  const loadAnalysesRef = useRef(loadAnalyses);
  const loadPendingRef = useRef(loadPending);
  const subscribeCompletionRef = useRef(subscribeCompletion);
  /** Libellé d'erreur générique, en ref : lu par l'abonnement WS (deps = [courseId]). */
  const analyzeErrorRef = useRef(t.analyzeError);
  /** Conteneur mesuré (hauteur du contenu courant). */
  const measureRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadAnalysesRef.current = loadAnalyses;
    loadPendingRef.current = loadPending;
    subscribeCompletionRef.current = subscribeCompletion;
    analyzeErrorRef.current = t.analyzeError;
  }, [loadAnalyses, loadPending, subscribeCompletion, t.analyzeError]);

  // Chargement de tout l'historique (montage + « réessayer »). Pas de setState synchrone
  // dans le corps de l'effet : `loading` démarre à true et reload() le repositionne.
  useEffect(() => {
    const reqId = ++requestRef.current;
    let cancelled = false;
    Promise.resolve()
      .then(() => loadAnalysesRef.current())
      .then((data) => {
        if (cancelled || !mountedRef.current || requestRef.current !== reqId) return;
        if (!Array.isArray(data)) {
          setLoadError(true);
          return;
        }
        setSummaries(data);
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

  function reload() {
    setLoading(true);
    setLoadError(false);
    setReloadKey((key) => key + 1);
  }

  // Suit la hauteur du contenu (changement de page, d'onglet, chargement…) pour animer
  // la taille de la modale. setHeight n'est appelé que dans le callback (async) du
  // ResizeObserver, jamais dans le corps de l'effet (pas de rendu en cascade).
  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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

  async function analyze() {
    if (analyzing) return;
    setError(null);
    setAnalyzing(true);
    try {
      // POST asynchrone : marque « en cours » côté serveur (visible par loadPending) et
      // répond 202 sans résultat. Le job, une fois fini, POUSSE l'analyse par WebSocket →
      // c'est `subscribeCompletion` qui l'ajoute à l'historique et coupe « en cours ».
      await onAnalyze();
    } catch {
      if (!mountedRef.current) return;
      // Échec du DÉCLENCHEMENT (le job n'a pas démarré) : on rouvre l'action.
      setAnalyzing(false);
      setError(t.analyzeError);
    }
  }

  // Réhydratation de l'état « analyse en cours » : UN seul appel au montage (survit à un
  // refresh ; lien cours ↔ user côté serveur). Plus de polling — la fin du job arrive par
  // WebSocket (cf. abonnement ci-dessous). setState uniquement dans un callback async.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => loadPendingRef.current())
      .then((pending) => {
        if (cancelled || !mountedRef.current) return;
        if (pending === true) setAnalyzing(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  // Abonnement WebSocket : le serveur POUSSE la fin du job. Succès → on ajoute l'analyse à
  // l'historique ; échec → on rouvre l'action et on affiche l'erreur. Dans les deux cas on
  // clôt l'état « en cours » — sans polling, même pour un autre onglet / après un refresh.
  useEffect(() => {
    const unsubscribe = subscribeCompletionRef.current({
      onCreated: (summary) => {
        if (!mountedRef.current) return;
        setSummaries((prev) => (prev.some((s) => s.id === summary.id) ? prev : [summary, ...prev]));
        setAnalyzing(false);
      },
      onFailed: (reason) => {
        if (!mountedRef.current) return;
        setAnalyzing(false);
        // Message clair et explicatif côté UI ; la `reason` technique du serveur (ex.
        // « Service MCP indisponible ») n'est pas affichée telle quelle, juste loggée.
        if (reason) console.warn('Analyse MCP échouée :', reason);
        setError(analyzeErrorRef.current);
      },
      // Reconnexion WS : refetch SILENCIEUX (sans spinner) de la liste + du statut « en
      // cours ». Réconcilie un analysis-created/failed manqué pendant la coupure (le
      // serveur fait foi : remplace la liste, débloque « en cours » si le job est fini).
      onResync: () => {
        void Promise.all([loadAnalysesRef.current(), loadPendingRef.current()])
          .then(([list, pending]) => {
            if (!mountedRef.current) return;
            if (Array.isArray(list)) setSummaries(list);
            setAnalyzing(pending === true);
          })
          .catch(() => {
            /* échec réseau : on garde l'état courant ; le prochain onResync réessaiera */
          });
      },
    });
    return unsubscribe;
  }, [courseId]);

  // Récupère le DÉTAIL d'une analyse à la demande (au clic / au « réessayer » du détail).
  async function fetchDetail(id: number) {
    const reqId = ++detailReqRef.current;
    setDetailLoading(true);
    setDetailError(false);
    setDetailResponse(null);
    try {
      const response = await loadAnalysis(id);
      if (!mountedRef.current || detailReqRef.current !== reqId) return;
      setDetailResponse(response);
    } catch {
      if (!mountedRef.current || detailReqRef.current !== reqId) return;
      setDetailError(true);
    } finally {
      if (mountedRef.current && detailReqRef.current === reqId) setDetailLoading(false);
    }
  }

  function openDetail(summary: McpResponseSummary) {
    setSelectedSummary(summary);
    setTab('strengths');
    void fetchDetail(summary.id);
  }

  // ── Vue détail (analyse sélectionnée) ───────────────────────────────────────
  const detailAnalysis = detailResponse ? parseAnalysis(detailResponse.content) : null;
  const detailItems =
    detailAnalysis ? (tab === 'strengths' ? detailAnalysis.strengths : detailAnalysis.improvements) : [];

  const detailView = selectedSummary ? (
    <>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={t.back}
          onClick={() => setSelectedSummary(null)}
        >
          <Chevron className={styles.backChevron} width="1.125rem" height="1.125rem" />
        </button>
        <div className={styles.headerText}>
          <h1>{t.detailTitle(formatDateTime(selectedSummary.createdAt))}</h1>
          <p>{courseLabel}</p>
        </div>
        <button type="button" className={styles.close} onClick={() => requestClose(onClose)}>
          ✕
        </button>
      </header>

      <div className={styles.body}>
        {detailLoading ? (
          <div className={styles.stateMsg} role="status" aria-live="polite">
            <Spinner />
            <p>{t.loadingDetail}</p>
          </div>
        ) : detailError || !detailAnalysis ? (
          <div className={styles.stateMsg} role="alert">
            <p>{t.detailLoadError}</p>
            <button
              type="button"
              className={styles.retry}
              onClick={() => void fetchDetail(selectedSummary.id)}
            >
              {t.retry}
            </button>
          </div>
        ) : (
          <>
            <section className={styles.scoreHero}>
              <span className={styles.scoreBadge} aria-hidden="true">
                <Check width="1.875rem" height="1.875rem" />
              </span>
              <span className={styles.scoreTitle}>{t.scoreTitle}</span>
              <span className={styles.score}>{detailAnalysis.score} %</span>
              <span className={styles.scoreMeta}>
                {t.detailMeta(
                  detailAnalysis.strengths.length,
                  detailAnalysis.improvements.length,
                  detailAnalysis.sources.quizCount,
                  detailAnalysis.sources.forumMessageCount,
                )}
              </span>
            </section>

            <div className={styles.tabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'strengths'}
                className={`${styles.tab}${tab === 'strengths' ? ` ${styles.tabActive}` : ''}`}
                onClick={() => setTab('strengths')}
              >
                {t.tabStrengths}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'improvements'}
                className={`${styles.tab} ${styles.tabImprove}${tab === 'improvements' ? ` ${styles.tabActive}` : ''}`}
                onClick={() => setTab('improvements')}
              >
                {t.tabImprovements}
              </button>
            </div>

            <span className={styles.divider} />

            <ul className={styles.points}>
              {detailItems.map((item, index) => (
                <li key={index} className={styles.point}>
                  {tab === 'strengths' ? (
                    <CircleCheck className={styles.pointIconStrength} width="1rem" height="1rem" aria-hidden="true" />
                  ) : (
                    <AlertCircle className={styles.pointIconImprove} width="1rem" height="1rem" aria-hidden="true" />
                  )}
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <p className={styles.footnote}>
              <span>
                {t.generatedNote(
                  formatDate(selectedSummary.createdAt),
                  authorName(detailResponse?.author),
                )}
              </span>
              <span>
                {t.scopeNote(
                  detailAnalysis.sources.quizCount,
                  detailAnalysis.sources.forumMessageCount,
                  detailAnalysis.sources.studentCount,
                )}
              </span>
            </p>
          </>
        )}
      </div>
    </>
  ) : null;

  // ── Vue liste (historique + action) ─────────────────────────────────────────
  const listView = (
    <>
      <header className={styles.header}>
        <span className={styles.headerIcon} aria-hidden="true">
          <Sparkles width="1.5rem" height="1.5rem" />
        </span>
        <div className={styles.headerText}>
          <h1>{t.title}</h1>
          <p>{t.subtitle(courseLabel)}</p>
        </div>
        <button type="button" className={styles.close} onClick={() => requestClose(onClose)}>
          ✕
        </button>
      </header>

      <div className={styles.body}>
        <section className={styles.analyzeBanner}>
          <div className={styles.analyzeText}>
            <h2>{t.analyzeTitle}</h2>
            <p>{t.analyzeDescription}</p>
          </div>
          <button type="button" className={styles.analyzeBtn} onClick={analyze} disabled={analyzing}>
            {analyzing ? (
              <Spinner />
            ) : (
              <>
                <Sparkles width="1rem" height="1rem" aria-hidden="true" />
                {t.analyzeButton}
              </>
            )}
          </button>
        </section>

        <span className={styles.historyLabel}>{t.historyLabel}</span>

        {loading ? (
          <div className={styles.stateMsg} role="status" aria-live="polite">
            <Spinner />
            <p>{t.loadingHistory}</p>
          </div>
        ) : loadError ? (
          <div className={styles.stateMsg} role="alert">
            <p>{t.loadError}</p>
            <button type="button" className={styles.retry} onClick={reload}>
              {t.retry}
            </button>
          </div>
        ) : summaries.length === 0 ? (
          <div className={styles.stateMsg}>{t.noAnalyses}</div>
        ) : (
          <ul className={styles.history}>
            {summaries.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  className={styles.historyRow}
                  onClick={() => openDetail(summary)}
                >
                  <span className={styles.historyInfo}>
                    <span className={styles.historyDate}>{formatDateTime(summary.createdAt)}</span>
                    <span className={styles.historySummary}>
                      {t.rowSummary(summary.strengthsCount, summary.improvementsCount)}
                    </span>
                  </span>
                  <Chevron className={styles.historyChevron} width="1rem" height="1rem" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );

  // Sens de l'animation, ajusté pendant le rendu quand on change de page (motif React
  // « adjusting state during render ») : avance vers le détail, recule vers la liste.
  const viewKey = selectedSummary ? 'detail' : 'list';
  if (anim.key !== viewKey) {
    setAnim({ key: viewKey, dir: viewKey === 'detail' ? 'forward' : 'back' });
  }

  return (
    <>
      <div
        className={`${styles.scrim}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div className={styles.dialog} onAnimationEnd={handleAnimationEnd}>
          {/* Viewport à hauteur animée ; le contenu (clé = page) glisse à chaque changement. */}
          <div className={styles.viewport} style={height != null ? { height } : undefined}>
            <div ref={measureRef}>
              <div key={anim.key} data-dir={anim.dir} className={styles.view}>
                {detailView ?? listView}
              </div>
            </div>
          </div>
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
