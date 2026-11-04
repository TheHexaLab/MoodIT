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
  /** Placeholder du symbole appelé (entry). */
  entryPlaceholder: string;
  /** Label du champ arguments (JSON). */
  argsLabel: string;
  /** Placeholder des arguments (JSON). */
  argsPlaceholder: string;
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
    "Cachés à l'étudiant · on appelle la fonction avec les arguments et on compare la sortie à l'attendu · note = part des poids réussis",
  entryPlaceholder: 'Fonction appelée (ex. solution, Solution.solution)',
  argsLabel: 'Arguments (JSON)',
  argsPlaceholder: '[5]',
  expectedLabel: 'Résultat attendu (JSON)',
  expectedPlaceholder: '10',
  compareLabel: 'Comparaison',
};
