import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { QuizEditor } from './QuizEditor';
import { ReviewAttemptsBody } from './ReviewAttemptsBody';
import { defaultQuizEditorLabels } from './quizEditorLabels';
import { defaultQuizListLabels } from './quizListLabels';
import { defaultReviewAttemptsLabels } from './reviewAttemptsLabels';
import { type ReviewAttempt } from './editorTypes';
import { type Quiz } from '../../types/domain';
import './editorTestSetup';

/**
 * Tentatives « à revoir » (#116) : leur correction automatique a échoué sans verdict trop
 * souvent. L'enseignant les voit depuis la liste des quiz (pastille) et relance leur correction.
 */

afterEach(cleanup);

const editorT = defaultQuizEditorLabels;
const listT = defaultQuizListLabels;
const reviewT = defaultReviewAttemptsLabels;

/**
 * Élément focalisé à l'instant PRÉCIS où `isShown()` devient vrai, relevé par un observateur de
 * mutation : il passe avant le planificateur de React, donc avant tout effet passif (cf.
 * AssignmentTeams.test). Un `waitFor` ne distingue pas un effet de mise en page d'un effet
 * passif : RTL laisse passer un tour de boucle après lui, qui vide les effets passifs. Hors
 * `act` (qui les viderait aussi) le temps de l'attente.
 */
async function focusWhenShown(trigger: () => void, isShown: () => boolean): Promise<Element | null> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const actEnvironment = env.IS_REACT_ACT_ENVIRONMENT;
  const shown = new Promise<Element | null>((resolve) => {
    const observer = new MutationObserver(() => {
      if (!isShown()) return;
      observer.disconnect();
      resolve(document.activeElement);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  trigger();
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    return await shown;
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  }
}

function makeQuiz(over: Partial<Quiz> = {}): Quiz {
  return { id: 1, title: 'Quiz A', isPublished: true, isDaily: false, questions: [], ...over };
}

const EVA: ReviewAttempt = {
  attemptId: 81,
  attemptNo: 2,
  studentName: 'Éva Test',
  submittedAt: '2026-09-02T08:30:00Z',
  noVerdictFailures: 3,
};
const BOB: ReviewAttempt = {
  attemptId: 82,
  attemptNo: 1,
  studentName: 'Bob Test',
  submittedAt: null,
  noVerdictFailures: 1,
};

describe('QuizEditor — tentatives à revoir', () => {
  it('pastille seulement pour un quiz qui en a, et seulement si les handlers sont câblés', () => {
    const quizzes = [
      makeQuiz({ id: 1, title: 'Quiz A', reviewAttemptCount: 2 }),
      makeQuiz({ id: 2, title: 'Quiz B', reviewAttemptCount: 0 }),
    ];
    const { unmount } = render(
      <QuizEditor
        courseId={42}
        quizzes={quizzes}
        onClose={vi.fn()}
        handlers={{ onFetchReviewAttempts: vi.fn(), onRegradeAttempt: vi.fn() }}
      />
    );
    expect(screen.getByLabelText(listT.reviewAria('Quiz A', 2)).textContent).toBe(
      listT.reviewBadge(2)
    );
    expect(screen.queryByLabelText(listT.reviewAria('Quiz B', 0))).toBeNull();
    unmount();

    render(<QuizEditor courseId={42} quizzes={quizzes} onClose={vi.fn()} />);
    expect(screen.queryByText(listT.reviewBadge(2))).toBeNull();
  });

  it('Échap ferme l\'éditeur depuis les tentatives à revoir (aucune saisie à perdre)', async () => {
    const onClose = vi.fn();
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={onClose}
        handlers={{ onFetchReviewAttempts: vi.fn(async () => [EVA, BOB]), onRegradeAttempt: vi.fn() }}
      />
    );
    fireEvent.click(screen.getByLabelText(listT.reviewAria('Quiz A', 2)));
    await screen.findByText('Éva Test');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pastille → liste ; relance → ligne retirée et pastille décrémentée', async () => {
    const onFetchReviewAttempts = vi.fn(async () => [EVA, BOB]);
    const onRegradeAttempt = vi.fn(async () => undefined);
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{ onFetchReviewAttempts, onRegradeAttempt }}
      />
    );

    // Appuyer sur la pastille ne démarre pas le glisser-déposer de la ligne.
    const badge = screen.getByLabelText(listT.reviewAria('Quiz A', 2));
    fireEvent.pointerDown(badge, { pointerId: 1, button: 0 });
    fireEvent.pointerMove(badge, { pointerId: 1, clientY: 40 });
    expect(badge.closest('[data-reorder-id]')?.className).not.toMatch(/listRowDragging/);
    badge.focus(); // un vrai clic focalise le bouton (jsdom ne le fait pas)
    fireEvent.click(badge);
    expect(screen.getByText(editorT.reviewTitle)).toBeTruthy();
    await screen.findByText('Éva Test');
    // La pastille a disparu avec la liste : le focus est replacé dans la fenêtre (« Retour »).
    expect(document.activeElement).toBe(screen.getByLabelText(/retour/i));
    expect(onFetchReviewAttempts).toHaveBeenCalledWith(1);
    expect(screen.getByText(reviewT.attemptLabel(2))).toBeTruthy();
    expect(screen.getByText(reviewT.attemptSub(null, 1))).toBeTruthy();

    // Le focus passe à la ligne voisine au lieu de sortir de la fenêtre. Posé par un effet de
    // MISE EN PAGE dans la mise à jour qui retire la ligne : il y est déjà quand elle disparaît.
    const focused = await focusWhenShown(
      () => fireEvent.click(screen.getByLabelText(reviewT.regradeAria('Éva Test', 2))),
      () => screen.queryByText('Éva Test') == null
    );
    const bobButton = screen.getByLabelText(reviewT.regradeAria('Bob Test', 1));
    expect(focused).toBe(bobButton);
    expect(document.activeElement).toBe(bobButton);
    expect(onRegradeAttempt).toHaveBeenCalledWith(1, 81);
    expect(screen.getByText('Bob Test')).toBeTruthy();

    // Retour à la liste : un « à revoir » de moins.
    fireEvent.click(screen.getByLabelText(/retour/i));
    expect(screen.getByText(listT.reviewBadge(1))).toBeTruthy();
  });

  it('pastille gardée après l’ENREGISTREMENT du quiz, dont la réponse ne porte pas le compteur', async () => {
    // Le quiz renvoyé par l'enregistrement vient de toQuiz, qui ne mappe pas le compteur
    // (route /manage seulement) : upsertInList doit garder celui de la liste. « Retour » ne le
    // prouve pas — il restaure une copie de la liste prise à l'ouverture.
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchQuiz: vi.fn(async () => makeQuiz()),
          onUpdateQuiz: vi.fn(async () => makeQuiz()),
          onFetchReviewAttempts: vi.fn(async () => [EVA]),
          onRegradeAttempt: vi.fn(),
        }}
      />
    );
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    await screen.findByText(editorT.editQuizTitle);
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText(listT.reviewBadge(2))).toBeTruthy();
  });

  it('pastille gardée après ouverture du quiz, recalée sur la liste chargée', async () => {
    // Le détail d'édition ne porte pas le compteur : l'ouvrir ne doit pas effacer la pastille.
    const onFetchQuiz = vi.fn(async () => makeQuiz());
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchQuiz,
          onFetchReviewAttempts: vi.fn(async () => [EVA]),
          onRegradeAttempt: vi.fn(),
        }}
      />
    );
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    await screen.findByText(editorT.editQuizTitle);
    fireEvent.click(screen.getByLabelText(/retour/i));
    expect(screen.getByText(listT.reviewBadge(2))).toBeTruthy();

    // La liste chargée n'en compte qu'une : la pastille suit le serveur.
    fireEvent.click(screen.getByLabelText(listT.reviewAria('Quiz A', 2)));
    await screen.findByText('Éva Test');
    fireEvent.click(screen.getByLabelText(/retour/i));
    expect(screen.getByText(listT.reviewBadge(1))).toBeTruthy();
  });

  it('relance refusée → popup d\'erreur, la liste se recale sur le serveur', async () => {
    const onRegradeAttempt = vi.fn(async () => {
      throw new Error('409');
    });
    // Le serveur ne la compte plus (relancée par un autre enseignant) : la ligne part, la
    // pastille aussi.
    const onFetchReviewAttempts = vi
      .fn<(quizId: number) => Promise<ReviewAttempt[]>>()
      .mockResolvedValueOnce([EVA])
      .mockResolvedValue([]);
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 1 })]}
        onClose={vi.fn()}
        handlers={{ onFetchReviewAttempts, onRegradeAttempt }}
      />
    );
    fireEvent.click(screen.getByLabelText(listT.reviewAria('Quiz A', 1)));
    fireEvent.click(await screen.findByLabelText(reviewT.regradeAria('Éva Test', 2)));

    await screen.findByText(editorT.regradeError);
    await screen.findByText(reviewT.empty);
    expect(onFetchReviewAttempts).toHaveBeenCalledTimes(2);
    // Le bouton cliqué a disparu avec le rechargement : fermer l'erreur rend le focus à
    // l'introduction, dans la fenêtre, et non à <body>.
    const errorDialog = screen.getByText(editorT.regradeError).closest(
      '[role="dialog"], [role="alertdialog"]'
    ) as HTMLElement;
    fireEvent.click(within(errorDialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(reviewT.intro)));
  });

  it('chargement des tentatives en échec → popup d\'erreur propre au chargement (pas celui de la relance)', async () => {
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 1 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchReviewAttempts: vi.fn(async () => {
            throw new Error('503');
          }),
          onRegradeAttempt: vi.fn(),
        }}
      />
    );
    fireEvent.click(screen.getByLabelText(listT.reviewAria('Quiz A', 1)));
    expect(await screen.findByText(editorT.reviewLoadError)).toBeTruthy();
    expect(screen.queryByText(editorT.regradeError)).toBeNull();
  });

  it('relecture après relance arrivée APRÈS l\'ouverture d\'un quiz : le quiz ouvert garde ses questions', async () => {
    // Revue #246 : la réponse tardive remplaçait le quiz complet (formulaire ouvert) par sa
    // version de liste, sans questions — un enregistrement les aurait supprimées au serveur.
    let resolveRegrade!: () => void;
    const onRegradeAttempt = vi.fn(
      () => new Promise<void>((resolve) => { resolveRegrade = resolve; })
    );
    let resolveLate!: (q: Quiz[]) => void;
    const onFetchQuizzes = vi
      .fn()
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 2 })])
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 2 })])
      .mockImplementationOnce(() => new Promise<Quiz[]>((resolve) => { resolveLate = resolve; }))
      .mockResolvedValue([makeQuiz({ reviewAttemptCount: 1 })]);
    const full = makeQuiz({
      questions: [{ id: 7, qType: 'true_false', prompt: 'Question gardée', totalScore: 1 }],
    } as Partial<Quiz>);
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchQuizzes,
          onFetchQuiz: vi.fn(async () => full),
          onFetchReviewAttempts: vi.fn(async () => [EVA, BOB]),
          onRegradeAttempt,
        }}
      />
    );
    fireEvent.click(await screen.findByLabelText(listT.reviewAria('Quiz A', 2)));
    fireEvent.click(await screen.findByLabelText(reviewT.regradeAria('Éva Test', 2)));
    fireEvent.click(screen.getByLabelText(/retour/i));
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveRegrade();
    });
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledTimes(3));
    // L'enseignant ouvre le quiz avant la réponse de la relecture.
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    expect(await screen.findByText('Question gardée')).toBeTruthy();
    await act(async () => {
      resolveLate([makeQuiz({ reviewAttemptCount: 1 })]);
    });
    expect(screen.getByText('Question gardée')).toBeTruthy();
  });

  it('retour à la liste pendant la relance : la liste est relue une fois la relance acceptée', async () => {
    // Revue #246 : la lecture de la liste au retour peut passer AVANT que la relance soit
    // enregistrée au serveur, et garder un « à revoir » de trop.
    let resolveRegrade!: () => void;
    const onRegradeAttempt = vi.fn(
      () => new Promise<void>((resolve) => { resolveRegrade = resolve; })
    );
    const onFetchQuizzes = vi
      .fn()
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 2 })])
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 2 })])
      .mockResolvedValue([makeQuiz({ reviewAttemptCount: 1 })]);
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchQuizzes,
          onFetchReviewAttempts: vi.fn(async () => [EVA, BOB]),
          onRegradeAttempt,
        }}
      />
    );
    fireEvent.click(await screen.findByLabelText(listT.reviewAria('Quiz A', 2)));
    fireEvent.click(await screen.findByLabelText(reviewT.regradeAria('Éva Test', 2)));
    fireEvent.click(screen.getByLabelText(/retour/i));
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(listT.reviewBadge(2))).toBeTruthy();

    await act(async () => {
      resolveRegrade();
    });
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledTimes(3));
    expect(await screen.findByText(listT.reviewBadge(1))).toBeTruthy();
  });

  it('retour à la liste pendant la relance, déjà comptée par le serveur : la pastille n\'est pas décomptée une fois de trop', async () => {
    // La lecture du retour arrive APRÈS l'enregistrement de la relance (« 1 à revoir ») : la
    // réponse de la relance ne doit pas retirer un « à revoir » de plus à ce compte serveur. La
    // relecture qu'elle demande reste en attente, pour que seule la garde de markRegraded compte.
    let resolveRegrade!: () => void;
    const onRegradeAttempt = vi.fn(
      () => new Promise<void>((resolve) => { resolveRegrade = resolve; })
    );
    const onFetchQuizzes = vi
      .fn()
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 2 })])
      .mockResolvedValueOnce([makeQuiz({ reviewAttemptCount: 1 })])
      .mockImplementation(() => new Promise<Quiz[]>(() => {}));
    render(
      <QuizEditor
        courseId={42}
        quizzes={[makeQuiz({ reviewAttemptCount: 2 })]}
        onClose={vi.fn()}
        handlers={{
          onFetchQuizzes,
          onFetchReviewAttempts: vi.fn(async () => [EVA, BOB]),
          onRegradeAttempt,
        }}
      />
    );
    fireEvent.click(await screen.findByLabelText(listT.reviewAria('Quiz A', 2)));
    fireEvent.click(await screen.findByLabelText(reviewT.regradeAria('Éva Test', 2)));
    fireEvent.click(screen.getByLabelText(/retour/i));
    expect(await screen.findByText(listT.reviewBadge(1))).toBeTruthy();

    await act(async () => {
      resolveRegrade();
    });
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledTimes(3));
    expect(screen.getByText(listT.reviewBadge(1))).toBeTruthy();
  });
});

describe('ReviewAttemptsBody', () => {
  function renderBody(onFetch: (quizId: number) => Promise<ReviewAttempt[]>) {
    const onError = vi.fn();
    render(
      <ReviewAttemptsBody
        quizId={7}
        onFetch={onFetch}
        onRegrade={vi.fn()}
        onRegraded={vi.fn()}
        onError={onError}
      />
    );
    return { onError };
  }

  it('chargement puis liste vide', async () => {
    renderBody(async () => []);
    expect(screen.getByText(reviewT.loading)).toBeTruthy();
    await screen.findByText(reviewT.empty);
  });

  it('échec du chargement → erreur signalée, « Réessayer » recharge', async () => {
    const onFetch = vi
      .fn<(quizId: number) => Promise<ReviewAttempt[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([EVA]);
    const { onError } = renderBody(onFetch);

    const retry = await screen.findByText(reviewT.retry);
    retry.focus();
    fireEvent.click(retry);
    // Le bouton disparaît avec le rechargement : le focus reste dans la fenêtre (introduction).
    expect(retry.isConnected).toBe(false);
    expect(document.activeElement?.textContent).toBe(reviewT.intro);
    await screen.findByText('Éva Test');
    expect(onError).toHaveBeenCalledWith('load');
    expect(onFetch).toHaveBeenCalledTimes(2);
  });
});

describe('ReviewAttemptsBody — focus et relance unique', () => {
  it('dernière ligne relancée → focus sur l\'introduction ; une seule relance à la fois', async () => {
    let resolveRegrade!: () => void;
    const onRegrade = vi.fn(() => new Promise<void>((resolve) => { resolveRegrade = resolve; }));
    render(
      <ReviewAttemptsBody
        quizId={7}
        onFetch={async () => [EVA]}
        onRegrade={onRegrade}
        onRegraded={vi.fn()}
        onError={vi.fn()}
      />
    );
    const button = await screen.findByLabelText(reviewT.regradeAria('Éva Test', 2));
    fireEvent.click(button);
    // Toujours focalisable pendant la relance (aria-disabled), et un second clic ne relance pas.
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onRegrade).toHaveBeenCalledTimes(1);

    resolveRegrade();
    await screen.findByText(reviewT.empty);
    expect(document.activeElement).toBe(screen.getByText(reviewT.intro));
  });
});

describe('reviewAttemptsLabels', () => {
  it('sous-ligne : date si connue, pluriel des échecs, compte nul omis', () => {
    expect(reviewT.attemptSub(null, 1)).toBe('1 échec sans verdict');
    expect(reviewT.attemptSub('pas une date', 3)).toBe('3 échecs sans verdict');
    expect(reviewT.attemptSub('2026-09-02T08:30:00Z', 2)).toMatch(/^Soumise le .* · 2 échecs/);
    // Compte remis à zéro par une autre tentative corrigée : pas de « 0 échec sans verdict ».
    expect(reviewT.attemptSub(null, 0)).toBe('');
    expect(reviewT.attemptSub('2026-09-02T08:30:00Z', 0)).toMatch(/^Soumise le [^·]*$/);
  });

  it('nom accessible de la pastille : commence par son texte visible', () => {
    expect(listT.reviewAria('Quiz A', 2).startsWith(listT.reviewBadge(2))).toBe(true);
    expect(listT.reviewAria('Quiz A', 1).startsWith(listT.reviewBadge(1))).toBe(true);
  });
});
