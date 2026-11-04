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
  // ── Cas STRUCTURÉS (#116) — questions « appel de fonction » (langages compilés) ──
  /** Bandeau d'info pour les cas structurés. */
  structuredInfoBanner: string;
  /** Label du champ expression (code renvoyant la valeur testée). */
  exprLabel: string;
  /** aria-label de l'éditeur d'expression d'un cas (numéro 1-based). */
  exprAria: (index: number) => string;
  /** Label du champ valeur attendue (JSON). */
  expectedLabel: string;
  /** Placeholder de la valeur attendue (JSON). */
  expectedPlaceholder: string;
  /** Label du champ mode de comparaison. */
  compareLabel: string;
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
  structuredInfoBanner:
    "Attendus cachés à l'étudiant · l'expression renvoie la valeur testée (ex. solution(5), new Rectangle(3,4).aire()) · on la compare à l'attendu hors sandbox · note = part des poids réussis",
  exprLabel: 'Expression (renvoie la valeur testée)',
  exprAria: (index) => `Expression du cas ${index}`,
  expectedLabel: 'Résultat attendu (JSON)',
  expectedPlaceholder: '10',
  compareLabel: 'Comparaison',
};
