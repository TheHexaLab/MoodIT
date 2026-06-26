/**
 * Libellés de l'écran récapitulatif. Passés via `labels` (en Partial) ; les champs
 * omis prennent les défauts. Les formatters gèrent les pluriels.
 */
export interface QuizSummaryLabels {
  /** Titre « <quiz> — terminé ! ». */
  completedTitle: (title: string) => string;
  /** Pourcentage global. */
  percent: (value: number) => string;
  /** Sous-titre : score + nombre de questions parfaites. */
  summarySub: (earned: number, max: number, perfect: number, total: number) => string;
  /** Titre de la liste de détail. */
  detailTitle: string;
  /** Libellé d'une ligne : « Q<n> · <titre> ». */
  rowText: (index: number, title: string) => string;
  /** Score d'une ligne (« earned / max pts »). */
  rowScore: (earned: number, max: number) => string;
}

/** Textes par défaut (FR) du récapitulatif. */
export const defaultQuizSummaryLabels: QuizSummaryLabels = {
  completedTitle: (title) => `${title} — terminé !`,
  percent: (value) => `${value} %`,
  summarySub: (earned, max, perfect, total) => {
    const s = perfect > 1 ? 's' : '';
    return `${earned} / ${max} points · ${perfect} question${s} parfaite${s} sur ${total}`;
  },
  detailTitle: 'Détail par question',
  rowText: (index, title) => `Q${index} · ${title}`,
  rowScore: (earned, max) => `${earned} / ${max} pts`,
};
