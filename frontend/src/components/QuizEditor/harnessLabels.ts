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
  /** aria-label de l'éditeur de valeur attendue d'un cas (numéro 1-based). */
  expectedAria: (index: number) => string;
  /** Placeholder de la valeur attendue (JSON). */
  expectedPlaceholder: string;
  /** Placeholder de la borne pour les modes texte (sous-chaîne / motif regex, saisie brute). */
  patternPlaceholder: string;
  /** Label du champ mode de comparaison. */
  compareLabel: string;
  /** Label de la section conditions (une ou plusieurs). */
  conditionsLabel: string;
  /** Libellés (FR) des modes de comparaison, pour la liste déroulante. */
  compareOptions: Record<CompareMode, string>;
  /** Symboles courts par mode, pour le résumé lisible (ex. « ≥ 60 ET < 100 »). */
  compareSymbols: Record<CompareMode, string>;
  /** Bouton d'ajout d'une condition (cas composé). */
  addCondition: string;
  /** aria-label du bouton « supprimer la condition » (numéro 1-based). */
  deleteConditionAria: (index: number) => string;
  /** Libellés des connecteurs logiques entre conditions. */
  connectorOptions: Record<'and' | 'or', string>;
  /** aria-label du sélecteur de connecteur (entre la condition n et n+1). */
  connectorAria: (index: number) => string;
  /** Préfixe du résumé lisible de la combinaison (ex. « Réussi si : … »). */
  summaryPrefix: string;
}

/** Modes de comparaison d'une condition (le composé `compound` n'en est pas un, il les combine). */
export type CompareMode =
  | 'exact'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'ne'
  | 'contains'
  | 'regex'
  | 'unordered';

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
  exprLabel: 'Expression',
  exprAria: (index) => `Expression du cas ${index}`,
  expectedLabel: 'Attendu',
  expectedAria: (index) => `Résultat attendu du cas ${index}`,
  expectedPlaceholder: 'ex. 10, -6, true, "texte", [1, 2, 3]',
  patternPlaceholder: 'texte brut — ex. erreur, ^WARN, \\d+',
  compareLabel: 'Comparaison',
  conditionsLabel: 'Conditions',
  compareOptions: {
    exact: 'Exacte',
    gt: 'Plus grand que (>)',
    ge: 'Plus grand ou égal (≥)',
    lt: 'Plus petit que (<)',
    le: 'Plus petit ou égal (≤)',
    ne: 'Différent (≠)',
    contains: 'Contient (texte)',
    regex: 'Expression régulière',
    unordered: 'Liste sans ordre',
  },
  compareSymbols: {
    exact: '=',
    gt: '>',
    ge: '≥',
    lt: '<',
    le: '≤',
    ne: '≠',
    contains: 'contient',
    regex: '=~',
    unordered: '≡',
  },
  addCondition: 'Ajouter une condition',
  deleteConditionAria: (index) => `Supprimer la condition ${index}`,
  connectorOptions: { and: 'ET', or: 'OU' },
  connectorAria: (index) => `Connecteur après la condition ${index}`,
  summaryPrefix: 'Réussi si :',
};
