/**
 * Contrats de l'ÉDITEUR de quiz (côté enseignant), pensés API-ready : les drafts
 * édités par les formulaires et les handlers CRUD sont isolés ici. Tous les
 * handlers sont optionnels et peuvent être asynchrones (POST/PUT/DELETE) ; sans
 * eux, l'éditeur fonctionne en mémoire (mode mock).
 */

import {
  type Answer,
  type DragItem,
  type Language,
  type Question,
  type QuestionType,
  type Quiz,
  type TestCase,
} from '../../types/domain';

/** Valeur synchrone ou asynchrone. */
export type MaybePromise<T> = T | Promise<T>;

/** Méta d'un quiz, telles qu'éditées dans le formulaire « Modifier le quiz ». */
export interface QuizMetaDraft {
  title: string;
  isPublished: boolean;
  isDaily: boolean;
}

/** Brouillon d'une option de réponse (Answer sans id pour les nouvelles). */
export type AnswerDraft = Omit<Answer, 'id'> & { id?: number };

/** Brouillon d'un élément glissable (Drag_Item). */
export type DragItemDraft = Omit<DragItem, 'id'> & { id?: number };

/** Brouillon d'un harnais de test (Test_Case). */
export type TestCaseDraft = Omit<TestCase, 'id'> & { id?: number };

/**
 * Brouillon d'une question. `id` absent = création. Les champs de support sont
 * remplis selon `qType` (voir [[quiz-subsystem]] pour le mapping type → tables).
 */
export interface QuestionDraft {
  id?: number;
  qType: QuestionType;
  prompt: string;
  totalScore: number;
  answers?: AnswerDraft[];
  dragItems?: DragItemDraft[];
  languageId?: number;
  startCode?: string;
  testCases?: TestCaseDraft[];
}

/**
 * Handlers CRUD de l'éditeur (API-ready). Chacun reçoit ce qu'il faut pour
 * persister et peut renvoyer l'entité fraîchement persistée (id réel serveur).
 */
export interface QuizEditorHandlers {
  /** Crée un quiz dans le cours ; renvoie le quiz créé (id serveur). */
  onCreateQuiz?: (courseId: number, meta: QuizMetaDraft) => MaybePromise<Quiz>;
  /** Met à jour les méta d'un quiz. */
  onUpdateQuiz?: (quizId: number, meta: QuizMetaDraft) => MaybePromise<Quiz | void>;
  /** Supprime un quiz (et son contenu, en cascade). */
  onDeleteQuiz?: (quizId: number) => MaybePromise<unknown>;
  /** Réordonne les quiz d'un cours (ids dans le nouvel ordre). */
  onReorderQuizzes?: (courseId: number, quizIds: number[]) => MaybePromise<unknown>;
  /** Charge le détail d'un quiz (questions embarquées) pour l'édition. */
  onFetchQuiz?: (quizId: number) => MaybePromise<Quiz>;
  /** Crée ou met à jour une question (selon `draft.id`) ; renvoie la question persistée. */
  onSaveQuestion?: (quizId: number, draft: QuestionDraft) => MaybePromise<Question>;
  /** Supprime une question. */
  onDeleteQuestion?: (questionId: number) => MaybePromise<unknown>;
  /** Réordonne les questions d'un quiz. */
  onReorderQuestions?: (quizId: number, questionIds: number[]) => MaybePromise<unknown>;
}

/** Langages disponibles pour les questions Code (fournis par le parent ; sinon défaut). */
export const DEFAULT_LANGUAGES: Language[] = [
  { id: 1, name: 'Python' },
  { id: 2, name: 'JavaScript' },
  { id: 3, name: 'SQL' },
  { id: 4, name: 'Java' },
  { id: 5, name: 'C' },
];

/** Construit le brouillon initial d'une question d'un type donné (valeurs par défaut). */
export function emptyQuestionDraft(qType: QuestionType): QuestionDraft {
  const base = { prompt: '', totalScore: 10 } as const;
  switch (qType) {
    case 'true_false':
      return {
        ...base,
        qType,
        answers: [
          { content: 'Vrai', isCorrect: true },
          { content: 'Faux', isCorrect: false },
        ],
      };
    case 'single_choice':
    case 'multiple_choice':
      return {
        ...base,
        qType,
        answers: [
          { content: '', isCorrect: true },
          { content: '', isCorrect: false },
        ],
      };
    case 'ordering':
      return {
        ...base,
        qType,
        dragItems: [
          { content: '', correctOrder: 0 },
          { content: '', correctOrder: 1 },
        ],
      };
    case 'matching':
      return {
        ...base,
        qType,
        dragItems: [
          { content: '', correctOrder: 0, groupName: '' },
          { content: '', correctOrder: 0, groupName: '' },
        ],
      };
    case 'coding':
      return { ...base, qType, languageId: 1, startCode: '', testCases: [] };
  }
}

/** Convertit une Question persistée en brouillon éditable. */
export function questionToDraft(q: Question): QuestionDraft {
  return {
    id: q.id,
    qType: q.qType,
    prompt: q.prompt,
    totalScore: q.totalScore,
    answers: q.answers?.map((a) => ({ ...a })),
    dragItems: q.dragItems?.map((d) => ({ ...d })),
    languageId: q.language?.id,
    startCode: q.startCode,
    testCases: q.testCases?.map((t) => ({ ...t })),
  };
}
