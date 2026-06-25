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
  /**
   * Persiste un quiz CRÉÉ — méta ET questions — en un seul appel : les questions
   * sont éditées en mémoire et n'atteignent le backend qu'à l'« Enregistrer » du
   * formulaire. Renvoie le quiz persisté (ids serveur, questions comprises).
   */
  onCreateQuiz?: (courseId: number, quiz: Quiz) => MaybePromise<Quiz>;
  /**
   * Persiste les modifications d'un quiz — méta ET questions — en un seul appel
   * (même logique que `onCreateQuiz`). Renvoie le quiz persisté (ids réconciliés)
   * ou rien.
   */
  onUpdateQuiz?: (quizId: number, quiz: Quiz) => MaybePromise<Quiz | void>;
  /** Supprime un quiz (et son contenu, en cascade). */
  onDeleteQuiz?: (quizId: number) => MaybePromise<unknown>;
  /** Réordonne les quiz d'un cours (ids dans le nouvel ordre). */
  onReorderQuizzes?: (courseId: number, quizIds: number[]) => MaybePromise<unknown>;
  /** Charge le détail d'un quiz (questions embarquées) pour l'édition. */
  onFetchQuiz?: (quizId: number) => MaybePromise<Quiz>;
}

/** Langages disponibles pour les questions Code (fournis par le parent ; sinon défaut). */
export const DEFAULT_LANGUAGES: Language[] = [
  { id: 1, name: 'Python' },
  { id: 2, name: 'JavaScript' },
  { id: 3, name: 'SQL' },
  { id: 4, name: 'Java' },
  { id: 5, name: 'C' },
  { id: 6, name: 'C++' },
  { id: 7, name: 'C#' },
  { id: 8, name: 'HTML' },
  { id: 9, name: 'JSON' },
  { id: 10, name: 'Ruby' },
  { id: 11, name: 'Rust' },
  { id: 12, name: 'TypeScript' },
  { id: 13, name: 'Bash' },
  { id: 14, name: 'YAML' },
];

/** Squelette de code de départ proposé par langage (par nom, insensible à la casse). */
const START_CODE_BY_LANGUAGE: Record<string, string> = {
  python: 'def solution():\n    # à compléter\n    pass\n',
  javascript: 'function solution() {\n  // à compléter\n}\n',
  sql: '-- Écris ta requête ici\n',
  java: 'public class Solution {\n    public static void main(String[] args) {\n        // à compléter\n    }\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    // à compléter\n    return 0;\n}\n',
  'c++': '#include <iostream>\n\nint main() {\n    // à compléter\n    return 0;\n}\n',
  'c#': 'using System;\n\nclass Solution\n{\n    static void Main()\n    {\n        // à compléter\n    }\n}\n',
  html: '<!DOCTYPE html>\n<html lang="fr">\n  <head>\n    <meta charset="utf-8" />\n    <title></title>\n  </head>\n  <body>\n    <!-- à compléter -->\n  </body>\n</html>\n',
  json: '{\n  \n}\n',
  ruby: 'def solution\n  # à compléter\nend\n',
  rust: 'fn solution() {\n    // à compléter\n}\n',
  typescript: 'function solution(): void {\n  // à compléter\n}\n',
  bash: '#!/usr/bin/env bash\n# à compléter\n',
  yaml: '# à compléter\n',
};

/**
 * Code de départ par défaut d'un langage. Privilégie le gabarit fourni par le backend
 * (`Language.start_code_template`) ; à défaut, replie sur un squelette local par nom
 * (mode mock / langages sans gabarit). Chaîne vide si langage inconnu/absent.
 */
export function defaultStartCode(language?: Language): string {
  if (!language) return '';
  return language.startCodeTemplate ?? START_CODE_BY_LANGUAGE[language.name.toLowerCase()] ?? '';
}

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
      return {
        ...base,
        qType,
        languageId: DEFAULT_LANGUAGES[0].id,
        startCode: defaultStartCode(DEFAULT_LANGUAGES[0]),
        testCases: [],
      };
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

/**
 * Convertit un brouillon en Question persistée (forme renvoyée par le backend).
 * `id` est l'id (serveur ou temporaire) attribué à la question. Les ids des
 * enfants sans id (nouvelles options/éléments/harnais) reçoivent un id négatif
 * provisoire — en réel, c'est le backend qui les attribue. Partagé par l'éditeur
 * (mode mémoire) et la couche API mock (`dashboardApi.saveQuestion`).
 */
export function draftToQuestion(
  draft: QuestionDraft,
  id: number,
  languages?: Language[]
): Question {
  const language =
    draft.qType === 'coding'
      ? (languages ?? []).find((l) => l.id === draft.languageId) ?? {
          id: draft.languageId ?? 1,
          name: 'Python',
        }
      : undefined;
  return {
    id,
    qType: draft.qType,
    prompt: draft.prompt,
    totalScore: draft.totalScore,
    answers: draft.answers?.map((a, i) => ({
      id: a.id ?? -(i + 1),
      content: a.content,
      isCorrect: a.isCorrect,
    })),
    dragItems: draft.dragItems?.map((d, i) => ({
      id: d.id ?? -(i + 1),
      content: d.content,
      correctOrder: d.correctOrder ?? 0,
      groupName: d.groupName ?? null,
    })),
    language,
    startCode: draft.startCode,
    testCases: draft.testCases?.map((t, i) => ({
      id: t.id ?? -(i + 1),
      name: t.name,
      harnessCode: t.harnessCode,
      weight: t.weight,
    })),
  };
}
