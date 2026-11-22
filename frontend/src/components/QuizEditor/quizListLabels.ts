/**
 * Libellés du corps « Modifier les quiz » (liste des quiz d'un cours).
 * Passés via `labels` (en Partial) ; les champs omis prennent les défauts.
 */
export interface QuizListLabels {
  /** État de chargement initial de la liste. */
  loading: string;
  /** Liste vide (chargement terminé). */
  empty: string;
  /** Badge statut « publié ». */
  published: string;
  /** Badge statut « brouillon ». */
  draft: string;
  /** Sous-ligne du nombre de questions. */
  questionsCount: (count: number) => string;
  /** aria-label du bouton « modifier » d'un quiz. */
  editAria: (title: string) => string;
  /** aria-label du bouton « supprimer » d'un quiz. */
  deleteAria: (title: string) => string;
  /** Bouton de création. */
  create: string;
  /** Pastille des tentatives « à revoir » d'un quiz (#116). */
  reviewBadge: (count: number) => string;
  /** aria-label de cette pastille (ouvre la liste des tentatives à revoir). */
  reviewAria: (title: string, count: number) => string;
}

/** Textes par défaut (FR) du corps liste. */
export const defaultQuizListLabels: QuizListLabels = {
  loading: 'Chargement des quiz…',
  empty: "Aucun quiz pour l'instant.",
  published: 'Publié',
  draft: 'Brouillon',
  questionsCount: (count) => `${count} questions`,
  editAria: (title) => `Modifier ${title}`,
  deleteAria: (title) => `Supprimer ${title}`,
  create: 'Créer un quiz',
  reviewBadge: (count) => `${count} à revoir`,
  reviewAria: (title, count) =>
    `${count} tentative${count > 1 ? 's' : ''} à revoir pour ${title}`,
};
