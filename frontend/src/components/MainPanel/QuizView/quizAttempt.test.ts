import { describe, it, expect } from 'vitest';
import {
  answerKindFor,
  emptyAnswer,
  initAnswers,
  mergeAnswers,
  isAnswered,
  toSubmission,
  fromSubmission,
  CodeVerificationUnavailableError,
  type AttemptAnswers,
  type QuizSubmission,
} from './quizAttempt';
import type { Quiz, Question, QuestionType } from '../../../types/domain';

// ── Fabriques d'entités de test ────────────────────────────────────────────────

function q(partial: Partial<Question> & { id: number; qType: QuestionType }): Question {
  return {
    prompt: '',
    totalScore: 1,
    ...partial,
  } as Question;
}

function quizOf(questions: Question[], id = 1): Quiz {
  return { id, title: 'Q', questions } as Quiz;
}

// ── answerKindFor ───────────────────────────────────────────────────────────────

describe('answerKindFor', () => {
  it('mappe les types de choix vers "choice"', () => {
    expect(answerKindFor('true_false')).toBe('choice');
    expect(answerKindFor('single_choice')).toBe('choice');
    expect(answerKindFor('multiple_choice')).toBe('choice');
  });
  it('mappe ordering/matching/coding', () => {
    expect(answerKindFor('ordering')).toBe('ordering');
    expect(answerKindFor('matching')).toBe('matching');
    expect(answerKindFor('coding')).toBe('coding');
  });
});

// ── emptyAnswer ─────────────────────────────────────────────────────────────────

describe('emptyAnswer', () => {
  it('choix : answerIds vide', () => {
    expect(emptyAnswer(q({ id: 1, qType: 'single_choice' }))).toEqual({
      kind: 'choice',
      answerIds: [],
    });
    expect(emptyAnswer(q({ id: 1, qType: 'true_false' }))).toEqual({
      kind: 'choice',
      answerIds: [],
    });
    expect(emptyAnswer(q({ id: 1, qType: 'multiple_choice' }))).toEqual({
      kind: 'choice',
      answerIds: [],
    });
  });

  it('coding : reprend startCode, ou chaîne vide si absent', () => {
    expect(emptyAnswer(q({ id: 1, qType: 'coding', startCode: 'print(1)' }))).toEqual({
      kind: 'coding',
      code: 'print(1)',
    });
    expect(emptyAnswer(q({ id: 1, qType: 'coding' }))).toEqual({ kind: 'coding', code: '' });
  });

  it('matching : tous les éléments non classés (null)', () => {
    const question = q({
      id: 1,
      qType: 'matching',
      dragItems: [
        { id: 10, content: 'a', groupName: 'G1' },
        { id: 11, content: 'b', groupName: 'G2' },
      ],
    });
    expect(emptyAnswer(question)).toEqual({
      kind: 'matching',
      placement: { 10: null, 11: null },
    });
  });

  it('matching : dragItems absent → placement vide', () => {
    expect(emptyAnswer(q({ id: 1, qType: 'matching' }))).toEqual({
      kind: 'matching',
      placement: {},
    });
  });

  it('ordering : 0 ou 1 élément → tel quel (pas de shuffle)', () => {
    expect(emptyAnswer(q({ id: 1, qType: 'ordering' }))).toEqual({
      kind: 'ordering',
      itemIds: [],
    });
    expect(
      emptyAnswer(
        q({ id: 1, qType: 'ordering', dragItems: [{ id: 5, content: 'x', correctOrder: 0 }] })
      )
    ).toEqual({ kind: 'ordering', itemIds: [5] });
  });

  it('ordering : contient exactement les mêmes ids que l ordre correct', () => {
    const items = [
      { id: 1, content: 'a', correctOrder: 0 },
      { id: 2, content: 'b', correctOrder: 1 },
      { id: 3, content: 'c', correctOrder: 2 },
      { id: 4, content: 'd', correctOrder: 3 },
    ];
    const ans = emptyAnswer(q({ id: 1, qType: 'ordering', dragItems: items }));
    expect(ans.kind).toBe('ordering');
    if (ans.kind === 'ordering') {
      expect([...ans.itemIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    }
  });

  it('ordering : ordre de départ TOUJOURS différent de l ordre correct (garanti)', () => {
    const items = [
      { id: 1, content: 'a', correctOrder: 0 },
      { id: 2, content: 'b', correctOrder: 1 },
      { id: 3, content: 'c', correctOrder: 2 },
      { id: 4, content: 'd', correctOrder: 3 },
    ];
    const correct = [1, 2, 3, 4];
    // Répété : le shuffle ne doit jamais rendre l'ordre correct.
    for (let i = 0; i < 200; i++) {
      const ans = emptyAnswer(q({ id: 1, qType: 'ordering', dragItems: items }));
      if (ans.kind === 'ordering') {
        expect(ans.itemIds).not.toEqual(correct);
      }
    }
  });

  it('ordering : trie par correctOrder avant de mélanger (correctOrder manquant = 0)', () => {
    const items = [
      { id: 3, content: 'c', correctOrder: 2 },
      { id: 1, content: 'a', correctOrder: 0 },
      { id: 2, content: 'b', correctOrder: 1 },
    ];
    // L'ordre correct dérivé est [1,2,3] ; le shuffle ne doit jamais l'égaler.
    for (let i = 0; i < 100; i++) {
      const ans = emptyAnswer(q({ id: 1, qType: 'ordering', dragItems: items }));
      if (ans.kind === 'ordering') expect(ans.itemIds).not.toEqual([1, 2, 3]);
    }
  });
});

// ── initAnswers ─────────────────────────────────────────────────────────────────

describe('initAnswers', () => {
  it('une entrée par question', () => {
    const quiz = quizOf([
      q({ id: 1, qType: 'single_choice' }),
      q({ id: 2, qType: 'coding', startCode: 'x' }),
    ]);
    const a = initAnswers(quiz);
    expect(Object.keys(a).sort()).toEqual(['1', '2']);
    expect(a[1]).toEqual({ kind: 'choice', answerIds: [] });
    expect(a[2]).toEqual({ kind: 'coding', code: 'x' });
  });

  it('quiz sans questions → objet vide', () => {
    expect(initAnswers({ id: 1, title: 'Q' } as Quiz)).toEqual({});
    expect(initAnswers(quizOf([]))).toEqual({});
  });
});

// ── mergeAnswers ────────────────────────────────────────────────────────────────

describe('mergeAnswers', () => {
  it('quiz sans questions → objet vide', () => {
    expect(mergeAnswers({ id: 1, title: 'Q' } as Quiz, {})).toEqual({});
  });

  it('nouvelle question (pas de réponse antérieure) → vide', () => {
    const quiz = quizOf([q({ id: 9, qType: 'coding', startCode: 'boot' })]);
    expect(mergeAnswers(quiz, {})).toEqual({ 9: { kind: 'coding', code: 'boot' } });
  });

  it('type changé → repart de l état vide', () => {
    const quiz = quizOf([q({ id: 1, qType: 'coding', startCode: 'init' })]);
    const previous: AttemptAnswers = { 1: { kind: 'choice', answerIds: [3] } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'coding', code: 'init' } });
  });

  it('choice : ne garde que les ids d options encore présentes', () => {
    const quiz = quizOf([
      q({
        id: 1,
        qType: 'multiple_choice',
        answers: [
          { id: 10, content: 'a' },
          { id: 11, content: 'b' },
        ],
      }),
    ]);
    const previous: AttemptAnswers = { 1: { kind: 'choice', answerIds: [10, 99, 11] } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'choice', answerIds: [10, 11] } });
  });

  it('choice : answers absent → tout filtré', () => {
    const quiz = quizOf([q({ id: 1, qType: 'single_choice' })]);
    const previous: AttemptAnswers = { 1: { kind: 'choice', answerIds: [10] } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'choice', answerIds: [] } });
  });

  it('ordering : garde l ordre des éléments présents, ajoute les nouveaux à la fin', () => {
    const quiz = quizOf([
      q({
        id: 1,
        qType: 'ordering',
        dragItems: [
          { id: 1, content: 'a', correctOrder: 0 },
          { id: 2, content: 'b', correctOrder: 1 },
          { id: 3, content: 'c', correctOrder: 2 },
        ],
      }),
    ]);
    // Ancien ordre choisi [3,1] ; l'élément 2 est nouveau → ajouté à la fin.
    const previous: AttemptAnswers = { 1: { kind: 'ordering', itemIds: [3, 99, 1] } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'ordering', itemIds: [3, 1, 2] } });
  });

  it('ordering : dragItems absent → vide', () => {
    const quiz = quizOf([q({ id: 1, qType: 'ordering' })]);
    const previous: AttemptAnswers = { 1: { kind: 'ordering', itemIds: [3, 1] } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'ordering', itemIds: [] } });
  });

  it('matching : reprend les placements des éléments présents, null sinon', () => {
    const quiz = quizOf([
      q({
        id: 1,
        qType: 'matching',
        dragItems: [
          { id: 1, content: 'a', groupName: 'G1' },
          { id: 2, content: 'b', groupName: 'G2' },
          { id: 3, content: 'c', groupName: 'G3' },
        ],
      }),
    ]);
    const previous: AttemptAnswers = {
      1: { kind: 'matching', placement: { 1: 'G1', 2: null, 42: 'ghost' } },
    };
    expect(mergeAnswers(quiz, previous)).toEqual({
      1: { kind: 'matching', placement: { 1: 'G1', 2: null, 3: null } },
    });
  });

  it('coding : conserve le code saisi', () => {
    const quiz = quizOf([q({ id: 1, qType: 'coding', startCode: 'skeleton' })]);
    const previous: AttemptAnswers = { 1: { kind: 'coding', code: 'user code' } };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'coding', code: 'user code' } });
  });

  it('question absente du quiz rechargé → non présente dans le résultat', () => {
    const quiz = quizOf([q({ id: 1, qType: 'single_choice', answers: [{ id: 5, content: 'a' }] })]);
    const previous: AttemptAnswers = {
      1: { kind: 'choice', answerIds: [5] },
      2: { kind: 'coding', code: 'obsolete' },
    };
    expect(mergeAnswers(quiz, previous)).toEqual({ 1: { kind: 'choice', answerIds: [5] } });
  });
});

// ── isAnswered ──────────────────────────────────────────────────────────────────

describe('isAnswered', () => {
  it('undefined → false', () => {
    expect(isAnswered(undefined)).toBe(false);
  });
  it('choice', () => {
    expect(isAnswered({ kind: 'choice', answerIds: [] })).toBe(false);
    expect(isAnswered({ kind: 'choice', answerIds: [1] })).toBe(true);
  });
  it('ordering', () => {
    expect(isAnswered({ kind: 'ordering', itemIds: [] })).toBe(false);
    expect(isAnswered({ kind: 'ordering', itemIds: [3, 1] })).toBe(true);
  });
  it('matching : true dès qu un élément est classé', () => {
    expect(isAnswered({ kind: 'matching', placement: {} })).toBe(false);
    expect(isAnswered({ kind: 'matching', placement: { 1: null, 2: null } })).toBe(false);
    expect(isAnswered({ kind: 'matching', placement: { 1: null, 2: 'G1' } })).toBe(true);
  });
  it('coding : ignore les blancs', () => {
    expect(isAnswered({ kind: 'coding', code: '' })).toBe(false);
    expect(isAnswered({ kind: 'coding', code: '   \n\t ' })).toBe(false);
    expect(isAnswered({ kind: 'coding', code: 'x' })).toBe(true);
  });
});

// ── toSubmission ────────────────────────────────────────────────────────────────

describe('toSubmission', () => {
  it('mappe chaque kind vers le bon champ', () => {
    const quiz = quizOf(
      [
        q({ id: 1, qType: 'single_choice' }),
        q({ id: 2, qType: 'ordering' }),
        q({ id: 3, qType: 'matching' }),
        q({ id: 4, qType: 'coding' }),
      ],
      7
    );
    const answers: AttemptAnswers = {
      1: { kind: 'choice', answerIds: [10, 11] },
      2: { kind: 'ordering', itemIds: [3, 1, 2] },
      3: { kind: 'matching', placement: { 1: 'G1' } },
      4: { kind: 'coding', code: 'src' },
    };
    expect(toSubmission(quiz, answers)).toEqual({
      quizId: 7,
      answers: [
        { questionId: 1, answerIds: [10, 11] },
        { questionId: 2, orderedItemIds: [3, 1, 2] },
        { questionId: 3, placement: { 1: 'G1' } },
        { questionId: 4, code: 'src' },
      ],
    });
  });

  it('réponse manquante (default) → juste questionId', () => {
    const quiz = quizOf([q({ id: 1, qType: 'single_choice' })], 3);
    expect(toSubmission(quiz, {})).toEqual({
      quizId: 3,
      answers: [{ questionId: 1 }],
    });
  });

  it('quiz sans questions → answers vide', () => {
    expect(toSubmission({ id: 5, title: 'Q' } as Quiz, {})).toEqual({ quizId: 5, answers: [] });
  });
});

// ── fromSubmission ──────────────────────────────────────────────────────────────

describe('fromSubmission', () => {
  it('reconstruit selon le type de chaque question', () => {
    const quiz = quizOf(
      [
        q({ id: 1, qType: 'multiple_choice' }),
        q({ id: 2, qType: 'ordering' }),
        q({ id: 3, qType: 'matching' }),
        q({ id: 4, qType: 'coding' }),
      ],
      2
    );
    const submission: QuizSubmission = {
      quizId: 2,
      answers: [
        { questionId: 1, answerIds: [10] },
        { questionId: 2, orderedItemIds: [2, 1] },
        { questionId: 3, placement: { 1: 'G1' } },
        { questionId: 4, code: 'code' },
      ],
    };
    expect(fromSubmission(quiz, submission)).toEqual({
      1: { kind: 'choice', answerIds: [10] },
      2: { kind: 'ordering', itemIds: [2, 1] },
      3: { kind: 'matching', placement: { 1: 'G1' } },
      4: { kind: 'coding', code: 'code' },
    });
  });

  it('question sans réponse soumise → valeurs par défaut vides selon le type', () => {
    const quiz = quizOf([
      q({ id: 1, qType: 'true_false' }),
      q({ id: 2, qType: 'ordering' }),
      q({ id: 3, qType: 'matching' }),
      q({ id: 4, qType: 'coding' }),
    ]);
    expect(fromSubmission(quiz, { quizId: 1, answers: [] })).toEqual({
      1: { kind: 'choice', answerIds: [] },
      2: { kind: 'ordering', itemIds: [] },
      3: { kind: 'matching', placement: {} },
      4: { kind: 'coding', code: '' },
    });
  });

  it('ignore les réponses soumises pour des questions inconnues', () => {
    const quiz = quizOf([q({ id: 1, qType: 'single_choice' })]);
    const submission: QuizSubmission = {
      quizId: 1,
      answers: [
        { questionId: 1, answerIds: [5] },
        { questionId: 999, answerIds: [7] },
      ],
    };
    expect(fromSubmission(quiz, submission)).toEqual({ 1: { kind: 'choice', answerIds: [5] } });
  });

  it('quiz sans questions → objet vide', () => {
    expect(fromSubmission({ id: 1, title: 'Q' } as Quiz, { quizId: 1, answers: [] })).toEqual({});
  });

  it('champ présent mais du mauvais type → défaut vide (ex. code manquant sur coding)', () => {
    const quiz = quizOf([q({ id: 1, qType: 'coding' })]);
    // answerIds fourni mais la question est coding → code absent → ''
    const submission: QuizSubmission = { quizId: 1, answers: [{ questionId: 1, answerIds: [1] }] };
    expect(fromSubmission(quiz, submission)).toEqual({ 1: { kind: 'coding', code: '' } });
  });

  it('toSubmission ∘ fromSubmission : round-trip cohérent', () => {
    const quiz = quizOf(
      [
        q({ id: 1, qType: 'multiple_choice' }),
        q({ id: 2, qType: 'ordering' }),
        q({ id: 3, qType: 'matching' }),
        q({ id: 4, qType: 'coding' }),
      ],
      9
    );
    const answers: AttemptAnswers = {
      1: { kind: 'choice', answerIds: [10, 11] },
      2: { kind: 'ordering', itemIds: [3, 1, 2] },
      3: { kind: 'matching', placement: { 1: 'G1', 2: null } },
      4: { kind: 'coding', code: 'src' },
    };
    const rebuilt = fromSubmission(quiz, toSubmission(quiz, answers));
    expect(rebuilt).toEqual(answers);
  });
});

// ── CodeVerificationUnavailableError ────────────────────────────────────────────

describe('CodeVerificationUnavailableError', () => {
  it('a le bon name, message et est une Error', () => {
    const e = new CodeVerificationUnavailableError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CodeVerificationUnavailableError');
    expect(e.message).toBe('Code verification unavailable');
  });

  it('est capturable par son type', () => {
    let caught: unknown;
    try {
      throw new CodeVerificationUnavailableError();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodeVerificationUnavailableError);
  });
});
