import { formatScore } from './formatScore';

/**
 * Libellés de l'écran récapitulatif. Passés via `labels` (en Partial) ; les champs
 * omis prennent les défauts. Les formatters gèrent les pluriels.
 */
export interface QuizSummaryLabels {
  /** Titre « <quiz> — terminé ! ». */
  completedTitle: (title: string) => string;
  /** Titre tant que la correction du code n'est pas finie (« <quiz> — soumis »). */
  submittedTitle: (title: string) => string;
  /** Score global affiché quand des questions Code sont encore en validation. */
  validating: string;
  /** Sous-titre pendant la validation du code. */
  validatingSub: string;
  /** Score d'une ligne de question Code encore en cours d'évaluation. */
  rowPending: string;
  /** Pourcentage global. */
  percent: (value: number) => string;
  /** Sous-titre : score + nombre de questions parfaites. */
  summarySub: (earned: number, max: number, perfect: number, total: number) => string;
  /** Titre de la liste de détail. */
  detailTitle: string;
  /** Énoncé court de la question (2e ligne). */
  rowText: (title: string) => string;
  /** Score d'une ligne (« earned / max pts »). */
  rowScore: (earned: number, max: number) => string;
  /** Meilleur score (parmi les tentatives). */
  bestScore: (percent: number) => string;
  /** Libellé de la barre des tentatives. */
  attemptsLabel: string;
  /** Puce d'une tentative (« #n · earned/max »). */
  attemptChip: (attemptNo: number, earned: number, max: number) => string;
}

/** Textes par défaut (FR) du récapitulatif. */
export const defaultQuizSummaryLabels: QuizSummaryLabels = {
  completedTitle: (title) => `${title} — terminé !`,
  submittedTitle: (title) => `${title} — soumis`,
  validating: 'Validation en cours…',
  validatingSub: 'Les questions de code sont en cours d’évaluation…',
  rowPending: 'En attente…',
  percent: (value) => `${formatScore(value)} %`,
  summarySub: (earned, max, perfect, total) => {
    const s = perfect > 1 ? 's' : '';
    return `${formatScore(earned)} / ${formatScore(max)} points · ${perfect} question${s} parfaite${s} sur ${total}`;
  },
  detailTitle: 'Détail par question',
  rowText: (title) => title,
  rowScore: (earned, max) => `${formatScore(earned)} / ${formatScore(max)}`,
  bestScore: (percent) => `Meilleur score : ${formatScore(percent)} %`,
  attemptsLabel: 'Tentatives',
  attemptChip: (attemptNo, earned, max) => `#${attemptNo} · ${formatScore(earned)}/${formatScore(max)}`,
};
