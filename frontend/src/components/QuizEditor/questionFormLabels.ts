/**
 * Libellés du corps « éditeur de question » (tous types). Passés via `labels`
 * (en Partial) ; les champs omis prennent les défauts.
 */
export interface QuestionFormLabels {
  // ── Commun ──
  promptLabel: string;
  promptPlaceholder: string;
  typeLabel: string;
  pointsLabel: string;
  cancel: string;
  /** Bouton d'enregistrement en création. */
  add: string;
  /** Bouton d'enregistrement en édition. */
  save: string;
  /** Bouton « Tester » (libellé + title). */
  test: string;
  testTitle: string;

  // ── Choix (unique / multiple / vrai-faux) ──
  answersSection: string;
  markCorrectAria: string;
  answerPlaceholder: string;
  deleteAnswerAria: string;
  addAnswer: string;

  // ── Remise en ordre ──
  orderingSection: string;
  deleteItemAria: string;
  addItem: string;

  // ── Association ──
  matchingSection: string;
  categoryPlaceholder: string;
  deleteAssociationAria: string;
  associationOptionsAria: string;
  addAssociation: string;
  /** Placeholder de l'élément (remise en ordre ET association). */
  elementPlaceholder: string;

  // ── Code ──
  languageLabel: string;
  startCodeLabel: string;
  startCodePlaceholder: string;
  startCodeAria: string;
  harnessTitle: string;
  harnessCount: (count: number) => string;
  manageHarness: string;
}

/** Textes par défaut (FR) de l'éditeur de question. */
export const defaultQuestionFormLabels: QuestionFormLabels = {
  promptLabel: 'Énoncé',
  promptPlaceholder: "Écris l'énoncé de la question…",
  typeLabel: 'Type de question',
  pointsLabel: 'Points',
  cancel: 'Annuler',
  add: 'Ajouter',
  save: 'Enregistrer',
  test: 'Tester',
  testTitle: 'Prévisualiser / tester',

  answersSection: 'Réponses',
  markCorrectAria: 'Marquer comme correcte',
  answerPlaceholder: 'Réponse…',
  deleteAnswerAria: 'Supprimer la réponse',
  addAnswer: 'Ajouter une réponse',

  orderingSection: 'Éléments à ordonner',
  deleteItemAria: "Supprimer l'élément",
  addItem: 'Ajouter un élément',

  matchingSection: 'Associations',
  categoryPlaceholder: 'Catégorie',
  deleteAssociationAria: "Supprimer l'association",
  associationOptionsAria: "Options de l'association",
  addAssociation: 'Ajouter une association',
  elementPlaceholder: 'Élément…',

  languageLabel: 'Langage',
  startCodeLabel: 'Code de départ',
  startCodePlaceholder: 'def fonction():\n    # à compléter\n    pass',
  startCodeAria: 'Code de départ',
  harnessTitle: 'Harnais de test',
  harnessCount: (count) => `${count} harnais`,
  manageHarness: 'Gérer',
};
