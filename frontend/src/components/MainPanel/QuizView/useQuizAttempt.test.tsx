import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQuizAttempt } from './useQuizAttempt';
import { isAnswered, SubmissionInProgressError, SubmissionRejectedError } from './quizAttempt';
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

describe('submit refusé par le serveur', () => {
  it.each([
    ['400 motivé → message du serveur, refus', new SubmissionRejectedError('Question 2 : code trop long.'),
      'Question 2 : code trop long.', true],
    ['400 sans message → message de refus', new SubmissionRejectedError(''), 'REFUSE', true],
    ['413 du gateway → libellé « trop volumineux »', new SubmissionRejectedError('', 'tooLarge'),
      'TROP_GROS', true],
    ['autre échec (réseau, 5xx) → message générique, pas un refus', new Error('boom'), 'POST_KO', false],
    // 409 « tentative déjà soumise » (corps texte) : dashboardApi le rend en échec ordinaire.
    ['409 déjà soumis → message générique, aucune attente', new Error('Échec de la soumission du quiz'),
      'POST_KO', false],
  ])('%s, rien en vol', async (_case, error, expected, rejected) => {
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onSubmitQuiz = vi.fn(async () => {
      throw error;
    });
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onSubmitQuiz, submitErrorMessage: 'POST_KO',
        submitRejectedMessage: 'REFUSE', submitTooLargeMessage: 'TROP_GROS',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => { await result.current.submit(); });

    expect(result.current.submitError).toBe(expected);
    expect(result.current.submitRejected).toBe(rejected);
    expect(result.current.reconciling).toBe(false);
    // Fermer le popup efface aussi le refus.
    act(() => result.current.dismissSubmitError());
    expect(result.current.submitError).toBeNull();
    expect(result.current.submitRejected).toBe(false);
    expect(result.current.phase).toBe('taking');
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });
});

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

  it('correction de plus de 2 min : pas d’échec à 120 s, le résultat finit par s’afficher', async () => {
    // Revue #246 : le client concluait à un échec à 120 s, alors que la correction côté serveur
    // pouvait encore tourner (file, harnais un par un, mur des compilés de 15 min).
    vi.useFakeTimers();
    let history: AttemptSummary[] = [];
    const onFetchAttempts = vi.fn(async () => history);
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz: vi.fn(async () => makeQuiz()), onFetchAttempts,
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(result.current.reconciling).toBe(true));

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(result.current.submitError).toBeNull();
    expect(result.current.reconciling).toBe(true);

    // La correction aboutit après 5 min : le sondage (lent) la trouve.
    history = [summary(9)];
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(9);
    expect(result.current.submitError).toBeNull();
    vi.useRealTimers();
  });

  it('sondage en échec (réseau) pendant l’attente : transitoire, l’attente continue', async () => {
    vi.useFakeTimers();
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValue([summary(9)]);
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz: vi.fn(async () => makeQuiz()), onFetchAttempts,
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(result.current.submitError).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.submitError).toBeNull();
    vi.useRealTimers();
  });

  // Quiz AVEC reprise : `reload` n'y jette pas le brouillon de lui-même (seule une tentative
  // unique consommée le fait) ; c'est donc settleLateOutcome qui doit le jeter avant de recharger.
  it.each([
    ['corrigée (ok)', { ok: true }, summary(9)],
    ['gardée à revoir (review)', { ok: false, reason: 'review' }, { ...summary(9), earned: null, status: 'review' }],
    ['en échec (supprimée)', { ok: false }, null],
  ] as const)(
    'plafond (30 min) sans verdict → « non confirmée », puis verdict tardif %s consommé',
    async (_case, verdict, landed) => {
      vi.useFakeTimers();
      let history: AttemptSummary[] = [];
      let outcome: AttemptOutcome | null = null;
      const { result, rerender } = renderHook(() =>
        useQuizAttempt({
          initialQuiz,
          onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
          onFetchAttempts: vi.fn(async () => history),
          onFetchAttemptResult: vi.fn(async () => makeResult(9)),
          onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
          attemptOutcome: outcome,
          submissionNotConfirmedMessage: 'NOT_CONFIRMED',
          codeVerificationUnavailableMessage: 'CODE_KO',
        })
      );
      await vi.waitFor(() => expect(result.current.loading).toBe(false));
      act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
      act(() => { result.current.submit(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      await act(async () => { await vi.advanceTimersByTimeAsync(29 * 60_000); });
      expect(result.current.submitError).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
      await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
      expect(result.current.phase).toBe('taking');
      expect(result.current.reconciling).toBe(false);
      // Le brouillon de passation est toujours là (réponses restaurées pour un renvoi).
      expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).not.toBeNull();

      // La correction finit enfin : son verdict poussé est consommé.
      if (landed) history = [landed];
      outcome = { quizId: QUIZ_ID, attemptId: 9, ...verdict };
      rerender();
      if (!landed) {
        // Tentative supprimée : message de vérification impossible, on reste en passation.
        await vi.waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
        expect(result.current.phase).toBe('taking');
      } else {
        // Brouillon jeté, tentative ouverte : résumé, ou message « à revoir ».
        await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
        expect(result.current.currentAttemptId).toBe(9);
        expect(result.current.awaitingReview).toBe(verdict.ok ? false : true);
        if (verdict.ok) expect(result.current.result?.attemptId).toBe(9);
        expect(result.current.submitError).toBeNull();
        expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).toBeNull();
      }
      vi.useRealTimers();
    }
  );

  it('renvoi refusé en 409 (correction déjà en cours) → attente, puis verdict de cette correction', async () => {
    // Temps simulé, et un historique qui ne montre JAMAIS la tentative en correction : seul son
    // verdict poussé peut conclure (aucun sondage n'a lieu avant).
    vi.useFakeTimers();
    let outcome: AttemptOutcome | null = null;
    const onFetchAttempts = vi.fn(async () => [summary(5)]);
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          throw new SubmissionInProgressError();
        }),
        attemptOutcome: outcome,
        submitErrorMessage: 'POST_KO',
      })
    );
    await vi.waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    const callsBefore = onFetchAttempts.mock.calls.length;

    await act(async () => { result.current.submit(); await vi.advanceTimersByTimeAsync(0); });
    // Pas d'échec affiché : la vue attend la correction déjà en cours.
    expect(result.current.submitError).toBeNull();
    expect(result.current.reconciling).toBe(true);

    // Un verdict d'une tentative DÉJÀ connue (#5) n'est pas celui attendu…
    outcome = { quizId: QUIZ_ID, attemptId: 5, ok: true };
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(result.current.phase).toBe('taking');
    expect(result.current.reconciling).toBe(true);
    // … celui de la tentative en correction (#6, id inconnu jusque-là) ouvre son résumé.
    outcome = { quizId: QUIZ_ID, attemptId: 6, ok: true };
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    await vi.waitFor(() => expect(result.current.result?.attemptId).toBe(6));
    expect(result.current.phase).toBe('summary');
    expect(result.current.submitError).toBeNull();
    // Aucun sondage (premier prévu à 1,5 s) : seule la lecture du résumé a relu l'historique.
    expect(onFetchAttempts.mock.calls.length).toBe(callsBefore + 1);
    vi.useRealTimers();
  });

  it('409 « relance » (recorrection par l’enseignant) → message dédié, refus, pas d’attente, brouillon gardé', async () => {
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        onSubmitQuiz: vi.fn(async () => {
          throw new SubmissionRejectedError('', 'regrading');
        }),
        submitRegradingMessage: 'RELANCE',
        submitErrorMessage: 'POST_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    await act(async () => { await result.current.submit(); });
    expect(result.current.submitError).toBe('RELANCE');
    expect(result.current.submitRejected).toBe(true);
    expect(result.current.reconciling).toBe(false);
    expect(result.current.phase).toBe('taking');
    expect(result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [1] });
    expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).not.toBeNull();
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });

  it('marqueur « en vol » écrit AVANT le POST : il porte les tentatives déjà connues', async () => {
    // Vue démontée pendant le POST (changement de canal) : le marqueur reste sans id de
    // tentative ; sans la liste des tentatives connues, n'importe quel verdict le concluait.
    const { result, unmount } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [summary(10)]),
        onFetchAttemptResult: vi.fn(async () => makeResult(10)),
        onSubmitQuiz: vi.fn(() => new Promise<{ attemptId: number }>(() => {})),
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(10));
    act(() => result.current.retry());
    act(() => { void result.current.submit(); });
    unmount();
    const marker = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
    expect(marker.attemptId).toBeUndefined();
    expect(marker.knownAttemptIds).toEqual([10]);
  });

  it('marqueur sans id ni tentatives connues (ancien format) : aucun verdict poussé ne le conclut', async () => {
    // On ne sait pas distinguer la nouvelle tentative d'une ancienne : seul l'historique conclut.
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 1 })
    );
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [summary(10)];
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    // Un verdict reçu APRÈS le montage (ex. relance d'une ancienne tentative) : pas le sien.
    outcome = { quizId: QUIZ_ID, attemptId: 10, ok: true };
    rerender();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(result.current.phase).toBe('taking');
    expect(result.current.reconciling).toBe(true);
    history = [summary(10), summary(11, 2)];
    await waitFor(() => expect(result.current.result?.attemptId).toBe(11), { timeout: 3000 });
  });

  it.each([
    // Ancien format (ni id ni tentatives connues).
    ['marqueur sans id ni tentatives connues', { attemptsBefore: 1 }],
    // Tentatives connues, mais le verdict présent au montage est celui d'AVANT l'envoi.
    ['verdict déjà présent au montage', { attemptsBefore: 1, knownAttemptIds: [] }],
  ])('remontage pendant une correction (%s) : le verdict d’avant ne conclut pas', async (_case, marker) => {
    // Tentative #1 (id 10) corrigée ; « Refaire », envoi, changement de canal pendant le POST,
    // retour : le Dashboard garde le dernier verdict reçu, celui de #1.
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, ...marker })
    );
    let outcome: AttemptOutcome | null = { quizId: QUIZ_ID, attemptId: 10, ok: true };
    let history: AttemptSummary[] = [summary(10)];
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(result.current.phase).toBe('taking');
    expect(result.current.reconciling).toBe(true);

    // La nouvelle tentative (#2, id 11) apparaît : le sondage l'ouvre.
    history = [summary(10), summary(11, 2)];
    outcome = null;
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(11), { timeout: 3000 });
  });

  it('second envoi pendant l’envoi ou l’attente de la correction : ignoré', async () => {
    let resolvePost!: (v: { attemptId: number }) => void;
    const onSubmitQuiz = vi.fn(() => new Promise<{ attemptId: number }>((r) => { resolvePost = r; }));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        onSubmitQuiz,
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.submit(); });
    act(() => { void result.current.submit(); }); // pendant le POST
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
    await act(async () => { resolvePost({ attemptId: 9 }); });
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    act(() => { void result.current.submit(); }); // pendant l'attente de la correction
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!).attemptId).toBe(9);
  });

  it('verdict arrivé pendant la DERNIÈRE lecture avant le plafond : consommé, pas « non confirmée »', async () => {
    vi.useFakeTimers();
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    let releaseLastPoll!: (h: AttemptSummary[]) => void;
    const onFetchAttempts = vi.fn(async () => history);
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
        attemptOutcome: outcome,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // Juste avant le plafond, le prochain sondage reste en vol…
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60_000 - 10_000); });
    onFetchAttempts.mockImplementationOnce(() => new Promise((r) => { releaseLastPoll = r; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(releaseLastPoll).toBeDefined();
    // … le verdict arrive pendant cette lecture, puis elle répond (plafond dépassé).
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    history = [summary(9)];
    await act(async () => { releaseLastPoll([]); await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(9);
    expect(result.current.submitError).toBeNull();
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

  it('relance réussie de la tentative affichée, qui n\'est pas la dernière : son résultat reste affiché', async () => {
    // Revue #246 : `reload` ouvrait la DERNIÈRE tentative (#57), pas celle que l'étudiant
    // regardait (#56).
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56), summary(57, 2)])
      .mockResolvedValue([summary(56), summary(57, 2)]);
    const onFetchAttemptResult = vi.fn(async (_q: number, id: number) => makeResult(id));
    // Espion STABLE (un `vi.fn` en ligne serait recréé à chaque rendu et ne compterait rien).
    const onFetchQuiz = vi.fn(async () => makeQuiz({ allowRetry: true }));
    let outcome: AttemptOutcome | null = null;
    // `loading` relevé à CHAQUE rendu : sa valeur finale (faux) ne dit pas s'il est passé à vrai.
    const loadingSeen: boolean[] = [];
    const { result, rerender } = renderHook(() => {
      const api = useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, attemptOutcome: outcome,
      });
      loadingSeen.push(api.loading);
      return api;
    });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(57));
    act(() => result.current.selectAttempt(56));
    expect(result.current.awaitingReview).toBe(true);
    loadingSeen.length = 0;

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(56));
    expect(result.current.currentAttemptId).toBe(56);
    expect(result.current.awaitingReview).toBe(false);
    expect(result.current.phase).toBe('summary');
    expect(result.current.attempts.find((a) => a.id === 56)?.status).not.toBe('review');
    // Sans écran de chargement (la barre et le focus restent en place) ni rechargement du quiz.
    expect(loadingSeen.length).toBeGreaterThan(0);
    expect(loadingSeen).not.toContain(true);
    expect(onFetchQuiz).toHaveBeenCalledTimes(1);
  });

  it('relance réussie pendant laquelle l’étudiant change de vue : son choix n’est pas écrasé', async () => {
    // Revue #246 : les deux lectures déclenchées par le verdict sont asynchrones ; si l'étudiant
    // passe à une autre tentative entre-temps, leur résultat ne doit pas le ramener en arrière.
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56), summary(57, 2)])
      .mockResolvedValue([summary(56), summary(57, 2)]);
    let release56!: () => void;
    const onFetchAttemptResult = vi.fn((_q: number, id: number) =>
      id === 56
        ? new Promise<ReturnType<typeof makeResult>>((res) => { release56 = () => res(makeResult(56)); })
        : Promise.resolve(makeResult(id))
    );
    let outcome: AttemptOutcome | null = null;
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz, onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })), onFetchAttempts,
        onFetchAttemptResult, attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(57));
    act(() => result.current.selectAttempt(56));
    expect(result.current.awaitingReview).toBe(true);

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() => expect(onFetchAttemptResult).toHaveBeenCalledWith(QUIZ_ID, 56));
    // L'étudiant revient à #57 avant la fin des lectures.
    await act(async () => { await result.current.selectAttempt(57); });
    expect(result.current.currentAttemptId).toBe(57);
    await act(async () => { release56(); });
    expect(result.current.currentAttemptId).toBe(57);
    expect(result.current.result?.attemptId).toBe(57);
  });

  it('relance réussie, lecture en échec APRÈS un changement de vue : pas de rechargement en repli', async () => {
    // Le repli (`reload`) ne vaut que si la tentative relancée est toujours affichée : sinon il
    // rechargerait tout l'écran (chargement, focus perdu) sous les yeux de l'étudiant.
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56), summary(57, 2)])
      .mockResolvedValue([summary(56), summary(57, 2)]);
    let fail56!: () => void;
    const onFetchAttemptResult = vi.fn((_q: number, id: number) =>
      id === 56
        ? new Promise<ReturnType<typeof makeResult>>((_res, rej) => { fail56 = () => rej(new Error('503')); })
        : Promise.resolve(makeResult(id))
    );
    // Espion STABLE : chaque rechargement relit le quiz.
    const onFetchQuiz = vi.fn(async () => makeQuiz({ allowRetry: true }));
    let outcome: AttemptOutcome | null = null;
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, attemptOutcome: outcome })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(57));
    act(() => result.current.selectAttempt(56));
    expect(result.current.awaitingReview).toBe(true);

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() => expect(onFetchAttemptResult).toHaveBeenCalledWith(QUIZ_ID, 56));
    // L'étudiant revient à #57 avant l'échec de la lecture.
    await act(async () => { await result.current.selectAttempt(57); });
    await act(async () => { fail56(); });
    expect(onFetchQuiz).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.currentAttemptId).toBe(57);
    expect(result.current.result?.attemptId).toBe(57);
  });

  it('relance réussie, résultat illisible : rechargement complet en repli', async () => {
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56)])
      .mockResolvedValue([summary(56)]);
    const onFetchAttemptResult = vi
      .fn<(quizId: number, attemptId: number) => Promise<ReturnType<typeof makeResult>>>()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValue(makeResult(56));
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    let outcome: AttemptOutcome | null = null;
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({ initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, attemptOutcome: outcome })
    );
    await waitFor(() => expect(result.current.awaitingReview).toBe(true));

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(56));
    expect(onFetchQuiz).toHaveBeenCalledTimes(2);
  });

  it('relance réussie d\'une AUTRE tentative que celle affichée : seule la barre se met à jour', async () => {
    // Quiz avec reprise : #56 à revoir, #57 corrigée et affichée. L'enseignant relance #56.
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([review(56), summary(57, 2)])
      .mockResolvedValue([summary(56), summary(57, 2)]);
    const onFetchAttemptResult = vi.fn(async (_q: number, id: number) => makeResult(id));
    // Espion STABLE (un `vi.fn` en ligne serait recréé à chaque rendu et ne compterait rien).
    const onFetchQuiz = vi.fn(async () => makeQuiz({ allowRetry: true }));
    let outcome: AttemptOutcome | null = null;
    // `loading` relevé à CHAQUE rendu : sa valeur finale (faux) ne dit pas s'il est passé à vrai.
    const loadingSeen: boolean[] = [];
    const { result, rerender } = renderHook(() => {
      const api = useQuizAttempt({
        initialQuiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, attemptOutcome: outcome,
      });
      loadingSeen.push(api.loading);
      return api;
    });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(57));
    expect(result.current.attempts.find((a) => a.id === 56)?.status).toBe('review');
    loadingSeen.length = 0;

    outcome = { quizId: QUIZ_ID, attemptId: 56, ok: true };
    rerender();
    await waitFor(() =>
      expect(result.current.attempts.find((a) => a.id === 56)?.status).not.toBe('review')
    );
    // La vue reste sur #57 : pas de rechargement complet (ni relecture du quiz, ni écran de
    // chargement, ni relecture du corrigé affiché) ; seule la liste est relue.
    expect(result.current.result?.attemptId).toBe(57);
    expect(onFetchAttempts).toHaveBeenCalledTimes(2);
    expect(onFetchQuiz).toHaveBeenCalledTimes(1);
    expect(onFetchAttemptResult).toHaveBeenCalledTimes(1);
    expect(loadingSeen.length).toBeGreaterThan(0);
    expect(loadingSeen).not.toContain(true);
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
