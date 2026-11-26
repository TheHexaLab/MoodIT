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
    // 409 « tentative déjà soumise » (corps texte) : refus définitif, message dédié.
    ['409 déjà soumis → message dédié, refus, aucune attente',
      new SubmissionRejectedError('', 'alreadySubmitted'), 'DEJA', true],
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
        submitAlreadySubmittedMessage: 'DEJA',
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

describe('submit refusé : déjà soumis', () => {
  it('409 « déjà soumis » (autre onglet) → message, puis le résumé de la tentative consommée', async () => {
    // L'historique, lu au montage, était vide ; l'autre onglet a depuis soumis et été corrigé.
    const onFetchAttempts = vi
      .fn<(quizId: number) => Promise<AttemptSummary[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([summary(7)]);
    const onSubmitQuiz = vi.fn(async () => {
      throw new SubmissionRejectedError('', 'alreadySubmitted');
    });
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async () => makeResult(7)),
        onSubmitQuiz,
        submitAlreadySubmittedMessage: 'DEJA',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    await act(async () => { await result.current.submit(); });
    expect(result.current.submitError).toBe('DEJA');
    expect(result.current.submitRejected).toBe(true);
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(7);
    expect(result.current.alreadySubmitted).toBe(true);
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).toBeNull();
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

  // Quiz AVEC reprise. Le marqueur, gardé au plafond, fait jeter le brouillon par `reload` quand
  // la tentative apparaît ; le cas SANS marqueur (où settleLateOutcome doit le jeter lui-même)
  // est couvert par le test « verdict tardif sans marqueur » plus bas.
  it.each([
    ['corrigée (ok)', { ok: true }, summary(9)],
    ['gardée à revoir (review)', { ok: false, reason: 'review' }, { ...summary(9), earned: null, status: 'review' }],
    ['en échec (supprimée)', { ok: false }, null],
  ] as const)(
    'plafond (45 min) sans verdict → « non confirmée », puis verdict tardif %s consommé',
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

      // Toujours en attente à 44 min (au-delà de l'ancien plafond de 30 min)…
      await act(async () => { await vi.advanceTimersByTimeAsync(44 * 60_000); });
      expect(result.current.submitError).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
      await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
      expect(result.current.phase).toBe('taking');
      expect(result.current.reconciling).toBe(false);
      // Le brouillon de passation est toujours là (réponses restaurées pour un renvoi), et le
      // marqueur aussi (gardé au plafond).
      expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).not.toBeNull();
      expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).not.toBeNull();

      // La correction finit enfin : son verdict poussé est consommé.
      if (landed) history = [landed];
      outcome = { quizId: QUIZ_ID, attemptId: 9, ...verdict };
      rerender();
      if (!landed) {
        // Tentative supprimée : message de vérification impossible, on reste en passation, et le
        // marqueur n'attend plus rien (sinon un remontage relançait une attente vaine).
        await vi.waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
        expect(result.current.phase).toBe('taking');
        expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
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

  it('verdict tardif SANS marqueur (expiré au montage) : le brouillon touché depuis est jeté, le résumé s’ouvre', async () => {
    // Marqueur expiré au montage : effacé aussitôt. L'étudiant retouche ses réponses (brouillon),
    // puis le verdict arrive : sans marqueur, `reload` restaurerait ce brouillon (quiz avec
    // reprise) — c'est settleLateOutcome qui doit le jeter.
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 })
    );
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        attemptOutcome: outcome,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    await waitFor(() => expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).not.toBeNull());

    history = [summary(9)];
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    await waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(9);
    expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).toBeNull();
  });

  it.each([
    // Relecture illisible juste après le 409 : seule la liste de la vue (#5) sert.
    ['en échec : liste de la vue seule', true],
    // Relecture réussie : elle ne sert qu'à reconnaître la tentative dans l'historique.
    ['réussie : historique relu à part', false],
  ])('409 « en_cours » sans id, relecture de l’historique %s ; verdicts comparés à la liste d’avant + dernier verdict vu', async (_case, readFails) => {
    // #12 = dernier verdict vu (tentative supprimée, absente de l'historique) : tentative connue.
    const stale: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 12, ok: false };
    let outcome: AttemptOutcome | null = stale;
    let failNext = false;
    const onFetchAttempts = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error('réseau');
      }
      return [summary(5)];
    });
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          failNext = readFails;
          throw new SubmissionInProgressError();
        }),
        attemptOutcome: outcome,
        codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    const marker = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
    expect(marker.knownAttemptIds).toEqual([5, 12]);
    expect(marker.landedKnownIds).toEqual(readFails ? undefined : [5]);

    // Le dernier verdict vu (#12, toujours présenté) ne conclut pas ; celui d'une autre tentative, si.
    outcome = { ...stale };
    rerender();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(result.current.reconciling).toBe(true);
    expect(result.current.submitError).toBeNull();
    outcome = { quizId: QUIZ_ID, attemptId: 6, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(6));
  });

  it('409 « en_cours » AVEC id : conclut sur cette tentative, même déjà dans l’historique relu', async () => {
    // La correction concurrente (#6) a fini avant toute relecture, et aucun verdict n'arrive :
    // seul son id (donné par core) permet de la reconnaître dans l'historique.
    let history: AttemptSummary[] = [summary(5)];
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          history = [summary(5), summary(6, 2)];
          throw new SubmissionInProgressError(6);
        }),
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    expect(JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!).attemptId).toBe(6);
    await waitFor(() => expect(result.current.result?.attemptId).toBe(6), { timeout: 3000 });
  });

  it('409 « en_cours » SANS id, correction finie avant la relecture : son verdict poussé conclut', async () => {
    // La relecture voit déjà #6 ; comparé à elle, son verdict serait ignoré (45 min de voile).
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [summary(5)];
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          history = [summary(5), summary(6, 2)];
          throw new SubmissionInProgressError();
        }),
        attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    outcome = { quizId: QUIZ_ID, attemptId: 6, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(6));
  });

  it('deux onglets (marqueur partagé) : le second reçoit un 409 « en_cours » avec l’id du premier, tous deux concluent', async () => {
    // Aucun verdict poussé (WS manqué) : chacun reconnaît #9 dans l'historique par son id.
    let history: AttemptSummary[] = [];
    const common = {
      initialQuiz,
      onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
      onFetchAttempts: vi.fn(async () => history),
      onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
    };
    const tabA = renderHook(() =>
      useQuizAttempt({ ...common, onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })) })
    );
    const tabB = renderHook(() =>
      useQuizAttempt({
        ...common,
        onSubmitQuiz: vi.fn(async () => {
          // La correction de #9 (onglet A) finit pendant le POST de B.
          history = [summary(9)];
          throw new SubmissionInProgressError(9);
        }),
      })
    );
    await waitFor(() => expect(tabA.result.current.loading).toBe(false));
    await waitFor(() => expect(tabB.result.current.loading).toBe(false));
    await act(async () => { tabA.result.current.submit(); await Promise.resolve(); });
    await act(async () => { tabB.result.current.submit(); await Promise.resolve(); });
    expect(JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!).attemptId).toBe(9);
    await waitFor(() => expect(tabA.result.current.result?.attemptId).toBe(9), { timeout: 3000 });
    await waitFor(() => expect(tabB.result.current.result?.attemptId).toBe(9), { timeout: 3000 });
  });

  it('« Réessayer » (id #9 attendu) puis 409 « en_cours » sans id : l’id de la soumission attendue est gardé', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 })
    );
    let history: AttemptSummary[] = [];
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          // #9 finit pendant ce POST : la relecture qui suivrait la verrait déjà.
          history = [summary(9)];
          throw new SubmissionInProgressError();
        }),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    expect(JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!).attemptId).toBe(9);
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9), { timeout: 3000 });
  });

  it('« Réessayer » puis POST en échec (réseau) : la soumission d’origine reste attendue (marqueur et verdict tardif)', async () => {
    const original = { answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 };
    localStorage.setItem(`moodit:quiz-pending-submission:${QUIZ_ID}`, JSON.stringify(original));
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          throw new Error('réseau');
        }),
        attemptOutcome: outcome,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
        submitErrorMessage: 'POST_KO',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    // L'étudiant retouche une réponse avant de réessayer.
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [2] }); });
    await act(async () => { await result.current.submit(); });
    expect(result.current.submitError).toBe('POST_KO');
    // Marqueur rétabli (un rechargement réconcilierait encore la soumission d'origine), avec les
    // réponses COURANTES : au remontage, il ne doit pas remettre les anciennes.
    const marker = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
    expect(marker.attemptId).toBe(9);
    expect(marker.submittedAt).toBe(original.submittedAt);
    expect(marker.answers[101]).toEqual({ kind: 'choice', answerIds: [2] });
    // Et son verdict, s'il arrive, est encore consommé.
    history = [summary(9)];
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9));
  });

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
    // Aucun sondage (premier prévu à 1,5 s) : seules la relecture au 409 (liste peut-être
    // périmée) et la lecture du résumé ont relu l'historique.
    expect(onFetchAttempts.mock.calls.length).toBe(callsBefore + 2);
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

  it('marqueur sans id ni tentatives connues : aucun verdict poussé ne le conclut', async () => {
    // On ne sait pas distinguer la nouvelle tentative d'une ancienne : seul l'historique conclut.
    // (Daté : un marqueur sans date est tenu pour expiré, cf. le test suivant.)
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 1, submittedAt: Date.now() })
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
    // Ancien format (écrit par la version précédente), âge inconnu : tenu pour expiré. Les 45 min
    // complètes relançaient, à chaque retour, l'attente d'une tentative peut-être supprimée.
    ['sans date (ancien format) → « non confirmée » tout de suite', undefined, false],
    // Horloge qui a reculé : ramené à maintenant, l'attente dure le plafond et pas davantage.
    ['daté dans le futur → 45 min depuis maintenant', 24 * 3_600_000, true],
  ])('marqueur %s', async (_case, ahead, waits) => {
    vi.useFakeTimers();
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({
        answers: {}, attemptsBefore: 0, attemptId: 9,
        ...(ahead === undefined ? {} : { submittedAt: Date.now() + ahead }),
      })
    );
    const params = {
      initialQuiz,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
      submissionNotConfirmedMessage: 'NOT_CONFIRMED',
    };
    const { result, unmount } = renderHook(() => useQuizAttempt(params));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    if (waits) {
      // Date ramenée à maintenant, et RÉÉCRITE dans le marqueur (sinon chaque retour relançait
      // 45 min depuis la date future).
      const stored = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
      expect(stored.submittedAt).toBeLessThanOrEqual(Date.now());
      // Toujours en attente à 44 min 30 s (ni expiré, ni conclu)…
      await act(async () => { await vi.advanceTimersByTimeAsync(44 * 60_000 + 30_000); });
      expect(result.current.reconciling).toBe(true);
      expect(result.current.submitError).toBeNull();
      // … conclu peu après les 45 min (dernier sondage lent compris).
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }
    await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    expect(result.current.reconciling).toBe(false);
    // Expiré dès le montage : marqueur effacé, rien ne relancera cette attente. Expiré PENDANT
    // l'attente : gardé, pour qu'un remontage ouvre le résultat plutôt que la passation.
    const marker = localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`);
    if (waits) expect(marker).not.toBeNull();
    else expect(marker).toBeNull();
    if (waits) {
      // Remontage après le plafond : l'attente conclut aussitôt (marqueur expiré, puis effacé).
      unmount();
      const again = renderHook(() => useQuizAttempt(params));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await vi.waitFor(() => expect(again.result.current.submitError).toBe('NOT_CONFIRMED'));
      expect(again.result.current.reconciling).toBe(false);
      expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
    }
    vi.useRealTimers();
  });

  it('remontage avec un marqueur EXPIRÉ : un brouillon plus récent l’emporte sur ses réponses', async () => {
    // Marqueur gardé au plafond (réponses de l'envoi d'origine : B), brouillon retouché depuis (A).
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({
        answers: { 101: { kind: 'choice', answerIds: [2] } },
        attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000,
      })
    );
    localStorage.setItem(
      `moodit:quiz-draft:${QUIZ_ID}`,
      JSON.stringify({ answers: { 101: { kind: 'choice', answerIds: [1] } }, touched: [101], currentIndex: 0 })
    );
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    expect(result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [1] });
  });

  it('remontage avec un marqueur EN COURS : ses réponses (celles envoyées) l’emportent', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({
        answers: { 101: { kind: 'choice', answerIds: [2] } },
        attemptsBefore: 0, attemptId: 9, submittedAt: Date.now(),
      })
    );
    localStorage.setItem(
      `moodit:quiz-draft:${QUIZ_ID}`,
      JSON.stringify({ answers: { 101: { kind: 'choice', answerIds: [1] } }, touched: [101], currentIndex: 0 })
    );
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
      })
    );
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    expect(result.current.answers[101]).toEqual({ kind: 'choice', answerIds: [2] });
  });

  it('409 « en_cours » dont l’id désigne une tentative CONNUE avant l’envoi : id ignoré, voie sans id', async () => {
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [summary(5)]),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          throw new SubmissionInProgressError(5);
        }),
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    const marker = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
    expect(marker.attemptId).toBeUndefined();
    expect(marker.knownAttemptIds).toEqual([5]);
  });

  it.each([
    // Tentative supprimée (correction en échec), verdict manqué : échec sans attendre le plafond.
    ['gone → « vérification impossible », brouillon gardé, marqueur effacé', 'gone'],
    // Déjà corrigée (historique en retard) : la tentative s'ouvre.
    ['done → tentative ouverte', 'done'],
    // Encore en correction : l'attente continue.
    ['pending → l’attente continue', 'pending'],
  ] as const)('statut de la tentative attendue pendant l’attente (%s)', async (_case, status) => {
    vi.useFakeTimers();
    let history: AttemptSummary[] = [];
    const onFetchAttemptStatus = vi.fn(async () => {
      if (status === 'done') history = [summary(9)];
      return status;
    });
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onFetchAttemptStatus,
        onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
        codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    act(() => { void result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600); });
    expect(onFetchAttemptStatus).toHaveBeenCalledWith(QUIZ_ID, 9);
    if (status === 'gone') {
      await vi.waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
      expect(result.current.reconciling).toBe(false);
      expect(result.current.phase).toBe('taking');
      expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
      expect(localStorage.getItem(`moodit:quiz-draft:${QUIZ_ID}`)).not.toBeNull();
    } else if (status === 'done') {
      await vi.waitFor(() => expect(result.current.result?.attemptId).toBe(9));
    } else {
      expect(result.current.reconciling).toBe(true);
      expect(result.current.submitError).toBeNull();
    }
    vi.useRealTimers();
  });

  it('remontage APRÈS le plafond, tentative supprimée : son statut donne « vérification impossible »', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 })
    );
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        onFetchAttemptStatus: vi.fn(async () => 'gone' as const),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
        codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
  });

  it('verdict de la NOUVELLE tentative reçu vue fermée (échec) : consommé au retour', async () => {
    // Changement de canal pendant le POST (marqueur sans id), la correction échoue pendant
    // l'absence : le Dashboard garde ce verdict et le représente au montage. C'est le sien
    // (tentative absente des connues) → « vérification impossible », pas 45 min d'attente.
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 1, knownAttemptIds: [10], submittedAt: Date.now() })
    );
    const outcome: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 11, ok: false };
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [summary(10)]),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        attemptOutcome: outcome,
        codeVerificationUnavailableMessage: 'CODE_KO',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('CODE_KO'));
    expect(result.current.reconciling).toBe(false);
    expect(result.current.phase).toBe('taking');
  });

  it('dernier verdict vu à l’envoi : inscrit au marqueur, il ne conclut pas l’attente au retour', async () => {
    // Échec d'une tentative précédente (#12, supprimée : absente de l'historique), toujours
    // présenté par le Dashboard. Envoi, puis changement de canal pendant le POST, puis retour.
    const stale: AttemptOutcome = { quizId: QUIZ_ID, attemptId: 12, ok: false };
    const params = {
      initialQuiz,
      onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
      onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
      onSubmitQuiz: vi.fn(() => new Promise<{ attemptId: number }>(() => {})),
      attemptOutcome: stale,
      codeVerificationUnavailableMessage: 'CODE_KO',
    };
    const first = renderHook(() => useQuizAttempt(params));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => { void first.result.current.submit(); });
    first.unmount();
    const marker = JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!);
    expect(marker.knownAttemptIds).toEqual([12]);
    expect(typeof marker.submittedAt).toBe('number');

    const { result } = renderHook(() => useQuizAttempt(params));
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(result.current.submitError).toBeNull();
    expect(result.current.reconciling).toBe(true);
  });

  it.each([
    // Envoi d'il y a 46 min (correction en échec reçue par personne) : conclusion immédiate.
    ['marqueur ancien → « non confirmée » tout de suite', 46 * 60_000, 0],
    // Envoi d'il y a 44 min : seule l'attente RESTANTE (≈ 1 min) court.
    ['marqueur récent → seulement l’attente restante', 44 * 60_000, 90_000],
  ])('échéance comptée depuis l’envoi (%s)', async (_case, age, wait) => {
    vi.useFakeTimers();
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, knownAttemptIds: [], submittedAt: Date.now() - age })
    );
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    if (wait > 0) {
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(result.current.reconciling).toBe(true);
      expect(result.current.submitError).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(wait); });
    }
    await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    expect(result.current.reconciling).toBe(false);
    expect(result.current.phase).toBe('taking');
    vi.useRealTimers();
  });

  it('verdict de la correction en cours poussé PENDANT le POST, puis 409 « en_cours » : il conclut', async () => {
    // Autre onglet : sa correction (#6) finit pendant notre POST, refusé ensuite en 409. Son
    // verdict, déjà reçu, ne doit pas être jeté : l'historique, lui, ne la montre pas encore.
    let outcome: AttemptOutcome | null = null;
    let rejectPost!: (e: unknown) => void;
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => [summary(5)]),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(() => new Promise<{ attemptId: number }>((_r, rej) => { rejectPost = rej; })),
        attemptOutcome: outcome,
      })
    );
    await waitFor(() => expect(result.current.result?.attemptId).toBe(5));
    act(() => result.current.retry());
    act(() => { void result.current.submit(); });
    outcome = { quizId: QUIZ_ID, attemptId: 6, ok: true };
    rerender();
    await act(async () => { rejectPost(new SubmissionInProgressError()); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(6));
    expect(result.current.phase).toBe('summary');
  });

  it.each([
    // La correction a fini après le plafond, verdict manqué : « Réessayer » ouvre son résumé.
    ['apparue (corrigée) → résumé ouvert, aucun renvoi', [summary(9)], true],
    // Toujours absente : seulement alors on renvoie ; 409 « en_cours » → reprise de l'attente.
    ['absente → renvoi, puis attente sur 409 « en_cours »', [] as AttemptSummary[], false],
    // Seule une AUTRE tentative (#10, autre onglet) est apparue : ce n'est pas la nôtre (#9,
    // id connu) — renvoi, et #10 n'est pas ouverte à sa place.
    ['absente, une autre (autre onglet) apparue → renvoi', [summary(10)], false],
  ])('« Réessayer » après le plafond, tentative %s', async (_case, after, landed) => {
    vi.useFakeTimers();
    let history: AttemptSummary[] = [];
    const onSubmitQuiz = vi
      .fn<() => Promise<{ attemptId: number }>>()
      .mockResolvedValueOnce({ attemptId: 9 })
      .mockRejectedValue(new SubmissionInProgressError());
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        // Quiz AVEC reprise : un renvoi inutile y créerait une seconde tentative.
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        onSubmitQuiz,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await vi.waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    act(() => { void result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(46 * 60_000); });
    await vi.waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));

    history = after;
    await act(async () => { await result.current.submit(); await vi.advanceTimersByTimeAsync(0); });
    if (landed) {
      await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
      expect(result.current.result?.attemptId).toBe(9);
      expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
    } else {
      expect(onSubmitQuiz).toHaveBeenCalledTimes(2);
      expect(result.current.reconciling).toBe(true);
      expect(result.current.submitError).toBeNull();
      expect(result.current.phase).toBe('taking');
    }
    vi.useRealTimers();
  });

  it('« Réessayer » après le plafond, id inconnu : la tentative est reconnue par les tentatives connues', async () => {
    // Marqueur d'un envoi dont la vue n'a jamais reçu l'id (démontée pendant le POST), expiré.
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      // 12 = dernier verdict vu à l'envoi (tentative supprimée, absente de l'historique) : le
      // compte « une de plus qu'avant » (2) ne verrait pas la nouvelle tentative #6.
      JSON.stringify({ answers: {}, attemptsBefore: 2, knownAttemptIds: [5, 12], submittedAt: Date.now() - 50 * 60_000 })
    );
    let history: AttemptSummary[] = [summary(5)];
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 99 }));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    history = [summary(5), summary(6, 2)];
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(6));
    expect(onSubmitQuiz).not.toHaveBeenCalled();
  });

  it('« Réessayer » avec un historique illisible : aucun renvoi, message rétabli, puis relecture', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 })
    );
    let history: AttemptSummary[] = [];
    let failNext = false;
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 99 }));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => {
          if (failNext) {
            failNext = false;
            throw new Error('réseau');
          }
          return history;
        }),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    failNext = true;
    await act(async () => { await result.current.submit(); });
    expect(onSubmitQuiz).not.toHaveBeenCalled();
    expect(result.current.submitError).toBe('NOT_CONFIRMED');
    // La soumission reste attendue : le « Réessayer » suivant la relit et l'ouvre.
    history = [summary(9)];
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9));
    expect(onSubmitQuiz).not.toHaveBeenCalled();
  });

  it('verdict reçu mais résultat illisible : libellé dédié, puis « Réessayer » l’ouvre sans renvoi', async () => {
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    let failNext = false;
    const onFetchAttemptResult = vi
      .fn<(quizId: number, attemptId: number) => Promise<ReturnType<typeof makeResult>>>()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValue(makeResult(9));
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 9 }));
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => {
          if (failNext) {
            failNext = false;
            throw new Error('réseau');
          }
          return history;
        }),
        onFetchAttemptResult,
        onSubmitQuiz,
        attemptOutcome: outcome,
        resultUnavailableMessage: 'RESULT_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    history = [summary(9)];
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    await waitFor(() => expect(result.current.submitError).toBe('RESULT_KO'));
    expect(result.current.phase).toBe('taking');

    // « Réessayer » avec un historique illisible : le message d'ORIGINE est rétabli.
    failNext = true;
    await act(async () => { await result.current.submit(); });
    expect(result.current.submitError).toBe('RESULT_KO');
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9));
    expect(result.current.phase).toBe('summary');
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
  });

  it('quiz SANS reprise, résultat illisible après le verdict : « Soumettre » n’est pas grisé, « Réessayer » ouvre le résumé', async () => {
    // `attempts` posé avant la lecture du résultat grisait « Soumettre » (« déjà soumis ») : plus
    // rien ne menait au résultat une fois le message fermé.
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 9 }));
    // Espion STABLE : recréé à chaque rendu, il rejetterait à chaque nouvelle instance.
    const onFetchAttemptResult = vi
      .fn<(quizId: number, attemptId: number) => Promise<ReturnType<typeof makeResult>>>()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValue(makeResult(9));
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: false })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult,
        onSubmitQuiz,
        attemptOutcome: outcome,
        resultUnavailableMessage: 'RESULT_KO',
      })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { result.current.submit(); await Promise.resolve(); });
    history = [summary(9)];
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    await waitFor(() => expect(result.current.submitError).toBe('RESULT_KO'));
    expect(result.current.alreadySubmitted).toBe(false);
    await act(async () => { await result.current.submit(); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9));
    expect(onSubmitQuiz).toHaveBeenCalledTimes(1);
  });

  it('« Réessayer » : verdict poussé PENDANT la relecture de l’historique → conclut, aucun renvoi', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 0, attemptId: 9, submittedAt: Date.now() - 50 * 60_000 })
    );
    let outcome: AttemptOutcome | null = null;
    let history: AttemptSummary[] = [];
    let releaseRead: ((h: AttemptSummary[]) => void) | null = null;
    const onFetchAttempts = vi.fn(async () => history);
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 99 }));
    const { result, rerender } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async () => makeResult(9)),
        onSubmitQuiz,
        attemptOutcome: outcome,
        submissionNotConfirmedMessage: 'NOT_CONFIRMED',
      })
    );
    await waitFor(() => expect(result.current.submitError).toBe('NOT_CONFIRMED'));
    onFetchAttempts.mockImplementationOnce(() => new Promise((r) => { releaseRead = r; }));
    act(() => { void result.current.submit(); });
    await waitFor(() => expect(releaseRead).not.toBeNull());
    // Le verdict arrive pendant la relecture, qui répond ensuite sans la tentative.
    outcome = { quizId: QUIZ_ID, attemptId: 9, ok: true };
    rerender();
    history = [summary(9)];
    await act(async () => { releaseRead!([]); });
    await waitFor(() => expect(result.current.result?.attemptId).toBe(9));
    expect(onSubmitQuiz).not.toHaveBeenCalled();
  });

  it('plafond atteint pendant l’attente : marqueur gardé, le remontage ouvre le résultat (pas la passation)', async () => {
    vi.useFakeTimers();
    let history: AttemptSummary[] = [];
    const params = {
      initialQuiz,
      onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
      onFetchAttempts: vi.fn(async () => history),
      onFetchAttemptResult: vi.fn(async () => makeResult(9)),
      onSubmitQuiz: vi.fn(async () => ({ attemptId: 9 })),
      submissionNotConfirmedMessage: 'NOT_CONFIRMED',
    };
    const first = renderHook(() => useQuizAttempt(params));
    await vi.waitFor(() => expect(first.result.current.loading).toBe(false));
    act(() => { first.result.current.setAnswer(101, { kind: 'choice', answerIds: [1] }); });
    act(() => { void first.result.current.submit(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(46 * 60_000); });
    await vi.waitFor(() => expect(first.result.current.submitError).toBe('NOT_CONFIRMED'));
    first.unmount();
    // Effacé, le marqueur laissait le brouillon rouvrir la passation (et « Soumettre » créer une
    // seconde tentative) alors que la correction a abouti entre-temps.
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).not.toBeNull();
    history = [summary(9)];
    const { result } = renderHook(() => useQuizAttempt(params));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await vi.waitFor(() => expect(result.current.phase).toBe('summary'));
    expect(result.current.result?.attemptId).toBe(9);
    expect(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)).toBeNull();
    vi.useRealTimers();
  });

  it('409 « en_cours » avec une liste périmée (autre appareil) : l’historique est relu, la bonne tentative s’ouvre', async () => {
    // La vue ne connaît que #1 ; le serveur a déjà #2 (autre appareil), et #3 est en correction.
    vi.useFakeTimers();
    let history: AttemptSummary[] = [summary(1)];
    const onFetchAttempts = vi.fn(async () => history);
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts,
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
        onSubmitQuiz: vi.fn(async () => {
          throw new SubmissionInProgressError();
        }),
      })
    );
    await vi.waitFor(() => expect(result.current.result?.attemptId).toBe(1));
    act(() => result.current.retry());
    history = [summary(1), summary(2, 2)];
    await act(async () => { result.current.submit(); await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.reconciling).toBe(true);
    // Sondage : #2 seule n'est pas la tentative attendue…
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(result.current.reconciling).toBe(true);
    // … #3, si.
    history = [summary(1), summary(2, 2), summary(3, 3)];
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    await vi.waitFor(() => expect(result.current.result?.attemptId).toBe(3));
    vi.useRealTimers();
  });

  it('plusieurs tentatives inconnues : la PLUS RÉCENTE est l’attendue', async () => {
    localStorage.setItem(
      `moodit:quiz-pending-submission:${QUIZ_ID}`,
      JSON.stringify({ answers: {}, attemptsBefore: 1, knownAttemptIds: [1], submittedAt: Date.now() })
    );
    let history: AttemptSummary[] = [summary(1)];
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz({ allowRetry: true })),
        onFetchAttempts: vi.fn(async () => history),
        onFetchAttemptResult: vi.fn(async (_q: number, id: number) => makeResult(id)),
      })
    );
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    history = [summary(1), summary(2, 2), summary(3, 3)];
    await waitFor(() => expect(result.current.result?.attemptId).toBe(3), { timeout: 3000 });
  });

  it('envoi pendant l’attente lancée au REMONTAGE (marqueur en vol) : ignoré, marqueur intact', async () => {
    // Aucun envoi de cette vue en cours (sendingRef faux) : seule la garde de l'attente protège.
    const marker = { answers: {}, attemptsBefore: 0, knownAttemptIds: [] as number[], submittedAt: Date.now() };
    localStorage.setItem(`moodit:quiz-pending-submission:${QUIZ_ID}`, JSON.stringify(marker));
    const onSubmitQuiz = vi.fn(async () => ({ attemptId: 9 }));
    const { result } = renderHook(() =>
      useQuizAttempt({
        initialQuiz,
        onFetchQuiz: vi.fn(async () => makeQuiz()),
        onFetchAttempts: vi.fn(async () => [] as AttemptSummary[]),
        onSubmitQuiz,
      })
    );
    await waitFor(() => expect(result.current.reconciling).toBe(true));
    await act(async () => { await result.current.submit(); });
    expect(onSubmitQuiz).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(`moodit:quiz-pending-submission:${QUIZ_ID}`)!)).toEqual(marker);
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
    await act(async () => { await vi.advanceTimersByTimeAsync(45 * 60_000 - 10_000); });
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
