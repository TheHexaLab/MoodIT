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
  type QuestionTypeOption,
  type Quiz,
  type TestCase,
} from '../../types/domain';
import {
  type CodeEvaluationInput,
  type CodingTestResult,
  type RunCodeInput,
  type RunResult,
} from '../MainPanel/QuizView/quizAttempt';

/** Valeur synchrone ou asynchrone. */
export type MaybePromise<T> = T | Promise<T>;

/** Méta d'un quiz, telles qu'éditées dans le formulaire « Modifier le quiz ». */
export interface QuizMetaDraft {
  title: string;
  isPublished: boolean;
  isDaily: boolean;
  /** L'étudiant peut-il refaire le quiz (tentatives multiples) ? */
  allowRetry: boolean;
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
  /**
   * Charge TOUS les quiz d'un cours (brouillons compris), au montage de l'éditeur.
   * Sans lui, l'éditeur se contente de la liste reçue en prop (quiz publiés).
   */
  onFetchQuizzes?: (courseId: number) => MaybePromise<Quiz[]>;
  /**
   * Charge les langages d'exécution. Appelé PARESSEUSEMENT : seulement à l'ouverture
   * d'une question Code (édition ou passage au type Code). Mis en cache par l'éditeur.
   */
  onFetchLanguages?: () => MaybePromise<Language[]>;
  /**
   * Charge les types de question (table Q_Type). Appelé PARESSEUSEMENT à l'ouverture
   * d'un éditeur de question (ajout/modification). Mis en cache par l'éditeur.
   */
  onFetchQuestionTypes?: () => MaybePromise<QuestionTypeOption[]>;
  /**
   * Évalue une question Code (exécution serveur des harnais) : reçoit le code + les
   * harnais, renvoie le verdict par test. Sert au bouton « Tester » d'une question Code.
   */
  onEvaluateCode?: (input: CodeEvaluationInput) => MaybePromise<CodingTestResult[]>;
  /**
   * Exécute un code TEL QUEL (sans harnais) dans le sandbox : sert au bouton « play » de
   * l'onglet « Tester » d'une question Code. Renvoie la sortie brute (stdout/stderr/exit).
   */
  onRunCode?: (input: RunCodeInput) => MaybePromise<RunResult>;
}

/** Langages disponibles pour les questions Code (fournis par le parent ; sinon défaut). */
export const DEFAULT_LANGUAGES: Language[] = [
  { id: 1, name: 'Python' },
  { id: 2, name: 'JavaScript' },
  { id: 3, name: 'TypeScript' },
  { id: 4, name: 'SQL' },
  { id: 5, name: 'Java' },
  { id: 6, name: 'C' },
  { id: 7, name: 'C++' },
  { id: 8, name: 'C#' },
  { id: 9, name: 'Bash' },
  { id: 10, name: 'HTML' },
  { id: 11, name: 'Rust' },
  { id: 12, name: 'PHP' },
  { id: 13, name: 'JSX' },
  { id: 14, name: 'TSX' },
  { id: 15, name: 'JSON' },
  { id: 16, name: 'Go' },
];

/**
 * Repli MINIMAL (Python + C) affiché tant que les langages ne sont pas chargés via
 * l'API (ou si elle échoue). La liste COMPLÈTE vient de `onFetchLanguages`/`DEFAULT_LANGUAGES`.
 */
export const FALLBACK_LANGUAGES: Language[] = DEFAULT_LANGUAGES.filter(
  (l) => l.name === 'Python' || l.name === 'C'
);

/** Squelette de code de départ proposé par langage (par nom, insensible à la casse). */
const START_CODE_BY_LANGUAGE: Record<string, string> = {
  python:
    '# Sandbox : bibliothèque standard complète + numpy, pandas, scipy, sympy (aucun réseau).\n' +
    'def solution():\n    # à compléter\n    pass\n',
  javascript: 'function solution() {\n  // à compléter\n}\n',
  typescript: 'function solution(): void {\n  // à compléter\n}\n',
  sql: '-- Écris ta requête ici\n',
  java: 'public class Solution {\n    public static void main(String[] args) {\n        // à compléter\n    }\n}\n',
  c: '#include <stdio.h>\n\nint main(void) {\n    // à compléter\n    return 0;\n}\n',
  'c++': '#include <iostream>\n\nint main() {\n    // à compléter\n    return 0;\n}\n',
  'c#': 'using System;\n\nclass Solution\n{\n    static void Main()\n    {\n        // à compléter\n    }\n}\n',
  bash: '#!/usr/bin/env bash\n# à compléter\n',
  html: '<!DOCTYPE html>\n<html lang="fr">\n  <head>\n    <meta charset="utf-8" />\n    <title></title>\n  </head>\n  <body>\n    <!-- à compléter -->\n  </body>\n</html>\n',
  rust: 'fn solution() {\n    // à compléter\n}\n',
  php: '<?php\n// à compléter\n',
  jsx: 'function Composant() {\n  return (\n    <div>{/* à compléter */}</div>\n  );\n}\n',
  tsx: 'function Composant(): JSX.Element {\n  return (\n    <div>{/* à compléter */}</div>\n  );\n}\n',
  json: '{\n  "_commentaire": "à compléter — remplace ce contenu par ta réponse JSON"\n}\n',
  go: 'package main\n\nimport "fmt"\n\nfunc main() {\n    // à compléter\n}\n',
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

/**
 * Squelette de harnais par langage DU HARNAIS (par nom, insensible à la casse). Commentaire
 * idiomatique du langage → au moins « dans le bon langage » tant qu'aucun gabarit backend n'est
 * fourni. Le langage passé est celui du harnais (résolu via Language.harnessLanguageId).
 */
const HARNESS_TEMPLATE_BY_LANGUAGE: Record<string, string> = {
  python: '# Harnais : lève une exception (ou renvoie False) si la réponse est incorrecte.\n',
  javascript: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  typescript: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  jsx: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  tsx: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  java: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  c: '// Harnais : renvoie 0 si la réponse est correcte, non-zéro sinon.\n',
  'c++': '// Harnais : renvoie 0 si la réponse est correcte, non-zéro sinon.\n',
  'c#': '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  go: '// Harnais : lève une erreur (ou renvoie false) si la réponse est incorrecte.\n',
  rust: '// Harnais : panique (ou renvoie false) si la réponse est incorrecte.\n',
  php: '// Harnais : lève une exception (ou renvoie false) si la réponse est incorrecte.\n',
  sql: '-- Harnais : requête de vérification renvoyant vrai/faux.\n',
  bash: '# Harnais : sortie 0 si la réponse est correcte, non-zéro sinon.\n',
};

/**
 * Code de harnais par défaut d'un NOUVEAU harnais. Le gabarit vient du LANGAGE DE LA QUESTION
 * (`questionLanguage.harnessTemplate`) — ainsi HTML/JSON ont un harnais JS AVEC le guidage de
 * parsing propre à leur contenu, distinct l'un de l'autre. À défaut de gabarit backend, replie
 * sur un squelette générique par nom du langage DU HARNAIS (celui dans lequel il s'écrit,
 * résolu via harnessLanguageId). Chaîne vide si rien de connu.
 */
export function defaultHarness(questionLanguage?: Language, harnessLanguage?: Language): string {
  const fallbackKey = (harnessLanguage ?? questionLanguage)?.name.toLowerCase();
  return (
    questionLanguage?.harnessTemplate ??
    (fallbackKey ? HARNESS_TEMPLATE_BY_LANGUAGE[fallbackKey] : undefined) ??
    ''
  );
}

/** Construit le brouillon initial d'une question d'un type donné (valeurs par défaut). */
export function emptyQuestionDraft(qType: QuestionType): QuestionDraft {
  const base = { prompt: '', totalScore: 1 } as const;
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
 *
 * `questionTypes` (liste chargée via `onFetchQuestionTypes`) sert à résoudre
 * `qTypeId` (Q_Type.id, requis NOT NULL en base) à partir du `qType` (slug front,
 * absent de la base). Si la liste est absente, `qTypeId` reste indéfini et le
 * backend doit le résoudre lui-même.
 */
export function draftToQuestion(
  draft: QuestionDraft,
  id: number,
  languages?: Language[],
  questionTypes?: QuestionTypeOption[]
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
    qTypeId: questionTypes?.find((t) => t.slug === draft.qType)?.id,
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
