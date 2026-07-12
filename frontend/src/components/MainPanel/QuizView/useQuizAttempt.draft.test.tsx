import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQuizAttempt } from './useQuizAttempt';
import type { Quiz } from '../../../types/domain';

/**
 * Régression : le brouillon de passation doit survivre à un rechargement/réouverture MÊME
 * quand l'id du quiz FETCHÉ diffère de l'id de la REQUÊTE (cas quiz du jour / normalisation de
 * canal). La clé localStorage doit être dérivée d'un id STABLE et identique à l'écriture et à
 * la lecture — sinon on sauvegarde sous une clé et on relit sous une autre (bug observé en prod).
 */

// L'id de la REQUÊTE (canal) est 42 ; le quiz renvoyé par le backend porte un id DIFFÉRENT (999).
const REQUEST_ID = 42;
const fetchedQuiz: Quiz = {
  id: 999, // ← volontairement différent de REQUEST_ID
  title: 'Quiz', isPublished: true, isDaily: true, allowRetry: false,
  questions: [
    { id: 101, prompt: 'Un', qType: 'single_choice', qTypeId: 2, totalScore: 1,
      answers: [{ id: 1, content: 'A' }, { id: 2, content: 'B' }] },
    { id: 102, prompt: 'Deux', qType: 'single_choice', qTypeId: 2, totalScore: 1,
      answers: [{ id: 3, content: 'C' }, { id: 4, content: 'D' }] },
  ],
} as unknown as Quiz;

// initialQuiz = le repli fabriqué par QuizView : id = celui du canal (REQUEST_ID), questions du mock.
const initialQuiz = { ...fetchedQuiz, id: REQUEST_ID } as Quiz;

const onFetchQuiz = vi.fn(async () => fetchedQuiz);
const onFetchAttempts = vi.fn(async () => []);

beforeEach(() => {
  localStorage.clear();
  onFetchQuiz.mockClear();
  onFetchAttempts.mockClear();
});

function mount() {
  return renderHook(() => useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts }));
}

describe('brouillon de passation — clé cohérente', () => {
  it('sauvegarde et restaure même quand fetched.id ≠ requête.id', async () => {
    const first = mount();
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    act(() => first.result.current.setAnswer(101, { kind: 'choice', answerIds: [2] }));
    act(() => first.result.current.goTo(1));

    // La clé DOIT être dérivée de l'id de requête (42), pas de l'id fetché (999).
    await waitFor(() => expect(localStorage.getItem(`moodit:quiz-draft:${REQUEST_ID}`)).toBeTruthy());
    expect(localStorage.getItem('moodit:quiz-draft:999')).toBeNull();

    first.unmount();

    // Réouverture.
    const second = mount();
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await act(async () => { await Promise.resolve(); });

    expect(second.result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [2] });
    expect(second.result.current.currentIndex).toBe(1);
  });
});

describe('refresh après une soumission ABOUTIE (quiz avec reprise)', () => {
  const retryQuiz = { ...fetchedQuiz, id: REQUEST_ID, allowRetry: true } as Quiz;

  it('ouvre le RÉSUMÉ (pas le brouillon) et jette le brouillon', async () => {
    // Brouillon + marqueur « en vol » présents (soumission lancée puis refresh), MAIS l'historique
    // contient déjà la tentative → elle a abouti pendant le refresh.
    localStorage.setItem(
      `moodit:quiz-draft:${REQUEST_ID}`,
      JSON.stringify({ answers: { 101: { kind: 'choice', answerIds: [2] } }, touched: [101], currentIndex: 1 })
    );
    localStorage.setItem(
      `moodit:quiz-pending-submission:${REQUEST_ID}`,
      JSON.stringify({ answers: { 101: { kind: 'choice', answerIds: [2] } }, attemptsBefore: 0, attemptId: 7 })
    );
    const fetchRetry = vi.fn(async () => retryQuiz);
    const attemptsGrown = vi.fn(async () => [{ id: 7, attemptNo: 1, earned: 1, max: 2 }]);
    const attemptResult = vi.fn(async () => ({
      quizId: REQUEST_ID, attemptId: 7, attemptNo: 1, earned: 1, max: 2, questions: [],
    }));

    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz: retryQuiz,
        onFetchQuiz: fetchRetry,
        onFetchAttempts: attemptsGrown,
        onFetchAttemptResult: attemptResult,
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await Promise.resolve(); });

    // Résumé de la tentative aboutie — surtout PAS la passation avec le brouillon restauré.
    expect(result.current.phase).toBe('summary');
    expect(result.current.result?.attemptId).toBe(7);
    // Le brouillon obsolète a été jeté.
    expect(localStorage.getItem(`moodit:quiz-draft:${REQUEST_ID}`)).toBeNull();
  });
});
