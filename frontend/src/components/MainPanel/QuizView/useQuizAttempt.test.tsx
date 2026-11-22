import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQuizAttempt } from './useQuizAttempt';
import { isAnswered } from './quizAttempt';
import type { AttemptOutcome, AttemptSummary, QuizResult } from './quizAttempt';
import type { Quiz } from '../../../types/domain';

/**
 * Tests EXHAUSTIFS de useQuizAttempt : chargement/erreur/reload, ouverture summary vs taking,
 * navigation, saisie + touched, soumission async (voie WS ok/échec), repli mock, réconciliation
 * (polling + timeout), retry, selectAttempt/review, alreadySubmitted, reloadKeepingAnswers.
 */

const QUIZ_ID = 42;

function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: QUIZ_ID,
    title: 'Quiz',
    isPublished: true,
    isDaily: false,
    allowRetry: false,
    questions: [
      {
        id: 101, prompt: 'Un', qType: 'single_choice', qTypeId: 2, totalScore: 1,
        answers: [{ id: 1, content: 'A', isCorrect: true }, { id: 2, content: 'B' }],
      },
      {
        id: 102, prompt: 'Deux', qType: 'single_choice', qTypeId: 2, totalScore: 1,
        answers: [{ id: 3, content: 'C' }, { id: 4, content: 'D', isCorrect: true }],
      },
      {
        id: 103, prompt: 'Trois', qType: 'single_choice', qTypeId: 2, totalScore: 1,
        answers: [{ id: 5, content: 'E', isCorrect: true }, { id: 6, content: 'F' }],
      },
    ],
    ...overrides,
  } as unknown as Quiz;
}

const initialQuiz = makeQuiz();

function makeResult(attemptId: number, attemptNo = 1): QuizResult {
  return {
    quizId: QUIZ_ID, attemptId, attemptNo, earned: 2, max: 3,
    questions: [
      { questionId: 101, earned: 1, max: 1 },
      { questionId: 102, earned: 1, max: 1 },
      { questionId: 103, earned: 0, max: 1 },
    ],
  };
}

function summary(id: number, attemptNo = 1): AttemptSummary {
  return { id, attemptNo, earned: 2, max: 3 };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────── Chargement initial ─────────────────────────────

describe('chargement initial', () => {
  it('loading true au départ (avec onFetchQuiz), puis false et taking sans tentative', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts })
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.phase).toBe('taking');
    expect(result.current.loadError).toBeNull();
    expect(onFetchQuiz).toHaveBeenCalledWith(QUIZ_ID);
  });

  it('loadError quand onFetchQuiz throw, puis reload rétablit', async () => {
    let fail = true;
    const onFetchQuiz = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return makeQuiz();
    });
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, loadErrorMessage: 'ERR' })
    );
    await waitFor(() => expect(result.current.loadError).toBe('ERR'));
    expect(result.current.loading).toBe(false);

    fail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loadError).toBeNull());
    expect(result.current.phase).toBe('taking');
  });

  it('ouvre sur summary si onFetchAttempts renvoie une tentative (charge le résultat)', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [summary(7)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(7));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(onFetchAttemptResult).toHaveBeenCalledWith(QUIZ_ID, 7);
    expect(result.current.result?.attemptId).toBe(7);
    expect(result.current.currentAttemptId).toBe(7);
    expect(result.current.attempts).toHaveLength(1);
  });
});

// ───────────────────────────── Navigation ─────────────────────────────

describe('navigation', () => {
  async function taking() {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const h = renderHook(() => useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts }));
    await waitFor(() => expect(h.result.current.loading).toBe(false));
    return h;
  }

  it('goNext / goPrev bornés', async () => {
    const { result } = await taking();
    expect(result.current.currentIndex).toBe(0);
    act(() => result.current.goPrev());
    expect(result.current.currentIndex).toBe(0); // borné bas
    act(() => result.current.goNext());
    expect(result.current.currentIndex).toBe(1);
    act(() => result.current.goNext());
    act(() => result.current.goNext()); // au-delà de la dernière (index 2)
    expect(result.current.currentIndex).toBe(2); // borné haut (3 questions)
  });

  it('goTo borné', async () => {
    const { result } = await taking();
    act(() => result.current.goTo(1));
    expect(result.current.currentIndex).toBe(1);
    act(() => result.current.goTo(99));
    expect(result.current.currentIndex).toBe(2);
    act(() => result.current.goTo(-5));
    expect(result.current.currentIndex).toBe(0);
  });
});

// ───────────────────────────── Saisie + touched ─────────────────────────────

describe('setAnswer + touched', () => {
  it('marque la question touchée et isAnswered devient vrai', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.touched.has(101)).toBe(false);
    expect(isAnswered(result.current.answers[101])).toBe(false);

    act(() => result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }));

    expect(result.current.touched.has(101)).toBe(true);
    expect(isAnswered(result.current.answers[101])).toBe(true);
    expect(result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [1] });
  });
});

// ───────────────────────────── Submit async (voie WS) ─────────────────────────────

describe('submit asynchrone via WebSocket', () => {
  it('succès (ok:true) → summary + result via onFetchAttemptResult', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(55));
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 55 }));
    const outcome: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 55, ok: true };

    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult,
        onSubmitQuiz, attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { result.current.submit(); await Promise.resolve(); });

    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(55);
    expect(result.current.currentAttemptId).toBe(55);
    expect(result.current.submitError).toBeNull();
    expect(result.current.reconciling).toBe(false);
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
    // Marqueur « en vol » nettoyé.
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });

  it('échec (ok:false) → reste taking + submitError = codeVerificationUnavailableMessage', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 77 }));
    const outcome: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 77, ok: false };

    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onSubmitQuiz,
        attemptOutcome: outcome, codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { result.current.submit(); await Promise.resolve(); });

    await waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
    expect(result.current.phase).toBe('taking');
    expect(result.current.reconciling).toBe(false);
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });

  it('dismissSubmitError efface l\'erreur', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 77 }));
    const outcome: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 77, ok: false };
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onSubmitQuiz,
        attemptOutcome: outcome, codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
    act(() => result.current.dismissSubmitError());
    expect(result.current.submitError).toBeNull();
  });
});

// ───────────────────────────── Repli mock ─────────────────────────────

describe('repli mock (sans onSubmitQuiz)', () => {
  it('gradeQuiz local → summary immédiat', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }));
    await act(async () => { result.current.submit(); await Promise.resolve(); });

    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result).not.toBeNull();
    expect(result.current.result?.quizId).toBe(QUIZ_ID);
    // Q101 correcte (id 1) → 1 point.
    expect(result.current.result?.earned).toBe(1);
  });
});

// ───────────────────────────── Réconciliation (polling / timeout) ─────────────────────────────

describe('réconciliation via polling de secours', () => {
  it('l\'historique grandit → summary', async () => {
    vi.useFakeTimers();
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    let history: AttemptSummary[] = [];
    const onFetchAttempts = vi.fn(async () => history);
    const onFetchAttemptResult = vi.fn(async () => makeResult(9));
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 9 }));
    // Pas d'attemptOutcome → on force la voie polling.
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, onSubmitQuiz })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.submit(); });
    // Laisse partir le POST et entrer dans reconcilePending.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(result.current.reconciling).toBe(true));

    // La tentative apparaît côté serveur.
    history = [summary(9)];
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });

    await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(9);
    expect(result.current.reconciling).toBe(false);
    vi.useRealTimers();
  });

  it('jamais confirmé → timeout → submissionNotConfirmedMessage', async () => {
    vi.useFakeTimers();
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 9 }));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onSubmitQuiz,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(result.current.reconciling).toBe(true));

    // Avance au-delà du timeout (120s), historique jamais grandi.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    expect(result.current.phase).toBe('taking');
    expect(result.current.reconciling).toBe(false);
    vi.useRealTimers();
  });
});

// ───────────────────────────── retry ─────────────────────────────

describe('retry (allow_retry)', () => {
  it('remet en taking et vide result', async () => {
    const quiz = makeQuiz({ allowRetry: true });
    const onFetchQuiz = vi.fn(async () => quiz);
    const onFetchAttempts = vi.fn(async () => [summary(7)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(7));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz: quiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));

    act(() => result.current.retry());

    expect(result.current.phase).toBe('taking');
    expect(result.current.result).toBeNull();
    expect(result.current.currentAttemptId).toBeNull();
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.submitError).toBeNull();
  });
});

// ───────────────────────────── selectAttempt / review ─────────────────────────────

describe('selectAttempt + review', () => {
  it('selectAttempt charge le résultat d\'une tentative passée → summary', async () => {
    const quiz = makeQuiz({ allowRetry: true });
    const onFetchQuiz = vi.fn(async () => quiz);
    const onFetchAttempts = vi.fn(async () => [summary(1), summary(2, 2)]);
    const onFetchAttemptResult = vi.fn(async (_q: number, aid: number) => makeResult(aid, aid));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz: quiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    // Ouvre sur la dernière (id 2).
    expect(result.current.currentAttemptId).toBe(2);

    act(() => result.current.selectAttempt(1));
    await waitFor(() => expect(result.current.currentAttemptId).toBe(1));
    expect(result.current.phase).toBe('summary');
    expect(result.current.result?.attemptId).toBe(1);
  });

  it('reviewQuestion → phase review + index ; backToSummary revient', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [summary(7)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(7));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));

    act(() => result.current.reviewQuestion(2));
    expect(result.current.phase).toBe('review');
    expect(result.current.currentIndex).toBe(2);

    act(() => result.current.backToSummary());
    expect(result.current.phase).toBe('summary');
  });
});

// ───────────────────────────── alreadySubmitted ─────────────────────────────

describe('alreadySubmitted', () => {
  it('vrai quand !allowRetry et au moins une tentative', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz({ allowRetry: false }));
    const onFetchAttempts = vi.fn(async () => [summary(7)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(7));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.alreadySubmitted).toBe(true);
    expect(result.current.allowRetry).toBe(false);
  });

  it('faux quand allowRetry, même avec des tentatives', async () => {
    const quiz = makeQuiz({ allowRetry: true });
    const onFetchQuiz = vi.fn(async () => quiz);
    const onFetchAttempts = vi.fn(async () => [summary(7)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(7));
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz: quiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult })
    );
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.alreadySubmitted).toBe(false);
    expect(result.current.allowRetry).toBe(true);
  });
});

// ───────────────────────────── reloadKeepingAnswers ─────────────────────────────

describe('reloadKeepingAnswers', () => {
  it('recharge en fusionnant les réponses déjà saisies', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const { result } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }));
    act(() => result.current.goTo(2));

    act(() => result.current.reloadKeepingAnswers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Réponse conservée après fusion.
    expect(result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [1] });
    expect(result.current.touched.has(101)).toBe(true);
    expect(result.current.phase).toBe('taking');
    // currentIndex borné/conservé (2 valide avec 3 questions).
    expect(result.current.currentIndex).toBe(2);
  });
});

// ───────────────────────────── Tentative à revoir (#116) ─────────────────────────────

describe('tentative à revoir par l\'enseignant', () => {
  const review = (id: number, attemptNo = 1): AttemptSummary => ({
    id, attemptNo, earned: null, max: 3, status: 'review',
  });

  it('échec de raison « review » → tentative GARDÉE : message d\'attente, aucun corrigé chargé', async () => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([review(77)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(77));
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 77 }));
    const outcome: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 77, ok: false, reason: 'review' };

    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, onSubmitQuiz,
        attemptOutcome: outcome, codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.submit(); await Promise.resolve(); });

    await waitFor(() => expect(result.current.awaitingReview).toBe(true));
    expect(result.current.phase).toBe('summary');
    expect(result.current.result).toBeNull();
    expect(result.current.currentAttemptId).toBe(77);
    // Pas l'erreur « renvoyez » : la tentative est enregistrée, elle consomme la tentative unique.
    expect(result.current.submitError).toBeNull();
    expect(result.current.alreadySubmitted).toBe(true);
    expect(result.current.reconciling).toBe(false);
    expect(onFetchAttemptResult).not.toHaveBeenCalled();
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });

  it('rechargement avec une dernière tentative à revoir → message d\'attente directement', async () => {
    const onFetchAttemptResult = vi.fn(async () => makeResult(55));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts: vi.fn(async () => [summary(55), review(56, 2)]),
        onFetchAttemptResult,
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.awaitingReview).toBe(true);
    expect(result.current.phase).toBe('summary');
    expect(result.current.currentAttemptId).toBe(56);
    expect(onFetchAttemptResult).not.toHaveBeenCalled();

    // Une tentative corrigée choisie dans l'historique : retour au résumé normal…
    await act(async () => { result.current.selectAttempt(55); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(55));
    expect(result.current.awaitingReview).toBe(false);
    // … et la tentative à revoir, de nouveau : message, sans requête.
    act(() => result.current.selectAttempt(56));
    expect(result.current.awaitingReview).toBe(true);
    expect(result.current.result).toBeNull();
    expect(onFetchAttemptResult).toHaveBeenCalledTimes(1);
  });

  it('relance réussie par l’enseignant : le verdict poussé recharge et ouvre le résumé', async () => {
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56)])
      .mockResolvedValue([summary(56)]);
    const onFetchAttemptResult = vi.fn(async () => makeResult(56));
    let outcome: AttemptOutcome | null = null;
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz: vi.fn(async () => makeQuiz()), onFetchAttempts,
        onFetchAttemptResult, attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.awaitingReview).toBe(true));

    // Verdict d'une AUTRE tentative : ignoré.
    outcome = { quizId: QUIZ_ID, attemptId: 99, ok: true };
    rerender();
    expect(onFetchAttempts).toHaveBeenCalledTimes(1);

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(56));
    expect(result.current.awaitingReview).toBe(false);
    expect(result.current.phase).toBe('summary');
  });

  it('quiz avec reprise : « refaire » quitte le message d\'attente', async () => {
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [review(56)]),
      })
    );
    await waitFor(() => expect(result.current.awaitingReview).toBe(true));
    expect(result.current.alreadySubmitted).toBe(false);

    act(() => result.current.retry());

    expect(result.current.awaitingReview).toBe(false);
    expect(result.current.phase).toBe('taking');
  });
});
