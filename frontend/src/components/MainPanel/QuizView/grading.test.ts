import { describe, it, expect } from 'vitest';
import { gradeQuestion, gradeQuiz } from './grading';
import type { AttemptAnswers, QuestionAnswer } from './quizAttempt';
import type { Quiz, Question, QuestionType } from '../../../types/domain';

function q(partial: Partial<Question> & { id: number; qType: QuestionType }): Question {
  return { prompt: '', totalScore: 10, ...partial } as Question;
}

// ── gradeChoice (true_false / single_choice / multiple_choice) ──────────────────

describe('gradeQuestion — choix tout-ou-rien (true_false / single_choice)', () => {
  const question = q({
    id: 1,
    qType: 'single_choice',
    totalScore: 10,
    answers: [
      { id: 1, content: 'a', isCorrect: true },
      { id: 2, content: 'b', isCorrect: false },
    ],
  });

  it('bonne réponse exacte → plein score', () => {
    const r = gradeQuestion(question, { kind: 'choice', answerIds: [1] });
    expect(r.earned).toBe(10);
    expect(r.max).toBe(10);
    expect(r.correctAnswerIds).toEqual([1]);
    expect(r.selectedAnswerIds).toEqual([1]);
  });

  it('mauvaise réponse → 0', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [2] }).earned).toBe(0);
  });

  it('réponse vide → 0', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [] }).earned).toBe(0);
  });

  it('answer undefined → sélection vide → 0', () => {
    const r = gradeQuestion(question, undefined);
    expect(r.earned).toBe(0);
    expect(r.selectedAnswerIds).toEqual([]);
  });

  it('answer d un autre kind → sélection vide → 0', () => {
    const r = gradeQuestion(question, { kind: 'coding', code: 'x' } as QuestionAnswer);
    expect(r.earned).toBe(0);
    expect(r.selectedAnswerIds).toEqual([]);
  });

  it('true_false : plein score si exact', () => {
    const tf = q({
      id: 2,
      qType: 'true_false',
      totalScore: 5,
      answers: [
        { id: 10, content: 'Vrai', isCorrect: true },
        { id: 11, content: 'Faux', isCorrect: false },
      ],
    });
    expect(gradeQuestion(tf, { kind: 'choice', answerIds: [10] }).earned).toBe(5);
    expect(gradeQuestion(tf, { kind: 'choice', answerIds: [11] }).earned).toBe(0);
  });

  it('single_choice : sur-sélection (ensemble ≠ correct) → 0', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1, 2] }).earned).toBe(0);
  });

  it('answers absent → correctIds vide, sélection vide = exact → plein score', () => {
    const noAns = q({ id: 3, qType: 'single_choice', totalScore: 4 });
    expect(gradeQuestion(noAns, { kind: 'choice', answerIds: [] }).earned).toBe(4);
  });
});

describe('gradeQuestion — choix multiple (crédit partiel)', () => {
  const question = q({
    id: 1,
    qType: 'multiple_choice',
    totalScore: 10,
    answers: [
      { id: 1, content: 'a', isCorrect: true },
      { id: 2, content: 'b', isCorrect: true },
      { id: 3, content: 'c', isCorrect: false },
      { id: 4, content: 'd', isCorrect: false },
    ],
  });

  it('toutes les bonnes, aucune mauvaise → plein score', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1, 2] }).earned).toBe(10);
  });

  it('une bonne sur deux → (1-0)/2 = 0.5 → 5', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1] }).earned).toBe(5);
  });

  it('une bonne et une mauvaise → (1-1)/2 = 0 → 0', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1, 3] }).earned).toBe(0);
  });

  it('deux bonnes et une mauvaise → (2-1)/2 = 0.5 → 5', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1, 2, 3] }).earned).toBe(5);
  });

  it('crédit partiel borné à 0 (plus de mauvaises que de bonnes)', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [1, 3, 4] }).earned).toBe(0);
  });

  it('réponse vide → 0', () => {
    expect(gradeQuestion(question, { kind: 'choice', answerIds: [] }).earned).toBe(0);
  });

  it('aucune bonne réponse définie (nb_bonnes = 0) → ratio 0 → 0', () => {
    const noneCorrect = q({
      id: 2,
      qType: 'multiple_choice',
      totalScore: 8,
      answers: [
        { id: 1, content: 'a', isCorrect: false },
        { id: 2, content: 'b', isCorrect: false },
      ],
    });
    expect(gradeQuestion(noneCorrect, { kind: 'choice', answerIds: [1] }).earned).toBe(0);
    expect(gradeQuestion(noneCorrect, { kind: 'choice', answerIds: [] }).earned).toBe(0);
  });

  it('arrondi au dixième : 1 bonne sur 3 → 0.333 × 3 = 1', () => {
    const three = q({
      id: 3,
      qType: 'multiple_choice',
      totalScore: 3,
      answers: [
        { id: 1, content: 'a', isCorrect: true },
        { id: 2, content: 'b', isCorrect: true },
        { id: 3, content: 'c', isCorrect: true },
      ],
    });
    expect(gradeQuestion(three, { kind: 'choice', answerIds: [1] }).earned).toBe(1);
  });
});

// ── gradeOrdering ───────────────────────────────────────────────────────────────

describe('gradeQuestion — ordering (proportion à la bonne position)', () => {
  const question = q({
    id: 1,
    qType: 'ordering',
    totalScore: 10,
    dragItems: [
      { id: 1, content: 'a', correctOrder: 0 },
      { id: 2, content: 'b', correctOrder: 1 },
      { id: 3, content: 'c', correctOrder: 2 },
      { id: 4, content: 'd', correctOrder: 3 },
    ],
  });

  it('ordre parfait → plein score', () => {
    const r = gradeQuestion(question, { kind: 'ordering', itemIds: [1, 2, 3, 4] });
    expect(r.earned).toBe(10);
    expect(r.correctOrder).toEqual([1, 2, 3, 4]);
    expect(r.submittedOrder).toEqual([1, 2, 3, 4]);
  });

  it('deux sur quatre bien placés → 0.5 → 5', () => {
    // positions 0 et 1 correctes ; 3 et 4 échangés.
    expect(gradeQuestion(question, { kind: 'ordering', itemIds: [1, 2, 4, 3] }).earned).toBe(5);
  });

  it('ordre inversé → 0 (aucune position correcte pour 4 items)', () => {
    expect(gradeQuestion(question, { kind: 'ordering', itemIds: [4, 3, 2, 1] }).earned).toBe(0);
  });

  it('soumission vide → 0', () => {
    expect(gradeQuestion(question, { kind: 'ordering', itemIds: [] }).earned).toBe(0);
  });

  it('answer undefined ou mauvais kind → soumission vide → 0', () => {
    expect(gradeQuestion(question, undefined).earned).toBe(0);
    expect(
      gradeQuestion(question, { kind: 'choice', answerIds: [1] } as QuestionAnswer).submittedOrder
    ).toEqual([]);
  });

  it('dragItems absent (0 élément) → ratio 0 → 0', () => {
    const empty = q({ id: 2, qType: 'ordering', totalScore: 6 });
    const r = gradeQuestion(empty, { kind: 'ordering', itemIds: [] });
    expect(r.earned).toBe(0);
    expect(r.correctOrder).toEqual([]);
  });

  it('trie l ordre attendu par correctOrder', () => {
    const q2 = q({
      id: 3,
      qType: 'ordering',
      totalScore: 4,
      dragItems: [
        { id: 30, content: 'z', correctOrder: 2 },
        { id: 10, content: 'x', correctOrder: 0 },
        { id: 20, content: 'y', correctOrder: 1 },
      ],
    });
    expect(gradeQuestion(q2, { kind: 'ordering', itemIds: [10, 20, 30] }).correctOrder).toEqual([
      10, 20, 30,
    ]);
  });
});

// ── gradeMatching ───────────────────────────────────────────────────────────────

describe('gradeQuestion — matching (proportion bien classés)', () => {
  const question = q({
    id: 1,
    qType: 'matching',
    totalScore: 10,
    dragItems: [
      { id: 1, content: 'a', groupName: 'G1' },
      { id: 2, content: 'b', groupName: 'G2' },
    ],
  });

  it('tous bien classés → plein score', () => {
    const r = gradeQuestion(question, {
      kind: 'matching',
      placement: { 1: 'G1', 2: 'G2' },
    });
    expect(r.earned).toBe(10);
    expect(r.matching).toEqual([
      { itemId: 1, chosenGroup: 'G1', correctGroup: 'G1', correct: true },
      { itemId: 2, chosenGroup: 'G2', correctGroup: 'G2', correct: true },
    ]);
  });

  it('un sur deux bien classé → 0.5 → 5', () => {
    expect(
      gradeQuestion(question, { kind: 'matching', placement: { 1: 'G1', 2: 'WRONG' } }).earned
    ).toBe(5);
  });

  it('placement vide (non classés) → chosen null → 0', () => {
    const r = gradeQuestion(question, { kind: 'matching', placement: {} });
    expect(r.earned).toBe(0);
    expect(r.matching?.[0]).toEqual({
      itemId: 1,
      chosenGroup: null,
      correctGroup: 'G1',
      correct: false,
    });
  });

  it('placement null explicite → non classé', () => {
    expect(
      gradeQuestion(question, { kind: 'matching', placement: { 1: null, 2: 'G2' } }).earned
    ).toBe(5);
  });

  it('answer undefined ou mauvais kind → placement vide → 0', () => {
    expect(gradeQuestion(question, undefined).earned).toBe(0);
    expect(
      gradeQuestion(question, { kind: 'coding', code: 'x' } as QuestionAnswer).earned
    ).toBe(0);
  });

  it('groupName absent → correctGroup = "" ; classer null y correspond', () => {
    const q2 = q({
      id: 2,
      qType: 'matching',
      totalScore: 4,
      dragItems: [{ id: 5, content: 'a' }],
    });
    // chosen null vs correct '' → différent → incorrect.
    expect(gradeQuestion(q2, { kind: 'matching', placement: {} }).matching?.[0]).toEqual({
      itemId: 5,
      chosenGroup: null,
      correctGroup: '',
      correct: false,
    });
    // chosen '' vs correct '' → correct.
    expect(gradeQuestion(q2, { kind: 'matching', placement: { 5: '' } }).earned).toBe(4);
  });

  it('dragItems absent (0 élément) → ratio 0 → 0, matching vide', () => {
    const empty = q({ id: 3, qType: 'matching', totalScore: 6 });
    const r = gradeQuestion(empty, { kind: 'matching', placement: {} });
    expect(r.earned).toBe(0);
    expect(r.matching).toEqual([]);
  });
});

// ── gradeCoding ─────────────────────────────────────────────────────────────────

describe('gradeQuestion — coding (heuristique mock, un harnais sur deux)', () => {
  const question = q({
    id: 1,
    qType: 'coding',
    totalScore: 10,
    testCases: [
      { id: 1, name: 't0', harnessCode: '', weight: 1 },
      { id: 2, name: 't1', harnessCode: '', weight: 1 },
      { id: 3, name: 't2', harnessCode: '', weight: 1 },
      { id: 4, name: 't3', harnessCode: '', weight: 1 },
    ],
  });

  it('code non vide → indices pairs passent (2/4 poids) → 5', () => {
    const r = gradeQuestion(question, { kind: 'coding', code: 'print(1)' });
    expect(r.earned).toBe(5);
    expect(r.tests).toEqual([
      { name: 't0', passed: true, weight: 1 },
      { name: 't1', passed: false, weight: 1 },
      { name: 't2', passed: true, weight: 1 },
      { name: 't3', passed: false, weight: 1 },
    ]);
  });

  it('code vide (ou blanc) → aucun harnais passé → 0, mais tests présents (non null)', () => {
    const r = gradeQuestion(question, { kind: 'coding', code: '   ' });
    expect(r.earned).toBe(0);
    expect(r.tests?.every((t) => !t.passed)).toBe(true);
    expect(r.tests).toHaveLength(4);
  });

  it('answer undefined ou mauvais kind → code vide → 0', () => {
    expect(gradeQuestion(question, undefined).earned).toBe(0);
    expect(
      gradeQuestion(question, { kind: 'choice', answerIds: [1] } as QuestionAnswer).earned
    ).toBe(0);
  });

  it('aucun harnais défini → tests null (évalué côté serveur), earned 0', () => {
    const noTests = q({ id: 2, qType: 'coding', totalScore: 10 });
    const r = gradeQuestion(noTests, { kind: 'coding', code: 'du code' });
    expect(r.tests).toBeNull();
    expect(r.earned).toBe(0);
  });

  it('respecte les poids : seul l index 0 lourd passe', () => {
    const weighted = q({
      id: 3,
      qType: 'coding',
      totalScore: 10,
      testCases: [
        { id: 1, name: 'lourd', harnessCode: '', weight: 3 },
        { id: 2, name: 'leger', harnessCode: '', weight: 1 },
      ],
    });
    // index 0 (poids 3) passe, index 1 (poids 1) échoue → 3/4 → 7.5
    expect(gradeQuestion(weighted, { kind: 'coding', code: 'x' }).earned).toBe(7.5);
  });

  it('poids total 0 → ratio 0 → 0', () => {
    const zeroWeight = q({
      id: 4,
      qType: 'coding',
      totalScore: 10,
      testCases: [{ id: 1, name: 't', harnessCode: '', weight: 0 }],
    });
    expect(gradeQuestion(zeroWeight, { kind: 'coding', code: 'x' }).earned).toBe(0);
  });
});

// ── gradeQuiz ───────────────────────────────────────────────────────────────────

describe('gradeQuiz', () => {
  it('somme earned/max et liste les résultats par question', () => {
    const quiz: Quiz = {
      id: 5,
      title: 'Q',
      questions: [
        q({
          id: 1,
          qType: 'single_choice',
          totalScore: 10,
          answers: [
            { id: 1, content: 'a', isCorrect: true },
            { id: 2, content: 'b', isCorrect: false },
          ],
        }),
        q({
          id: 2,
          qType: 'multiple_choice',
          totalScore: 10,
          answers: [
            { id: 3, content: 'a', isCorrect: true },
            { id: 4, content: 'b', isCorrect: true },
          ],
        }),
      ],
    } as Quiz;
    const answers: AttemptAnswers = {
      1: { kind: 'choice', answerIds: [1] }, // 10
      2: { kind: 'choice', answerIds: [3] }, // 5
    };
    const r = gradeQuiz(quiz, answers);
    expect(r.quizId).toBe(5);
    expect(r.earned).toBe(15);
    expect(r.max).toBe(20);
    expect(r.questions.map((x) => x.questionId)).toEqual([1, 2]);
  });

  it('quiz sans questions → 0/0, liste vide', () => {
    const r = gradeQuiz({ id: 1, title: 'Q' } as Quiz, {});
    expect(r).toEqual({ quizId: 1, earned: 0, max: 0, questions: [] });
  });

  it('arrondit les sommes au dixième (évite les artefacts flottants)', () => {
    // Deux questions donnant chacune 0.1 et 0.2 → somme 0.3 propre.
    const quiz: Quiz = {
      id: 2,
      title: 'Q',
      questions: [
        q({
          id: 1,
          qType: 'multiple_choice',
          totalScore: 1,
          answers: [
            { id: 1, content: 'a', isCorrect: true },
            { id: 2, content: 'b', isCorrect: true },
            { id: 3, content: 'c', isCorrect: true },
            { id: 4, content: 'd', isCorrect: true },
            { id: 5, content: 'e', isCorrect: true },
            { id: 6, content: 'f', isCorrect: true },
            { id: 7, content: 'g', isCorrect: true },
            { id: 8, content: 'h', isCorrect: true },
            { id: 9, content: 'i', isCorrect: true },
            { id: 10, content: 'j', isCorrect: true },
          ],
        }),
      ],
    } as Quiz;
    // 1 bonne sur 10 → 0.1 × 1 = 0.1
    const r = gradeQuiz(quiz, { 1: { kind: 'choice', answerIds: [1] } });
    expect(r.earned).toBe(0.1);
    expect(r.max).toBe(1);
  });

  it('question sans réponse dans l état → notée comme vide (0)', () => {
    const quiz: Quiz = {
      id: 3,
      title: 'Q',
      questions: [
        q({
          id: 1,
          qType: 'single_choice',
          totalScore: 5,
          answers: [{ id: 1, content: 'a', isCorrect: true }],
        }),
      ],
    } as Quiz;
    const r = gradeQuiz(quiz, {});
    expect(r.earned).toBe(0);
    expect(r.max).toBe(5);
  });
});
