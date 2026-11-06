/**
 * Libellés du corps « Harnais de test ». Passés via `labels` (en Partial) ; les
 * champs omis prennent les défauts.
 */
export interface HarnessLabels {
  /** Bandeau d'information en tête. */
  infoBanner: string;
  /** Placeholder du nom de cas. */
  namePlaceholder: string;
  /** Label du champ poids. */
  weightLabel: string;
  /** aria-label du bouton « supprimer le harnais ». */
  deleteAria: string;
  /** aria-label de l'éditeur de code d'un harnais (numéro 1-based). */
  codeAria: (index: number) => string;
  /** Bouton d'ajout d'un harnais. */
  add: string;
  /** Bouton annuler. */
  cancel: string;
  /** Bouton enregistrer. */
  save: string;
}

/** Textes par défaut (FR) de l'éditeur de harnais. */
export const defaultHarnessLabels: HarnessLabels = {
  infoBanner:
    "Cachés à l'étudiant · chaque harnais renvoie vrai/faux · note = part des poids réussis",
  namePlaceholder: 'Nom du cas (ex. Cas nominal)',
  weightLabel: 'Poids',
  deleteAria: 'Supprimer le harnais',
  codeAria: (index) => `Code du harnais ${index}`,
  add: 'Ajouter un harnais',
  cancel: 'Annuler',
  save: 'Enregistrer',
};
