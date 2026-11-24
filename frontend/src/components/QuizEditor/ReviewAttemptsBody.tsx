import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './QuizEditor.module.css';
import { Spinner } from '../Spinner/Spinner';
import { type MaybePromise, type ReviewAttempt } from './editorTypes';
import { defaultReviewAttemptsLabels, type ReviewAttemptsLabels } from './reviewAttemptsLabels';

interface ReviewAttemptsBodyProps {
  quizId: number;
  /** Charge les tentatives à revoir du quiz. */
  onFetch: (quizId: number) => MaybePromise<ReviewAttempt[]>;
  /** Relance la correction d'une tentative ; rejette en cas d'échec. */
  onRegrade: (quizId: number, attemptId: number) => MaybePromise<unknown>;
  /** Une relance est partie : le parent met à jour le compteur du quiz. */
  onRegraded: (attemptId: number) => void;
  /** Liste chargée : le parent recale le compteur du quiz sur sa longueur. */
  onLoaded?: (count: number) => void;
  /** Échec du chargement ou d'une relance : message affiché par le parent (ErrorPopup). */
  onError: (message: 'load' | 'regrade') => void;
  labels?: Partial<ReviewAttemptsLabels>;
}

/**
 * Corps « Tentatives à revoir » d'un quiz (#116) : liste des tentatives dont la correction a
 * échoué sans verdict au-delà du plafond, avec un bouton « Relancer la correction » par
 * tentative. Une relance réussie retire la ligne (la tentative repart en correction ; si elle
 * échoue encore, elle reviendra). Rendu dans la coquille commune par `QuizEditor`.
 */
export function ReviewAttemptsBody({
  quizId,
  onFetch,
  onRegrade,
  onRegraded,
  onLoaded,
  onError,
  labels,
}: ReviewAttemptsBodyProps): React.ReactElement {
  const t = { ...defaultReviewAttemptsLabels, ...labels };
  const [attempts, setAttempts] = useState<ReviewAttempt[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [regrading, setRegrading] = useState<number | null>(null);
  // Focus à poser après le retrait d'une ligne relancée : le bouton de la ligne voisine, sinon
  // l'introduction. Sans lui, le focus tombait sur <body>, hors de la fenêtre modale.
  // Lu par ref (pas un état) : posé avec le retrait de la ligne, consommé au rendu qui suit.
  const focusAfterRef = useRef<number | 'intro' | null>(null);
  const buttonRefs = useRef(new Map<number, HTMLButtonElement>());
  const introRef = useRef<HTMLParagraphElement>(null);
  // Effet de MISE EN PAGE : focus posé dans la mise à jour qui retire la ligne (cf. AttemptBar).
  useLayoutEffect(() => {
    const focusAfter = focusAfterRef.current;
    if (focusAfter == null) return;
    focusAfterRef.current = null;
    const target = focusAfter === 'intro' ? introRef.current : buttonRefs.current.get(focusAfter);
    target?.focus();
  }, [attempts]);
  // Rappels du parent lus par ref : définis en ligne, ils changent à chaque rendu du parent, et le
  // chargement ne doit dépendre que du quiz.
  const fetchRef = useRef(onFetch);
  const errorRef = useRef(onError);
  const loadedRef = useRef(onLoaded);
  useEffect(() => {
    fetchRef.current = onFetch;
    errorRef.current = onError;
    loadedRef.current = onLoaded;
  });

  // Chargement : l'état n'est écrit qu'APRÈS la réponse (jamais de façon synchrone dans l'effet).
  // `attempt` change à chaque « Réessayer » et relance l'effet.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchRef.current(quizId);
        if (cancelled) return;
        setAttempts(list);
        loadedRef.current?.(list.length);
      } catch {
        if (cancelled) return;
        setFailed(true);
        errorRef.current('load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [quizId, attempt]);

  const reload = () => {
    setFailed(false);
    setAttempts(null);
    setAttempt((n) => n + 1);
  };

  const regrade = async (attempt: ReviewAttempt) => {
    // Une relance à la fois : les boutons restent focalisables (aria-disabled), d'où ce garde.
    if (regrading != null) return;
    setRegrading(attempt.attemptId);
    try {
      await onRegrade(quizId, attempt.attemptId);
      const list = attempts ?? [];
      const index = list.findIndex((a) => a.attemptId === attempt.attemptId);
      const neighbour = list[index + 1] ?? list[index - 1];
      focusAfterRef.current =
        neighbour && neighbour.attemptId !== attempt.attemptId ? neighbour.attemptId : 'intro';
      setAttempts(list.filter((a) => a.attemptId !== attempt.attemptId));
      onRegraded(attempt.attemptId);
    } catch {
      // Focus sur l'introduction AVANT le message d'erreur : la fenêtre d'erreur mémorise
      // l'élément focalisé à son ouverture pour le lui rendre, et le bouton cliqué disparaît
      // avec le rechargement ci-dessous — le focus serait tombé sur <body>, hors de la fenêtre.
      introRef.current?.focus();
      onError('regrade');
      // Refus (409 : déjà relancée par un autre enseignant, ou plus à revoir) : la liste et la
      // pastille se recalent sur le serveur, au lieu de garder une ligne qui renverrait 409.
      reload();
    } finally {
      setRegrading(null);
    }
  };

  return (
    <div className={styles.field}>
      <p className={styles.fieldHint} ref={introRef} tabIndex={-1}>
        {t.intro}
      </p>
      <div className={styles.list}>
        {attempts == null && !failed && (
          <div className={styles.listLoading} role="status" aria-live="polite" aria-busy="true">
            <Spinner size={26} />
            <span>{t.loading}</span>
          </div>
        )}
        {failed && (
          <button type="button" className={styles.addButton} onClick={reload}>
            {t.retry}
          </button>
        )}
        {attempts?.length === 0 && <p className={styles.listEmpty}>{t.empty}</p>}
        {attempts?.map((attempt) => (
          <div key={attempt.attemptId} className={[styles.listRow, styles.listRowStatic].join(' ')}>
            <div className={styles.rowBody}>
              <div className={styles.rowTitleLine}>
                <span className={styles.rowTitle}>{attempt.studentName}</span>
                <span className={[styles.badge, styles.badgeDraft].join(' ')}>
                  {t.attemptLabel(attempt.attemptNo)}
                </span>
              </div>
              <span className={styles.rowSub}>
                {t.attemptSub(attempt.submittedAt ?? null, attempt.noVerdictFailures)}
              </span>
            </div>
            <button
              type="button"
              className={styles.addLinkButton}
              aria-label={t.regradeAria(attempt.studentName, attempt.attemptNo)}
              aria-busy={regrading === attempt.attemptId}
              // aria-disabled et non disabled : un bouton désactivé perd le focus, qui sortait
              // alors de la fenêtre modale.
              aria-disabled={regrading != null}
              ref={(el) => {
                if (el) buttonRefs.current.set(attempt.attemptId, el);
                else buttonRefs.current.delete(attempt.attemptId);
              }}
              onClick={() => void regrade(attempt)}
            >
              {regrading === attempt.attemptId ? <Spinner size={15} /> : t.regrade}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
