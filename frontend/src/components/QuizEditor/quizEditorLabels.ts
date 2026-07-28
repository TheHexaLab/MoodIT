import type { QuizListLabels } from './quizListLabels';
import type { QuizFormLabels } from './quizFormLabels';
import type { QuestionFormLabels } from './questionFormLabels';
import type { HarnessLabels } from './harnessLabels';
import type { QuestionTestLabels } from './questionTestLabels';

/**
 * Libellés de l'ORCHESTRATEUR de l'éditeur de quiz (coquille `EditorShell` : titres /
 * sous-titres des vues, messages d'erreur, confirmations de suppression).
 */
export interface QuizEditorLabels {
  // ── Titres / sous-titres des vues (coquille) ──
  listTitle: string;
  listSubtitle: string;
  newQuizTitle: string;
  editQuizTitle: string;
  newQuestionTitle: string;
  editQuestionTitle: string;
  harnessTitle: string;
  testTitle: string;
  /** Sous-titre « Question N » d'une vue question/harnais/tester. */
  questionSubtitle: (index: number) => string;

  // ── Messages d'erreur (toasts dans le formulaire) ──
  loadError: string;
  saveError: string;
  deleteError: string;
  reorderError: string;

  // ── Confirmations de suppression ──
  deleteQuizTitle: string;
  deleteQuizBody: string;
  deleteQuestionTitle: string;
  deleteQuestionBody: string;
}

/** Textes par défaut (FR) de l'orchestrateur. */
export const defaultQuizEditorLabels: QuizEditorLabels = {
  listTitle: 'Modifier les quiz',
  listSubtitle: 'Glisse pour réorganiser · crée ou modifie les quiz',
  newQuizTitle: 'Nouveau quiz',
  editQuizTitle: 'Modifier le quiz',
  newQuestionTitle: 'Nouvelle question',
  editQuestionTitle: 'Modifier la question',
  harnessTitle: 'Harnais de test',
  testTitle: 'Tester la question',
  questionSubtitle: (index) => `Question ${index}`.trim(),

  loadError: 'Chargement du quiz impossible.',
  saveError: "L'enregistrement a échoué. Réessayez.",
  deleteError: 'La suppression a échoué.',
  reorderError: "Le réordonnancement a échoué. Vous n'avez peut-être pas les droits.",

  deleteQuizTitle: 'Supprimer le quiz ?',
  deleteQuizBody:
    'Le quiz et toutes ses questions, réponses et soumissions seront définitivement supprimés. Cette action est irréversible.',
  deleteQuestionTitle: 'Supprimer la question ?',
  deleteQuestionBody:
    'La question et ses réponses seront définitivement supprimées. Cette action est irréversible.',
};

/**
 * Ensemble de libellés exposé par `QuizEditor` : la coquille (`shell`) + une surcharge
 * partielle par sous-popup. Chaque section est optionnelle (défauts sinon).
 */
export interface QuizEditorLabelsBundle {
  shell?: Partial<QuizEditorLabels>;
  list?: Partial<QuizListLabels>;
  form?: Partial<QuizFormLabels>;
  question?: Partial<QuestionFormLabels>;
  harness?: Partial<HarnessLabels>;
  test?: Partial<QuestionTestLabels>;
}
