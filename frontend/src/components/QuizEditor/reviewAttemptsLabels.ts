/**
 * Libellés du corps « Tentatives à revoir » d'un quiz (#116) : tentatives dont la correction
 * automatique a échoué sans verdict trop souvent, et qui attendent l'enseignant.
 * Passés via `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface ReviewAttemptsLabels {
  /** Explication en tête de liste. */
  intro: string;
  /** État de chargement. */
  loading: string;
  /** Liste vide. */
  empty: string;
  /** Ligne : « Tentative N ». */
  attemptLabel: (attemptNo: number) => string;
  /** Sous-ligne : date de soumission et nombre d'échecs sans verdict. */
  attemptSub: (submittedAt: string | null, failures: number) => string;
  /** Bouton de relance. */
  regrade: string;
  /** aria-label du bouton de relance. */
  regradeAria: (studentName: string, attemptNo: number) => string;
  /** Bouton « Réessayer » (échec du chargement). */
  retry: string;
}

/** Date courte (fr-CA) d'une soumission, ou null. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Textes par défaut (FR). */
export const defaultReviewAttemptsLabels: ReviewAttemptsLabels = {
  intro:
    "La correction automatique de ces tentatives n'a pas abouti malgré plusieurs essais : le code de l'étudiant faisait peut-être tomber le conteneur de correction. Relancez-la ; si elle échoue encore, la tentative revient ici.",
  loading: 'Chargement des tentatives…',
  empty: 'Aucune tentative à revoir.',
  attemptLabel: (attemptNo) => `Tentative ${attemptNo}`,
  attemptSub: (submittedAt, failures) => {
    const date = formatDate(submittedAt);
    const count = `${failures} échec${failures > 1 ? 's' : ''} sans verdict`;
    return date ? `Soumise le ${date} · ${count}` : count;
  },
  regrade: 'Relancer la correction',
  regradeAria: (studentName, attemptNo) =>
    `Relancer la correction de la tentative ${attemptNo} de ${studentName}`,
  retry: 'Réessayer',
};
