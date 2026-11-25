import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import QuizView from './QuizView';
import type { Course, CourseChannel, Quiz } from '../../../types/domain';
import type { AttemptSummary, QuizResult, SubmitQuizHandler } from './quizAttempt';
import { SubmissionRejectedError } from './quizAttempt';

/**
 * Coquille de la vue quiz (côté étudiant) : en-tête, barre de progression, corps
 * (question / résumé / révision) et pied de navigation. La logique vit dans
 * `useQuizAttempt` ; ici on vérifie l'assemblage et le câblage des handlers.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const course: Course = { id: 1, name: 'INF1010' };

const channel: CourseChannel = { id: 55, name: 'Quiz hebdo', type: 'quiz' };

/** Quiz minimal à 3 questions à choix unique (rendu simple et robuste en jsdom). */
function makeQuiz(overrides: Partial<Quiz> = {}): Quiz {
  return {
    id: 55,
    title: 'Quiz hebdo',
    allowRetry: true,
    questions: [
      {
        id: 1, prompt: 'Question un', qType: 'single_choice', totalScore: 1,
        answers: [{ id: 11, content: 'A', isCorrect: true }, { id: 12, content: 'B' }],
      },
      {
        id: 2, prompt: 'Question deux', qType: 'single_choice', totalScore: 1,
        answers: [{ id: 21, content: 'C', isCorrect: true }, { id: 22, content: 'D' }],
      },
      {
        id: 3, prompt: 'Question trois', qType: 'single_choice', totalScore: 1,
        answers: [{ id: 31, content: 'E', isCorrect: true }, { id: 32, content: 'F' }],
      },
    ],
    ...overrides,
  };
}

interface RenderOpts {
  quiz?: Quiz;
  attempts?: AttemptSummary[];
  attemptResult?: QuizResult | null;
  staleNotice?: boolean;
  onReloadStale?: () => void;
  onSubmitQuiz?: ReturnType<typeof vi.fn>;
}

function renderView(opts: RenderOpts = {}) {
  const quiz = opts.quiz ?? makeQuiz();
  const onFetchQuiz = vi.fn(async () => quiz);
  const onFetchAttempts = vi.fn(async () => opts.attempts ?? []);
  const hasAttemptResult = 'attemptResult' in opts;
  const onFetchAttemptResult = vi.fn(async () =>
    hasAttemptResult ? (opts.attemptResult as QuizResult) : ({} as QuizResult)
  );
  const onSubmitQuiz = opts.onSubmitQuiz;
  const onReloadStale = opts.onReloadStale ?? vi.fn();

  const utils = render(
    <QuizView
      course={course}
      channel={channel}
      onFetchQuiz={onFetchQuiz}
      onFetchAttempts={onFetchAttempts}
      onFetchAttemptResult={onFetchAttemptResult}
      onSubmitQuiz={onSubmitQuiz as SubmitQuizHandler | undefined}
      staleNotice={opts.staleNotice ?? false}
      onReloadStale={onReloadStale}
    />
  );
  return { ...utils, quiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, onReloadStale };
}

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

/** Attend la fin du chargement initial (overlay busy disparu, 1re question affichée). */
async function waitLoaded() {
  await waitFor(() => expect(screen.getByText('Question un')).toBeTruthy());
}

describe('QuizView — chargement & en-tête', () => {
  it('affiche l’overlay busy (role=status) pendant le chargement initial', async () => {
    let resolveQuiz!: (q: Quiz) => void;
    const onFetchQuiz = vi.fn(() => new Promise<Quiz>((r) => { resolveQuiz = r; }));
    render(
      <QuizView
        course={course}
        channel={channel}
        onFetchQuiz={onFetchQuiz}
        onFetchAttempts={vi.fn(async () => [])}
      />
    );
    // Pendant le fetch en attente, l'overlay busy est présent.
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => { resolveQuiz(makeQuiz()); });
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it('affiche le nom du canal en titre (quiz non « du jour »)', async () => {
    renderView();
    await waitLoaded();
    expect(screen.getByText('Quiz hebdo')).toBeTruthy();
  });

  it('affiche « Quiz du jour » quand isDaily', async () => {
    renderView({ quiz: makeQuiz({ isDaily: true }) });
    await waitLoaded();
    expect(screen.getByText('Quiz du jour')).toBeTruthy();
  });

  it('affiche le statut « Question N sur T »', async () => {
    renderView();
    await waitLoaded();
    expect(screen.getByText('Question 1 sur 3')).toBeTruthy();
  });
});

describe('QuizView — barre de progression', () => {
  it('progresse selon l’index courant', async () => {
    const { container } = renderView();
    await waitLoaded();
    const fill = () => container.querySelector<HTMLElement>('[class*="progressFill"]');
    // Q1/3 → 1/3 ≈ 33.33 %.
    expect(fill()!.style.width).toBe(`${(1 / 3) * 100}%`);
    fireEvent.click(screen.getByText('Suivant'));
    // Q2/3 → 2/3.
    expect(fill()!.style.width).toBe(`${(2 / 3) * 100}%`);
  });
});

describe('QuizView — pied de navigation', () => {
  it('« Précédent » désactivé à la première question', async () => {
    renderView();
    await waitLoaded();
    const prev = screen.getByRole('button', { name: /Précédent/ });
    expect((prev as HTMLButtonElement).disabled).toBe(true);
  });

  it('« Suivant » avance et réactive « Précédent »', async () => {
    renderView();
    await waitLoaded();
    fireEvent.click(screen.getByText('Suivant'));
    expect(screen.getByText('Question deux')).toBeTruthy();
    const prev = screen.getByRole('button', { name: /Précédent/ });
    expect((prev as HTMLButtonElement).disabled).toBe(false);
  });

  it('affiche « Soumettre » à la dernière question (et pas « Suivant »)', async () => {
    renderView();
    await waitLoaded();
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    expect(screen.getByText('Question trois')).toBeTruthy();
    expect(screen.getByText('Soumettre')).toBeTruthy();
    expect(screen.queryByText('Suivant')).toBeNull();
  });

  it('« Soumettre » désactivé si la tentative unique est déjà consommée (alreadySubmitted)', async () => {
    // allowRetry=false + une tentative existante → alreadySubmitted → bouton grisé.
    renderView({
      quiz: makeQuiz({ allowRetry: false }),
      attempts: [{ id: 9, attemptNo: 1, earned: 1, max: 3 }],
      attemptResult: null,
    });
    await waitLoaded();
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    const submit = screen.getByRole('button', { name: /Soumettre/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(submit.getAttribute('title')).toContain('déjà soumis');
  });

  it.each([
    ['refus du serveur → son message, sans « Réessayer »',
      new SubmissionRejectedError('Question 2 : le code soumis dépasse 100000 caractères.'),
      'Question 2 : le code soumis dépasse 100000 caractères.', false],
    ['échec ordinaire → message générique, avec « Réessayer »', new Error('réseau'),
      'La soumission a échoué. Réessayez.', true],
  ])('%s', async (_case, error, message, retryOffered) => {
    const onSubmitQuiz = vi.fn(async () => {
      throw error;
    });
    renderView({ onSubmitQuiz });
    await waitLoaded();
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Soumettre/ }));
    });
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(Boolean(screen.queryByRole('button', { name: 'Réessayer' }))).toBe(retryOffered);
  });

  it('« Soumettre » actif quand la tentative n’est pas consommée', async () => {
    renderView();
    await waitLoaded();
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    const submit = screen.getByRole('button', { name: /Soumettre/ });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('QuizView — points de progression (dots)', () => {
  it('un point par question ; clic → navigation (goTo)', async () => {
    const { container } = renderView();
    await waitLoaded();
    const dots = container.querySelectorAll('[aria-label^="Question "]');
    expect(dots.length).toBe(3);
    fireEvent.click(dots[2]);
    expect(screen.getByText('Question trois')).toBeTruthy();
    // Le 3e point est actif.
    const activeDots = container.querySelectorAll('[data-active]');
    expect(activeDots.length).toBe(1);
  });
});

describe('QuizView — tentative à revoir par l’enseignant (#116)', () => {
  it('message d’attente à la place du résumé, sans « Revoir mes réponses »', async () => {
    renderView({
      quiz: makeQuiz({ allowRetry: false }),
      attempts: [{ id: 9, attemptNo: 1, earned: null, max: 3, status: 'review' }],
    });
    await waitFor(() =>
      expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy()
    );
    expect(screen.getByText("En attente de l'enseignant")).toBeTruthy();
    expect(screen.queryByText('Revoir mes réponses')).toBeNull();
    expect(screen.queryByText('Refaire le quiz')).toBeNull();
  });

  it('garde la barre des tentatives sous le message : l’étudiant revient à ses autres tentatives', async () => {
    const graded: QuizResult = {
      earned: 2,
      max: 3,
      questions: [
        { questionId: 1, earned: 1, max: 1 },
        { questionId: 2, earned: 1, max: 1 },
        { questionId: 3, earned: 0, max: 1 },
      ],
    } as QuizResult;
    const { onFetchAttemptResult } = renderView({
      attempts: [
        { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
        { id: 9, attemptNo: 2, earned: null, max: 3, status: 'review' },
      ],
      attemptResult: graded,
    });
    // La dernière tentative est à revoir : message d'attente, ET la barre des deux tentatives.
    await waitFor(() =>
      expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy()
    );
    expect(screen.getByText('#2 · à revoir').getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByText('#1 · 2/3'));
    await waitFor(() => expect(screen.getByText('Quiz hebdo — terminé !')).toBeTruthy());
    expect(onFetchAttemptResult).toHaveBeenCalledWith(55, 8);

    // Et retour à la tentative à revoir depuis le résumé, au clavier : la puce activée
    // disparaît avec le résumé, le focus est rendu à la puce du même id dans la nouvelle barre.
    const reviewChip = screen.getByText('#2 · à revoir');
    reviewChip.focus();
    fireEvent.click(reviewChip);
    expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy();
    expect(reviewChip.isConnected).toBe(false);
    expect(document.activeElement?.textContent).toBe('#2 · à revoir');
    // Le message est annoncé par une région toujours montée.
    expect(document.querySelector('[aria-live="polite"]:not([role])')?.textContent).toContain(
      'Tentative transmise à votre enseignant'
    );
  });

  it('relance aboutie sur la tentative affichée : focus rendu à sa puce, correction annoncée', async () => {
    // Revue #246 : la barre du message d'attente est démontée au profit de celle du résumé ; le
    // focus clavier tombait sur <body> et la note n'était pas annoncée.
    const graded: QuizResult = {
      attemptId: 9,
      earned: 2,
      max: 3,
      questions: [
        { questionId: 1, earned: 1, max: 1 },
        { questionId: 2, earned: 1, max: 1 },
        { questionId: 3, earned: 0, max: 1 },
      ],
    } as QuizResult;
    const onFetchAttempts = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
        { id: 9, attemptNo: 2, earned: null, max: 3, status: 'review' },
      ])
      .mockResolvedValue([
        { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
        { id: 9, attemptNo: 2, earned: 2, max: 3, status: 'done' },
      ]);
    const props = {
      course,
      channel,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts,
      onFetchAttemptResult: vi.fn(async () => graded),
    };
    const { rerender } = render(<QuizView {...props} attemptOutcome={null} />);
    await waitFor(() => expect(screen.getByText('#2 · à revoir')).toBeTruthy());
    const reviewChip = screen.getByText('#2 · à revoir');
    reviewChip.focus();

    // Le focus est posé par l'effet de MISE EN PAGE de la nouvelle barre, dans la mise à jour qui
    // la monte : il est déjà sur la puce quand le résumé apparaît (un effet passif le poserait
    // après un passage par <body>).
    const focused = await focusWhenShown(
      () => rerender(<QuizView {...props} attemptOutcome={{ quizId: 55, attemptId: 9, ok: true }} />),
      () => screen.queryByText('Quiz hebdo — terminé !') != null
    );
    expect(focused?.textContent).toBe('#2 · 2/3');
    expect(reviewChip.isConnected).toBe(false);
    expect(document.activeElement?.textContent).toBe('#2 · 2/3');
    expect(document.querySelector('[aria-live="polite"]:not([role])')?.textContent).toBe(
      'Votre tentative a été corrigée : son résultat est affiché.'
    );
  });

  /** Région annoncée toujours montée (le message d'attente, puis l'annonce de la correction). */
  const liveRegion = () => document.querySelector('[aria-live="polite"]:not([role])');
  const GRADED_NOTICE = 'Votre tentative a été corrigée : son résultat est affiché.';
  const graded9 = {
    attemptId: 9,
    earned: 2,
    max: 3,
    questions: [
      { questionId: 1, earned: 1, max: 1 },
      { questionId: 2, earned: 1, max: 1 },
      { questionId: 3, earned: 0, max: 1 },
    ],
  } as QuizResult;
  const before = [
    { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
    { id: 9, attemptNo: 2, earned: null, max: 3, status: 'review' },
  ] as AttemptSummary[];
  const after = [
    { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
    { id: 9, attemptNo: 2, earned: 2, max: 3, status: 'done' },
  ] as AttemptSummary[];

  it('rechargement depuis une tentative à revoir qui n’est pas la dernière : aucune annonce de correction', async () => {
    // Revue #246 : `reload` quitte le message d'attente (#9) AVANT d'avoir choisi la tentative à
    // afficher (#10, la dernière) ; cet état intermédiaire ne doit rien annoncer pour #9.
    const graded10 = { ...graded9, attemptId: 10 } as QuizResult;
    let resolveResult!: (r: QuizResult) => void;
    const onFetchAttemptResult = vi
      .fn()
      .mockResolvedValueOnce(graded10)
      .mockImplementationOnce(() => new Promise<QuizResult>((resolve) => { resolveResult = resolve; }));
    const props = {
      course,
      channel,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts: vi.fn(async () => [
        { id: 9, attemptNo: 1, earned: null, max: 3, status: 'review' },
        { id: 10, attemptNo: 2, earned: 2, max: 3, status: 'done' },
      ] as AttemptSummary[]),
      onFetchAttemptResult,
      onReloadStale: vi.fn(),
    };
    const { rerender } = render(<QuizView {...props} staleNotice={false} />);
    await waitFor(() => expect(screen.getByText('Quiz hebdo — terminé !')).toBeTruthy());
    fireEvent.click(screen.getByText('#1 · à revoir'));
    expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy();

    rerender(<QuizView {...props} staleNotice={true} />);
    // État intermédiaire du rechargement : message d'attente quitté, #9 toujours courante.
    await waitFor(() => expect(screen.getByText('Quiz terminé')).toBeTruthy());
    expect(liveRegion()?.textContent).toBe('');

    await act(async () => {
      resolveResult(graded10);
    });
    await waitFor(() =>
      expect(screen.getByText('#2 · 2/3').getAttribute('aria-pressed')).toBe('true')
    );
    expect(liveRegion()?.textContent).toBe('');
  });

  it('relance aboutie mais lecture du résultat échouée → rechargement : correction annoncée, focus rendu à la puce', async () => {
    // Revue #246 : repli du hook (`reload`). Son état intermédiaire servait de référence, et la
    // vue finale ne paraissait plus changer : ni annonce, ni focus (resté sur <body>).
    let resolveReloadResult!: (r: QuizResult) => void;
    const onFetchAttemptResult = vi
      .fn()
      .mockRejectedValueOnce(new Error('503'))
      .mockImplementationOnce(
        () => new Promise<QuizResult>((resolve) => { resolveReloadResult = resolve; })
      )
      .mockImplementationOnce(() => new Promise<QuizResult>(() => {}));
    const props = {
      course,
      channel,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      onFetchAttemptResult,
    };
    const { rerender } = render(<QuizView {...props} attemptOutcome={null} />);
    await waitFor(() => expect(screen.getByText('#2 · à revoir')).toBeTruthy());
    screen.getByText('#2 · à revoir').focus();

    rerender(<QuizView {...props} attemptOutcome={{ quizId: 55, attemptId: 9, ok: true }} />);
    // État intermédiaire du rechargement (message d'attente quitté, corrigé pas encore lu).
    await waitFor(() => expect(screen.getByText('Quiz terminé')).toBeTruthy());
    expect(onFetchAttemptResult).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveReloadResult(graded9);
    });
    await waitFor(() => expect(screen.getByText('Quiz hebdo — terminé !')).toBeTruthy());
    expect(liveRegion()?.textContent).toBe(GRADED_NOTICE);
    expect(document.activeElement?.textContent).toBe('#2 · 2/3');

    // Autre tentative demandée : l'annonce s'efface dès le chargement, sans attendre sa fin.
    fireEvent.click(screen.getByText('#1 · 2/3'));
    expect(screen.getByRole('status')).toBeTruthy();
    expect(liveRegion()?.textContent).toBe('');
  });

  it('relance aboutie mais rechargement en échec : erreur de chargement, aucune annonce de correction', async () => {
    const onFetchAttemptResult = vi.fn(async () => {
      throw new Error('503');
    });
    const props = {
      course,
      channel,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      onFetchAttemptResult,
    };
    const { rerender } = render(<QuizView {...props} attemptOutcome={null} />);
    await waitFor(() => expect(screen.getByText('#2 · à revoir')).toBeTruthy());

    rerender(<QuizView {...props} attemptOutcome={{ quizId: 55, attemptId: 9, ok: true }} />);
    await waitFor(() => expect(screen.getByText('Réessayer')).toBeTruthy());
    expect(onFetchAttemptResult).toHaveBeenCalledTimes(2);
    expect(liveRegion()?.textContent).toBe('');
  });

  it('pied absent sous le message d’attente d’un quiz SANS reprise (aucun bouton à y mettre)', async () => {
    // Revue #246 : le <footer> était rendu vide, barre de 4rem avec sa bordure.
    const { container } = renderView({
      quiz: makeQuiz({ allowRetry: false }),
      attempts: [{ id: 9, attemptNo: 1, earned: null, max: 3, status: 'review' }],
    });
    await waitFor(() =>
      expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy()
    );
    expect(container.querySelector('footer')).toBeNull();
  });

  it('message d’attente d’un quiz AVEC reprise : le pied ne porte que « Refaire le quiz »', async () => {
    const { container } = renderView({
      attempts: [{ id: 9, attemptNo: 1, earned: null, max: 3, status: 'review' }],
    });
    await waitFor(() =>
      expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy()
    );
    const footer = container.querySelector('footer');
    expect(footer?.textContent).toBe('Refaire le quiz');
  });

  it('focus demandé pour une puce absente (une seule tentative) : pas rendu plus tard à une autre tentative', async () => {
    // Revue #246 : relance aboutie de l'unique tentative #9 → focus demandé pour sa puce, sans
    // barre (une tentative). La demande restait en attente : après « Refaire » et la soumission de
    // #10, la barre à deux puces focalisait #9, qui n'est pas la tentative affichée.
    const graded10 = { ...graded9, attemptId: 10 } as QuizResult;
    const onFetchAttempts = vi
      .fn()
      .mockResolvedValueOnce([{ id: 9, attemptNo: 1, earned: null, max: 3, status: 'review' }])
      .mockResolvedValueOnce([{ id: 9, attemptNo: 1, earned: 2, max: 3, status: 'done' }])
      .mockResolvedValue([
        { id: 9, attemptNo: 1, earned: 2, max: 3, status: 'done' },
        { id: 10, attemptNo: 2, earned: 2, max: 3, status: 'done' },
      ]);
    const props = {
      course,
      channel,
      onFetchQuiz: vi.fn(async () => makeQuiz()),
      onFetchAttempts,
      onFetchAttemptResult: vi.fn(async (_q: number, id: number) => (id === 10 ? graded10 : graded9)),
      onSubmitQuiz: vi.fn(async () => ({ attemptId: 10 })),
    };
    const { rerender } = render(<QuizView {...props} attemptOutcome={null} />);
    await waitFor(() =>
      expect(screen.getByText('Tentative transmise à votre enseignant')).toBeTruthy()
    );
    rerender(<QuizView {...props} attemptOutcome={{ quizId: 55, attemptId: 9, ok: true }} />);
    await waitFor(() => expect(liveRegion()?.textContent).toBe(GRADED_NOTICE));
    expect(screen.queryByText('#1 · 2/3')).toBeNull(); // une seule tentative : pas de barre

    fireEvent.click(screen.getByText('Refaire le quiz'));
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Soumettre'));
    // Verdict poussé de #10 (sinon le sondage de l'historique, toutes les 1,5 s, le trouve).
    rerender(<QuizView {...props} attemptOutcome={{ quizId: 55, attemptId: 10, ok: true }} />);
    await waitFor(
      () => expect(screen.getByText('#2 · 2/3').getAttribute('aria-pressed')).toBe('true'),
      { timeout: 4000 }
    );
    expect(document.activeElement?.textContent).not.toBe('#1 · 2/3');
    expect(document.activeElement).toBe(document.body);
  });

  it('puce dont la lecture échoue puis « Réessayer » : le focus ne va pas à la puce demandée avant l’échec', async () => {
    // Revue #246 : l'écran d'erreur n'a pas de barre, la demande restait en attente ; le
    // rechargement rouvre la DERNIÈRE tentative (#2), et le focus partait sur la puce #1.
    const done = [
      { id: 8, attemptNo: 1, earned: 2, max: 3, status: 'done' },
      { id: 9, attemptNo: 2, earned: 2, max: 3, status: 'done' },
    ] as AttemptSummary[];
    render(
      <QuizView
        course={course}
        channel={channel}
        onFetchQuiz={vi.fn(async () => makeQuiz())}
        onFetchAttempts={vi.fn(async () => done)}
        onFetchAttemptResult={vi.fn(async (_q: number, id: number) => {
          if (id === 8) throw new Error('503');
          return graded9;
        })}
      />
    );
    await waitFor(() => expect(screen.getByText('#2 · 2/3')).toBeTruthy());
    fireEvent.click(screen.getByText('#1 · 2/3'));
    fireEvent.click(await screen.findByText('Réessayer'));
    await waitFor(() =>
      expect(screen.getByText('#2 · 2/3').getAttribute('aria-pressed')).toBe('true')
    );
    expect(document.activeElement?.textContent).not.toBe('#1 · 2/3');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('QuizView — phase résumé & révision', () => {
  /** Passe le quiz en résumé via le grader mock (pas de onSubmitQuiz → correction locale). */
  async function reachSummary() {
    const utils = renderView();
    await waitLoaded();
    // Répond puis va à la dernière question et soumet.
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Soumettre'));
    await waitFor(() => expect(screen.getByText('Quiz terminé')).toBeTruthy());
    return utils;
  }

  it('rend l’écran de résumé (QuizSummary) après soumission', async () => {
    await reachSummary();
    // En-tête de la coquille passé au statut « terminé ».
    expect(screen.getByText('Quiz terminé')).toBeTruthy();
    // QuizSummary affiche son titre « terminé ! ».
    expect(screen.getByText('Quiz hebdo — terminé !')).toBeTruthy();
    // Boutons de pied du résumé.
    expect(screen.getByText('Revoir mes réponses')).toBeTruthy();
    // allowRetry=true → bouton « Refaire le quiz ».
    expect(screen.getByText('Refaire le quiz')).toBeTruthy();
  });

  it('la barre de progression est pleine au résumé', async () => {
    await reachSummary();
    const fill = document.querySelector<HTMLElement>('[class*="progressFill"]');
    expect(fill!.style.width).toBe('100%');
  });

  it('« Revoir mes réponses » ouvre la révision avec un bouton de retour', async () => {
    await reachSummary();
    fireEvent.click(screen.getByText('Revoir mes réponses'));
    // Phase review : bouton « Retour au résumé » dans l'en-tête.
    const back = screen.getByText('Retour au résumé');
    expect(back).toBeTruthy();
    // Retour → on revient au résumé.
    fireEvent.click(back);
    expect(screen.getByText('Quiz terminé')).toBeTruthy();
  });
});

describe('QuizView — staleNotice (quiz modifié à distance)', () => {
  it('front montant false→true en passation → reloadKeepingAnswers + onReloadStale', async () => {
    const onReloadStale = vi.fn();
    const quiz = makeQuiz();
    const onFetchQuiz = vi.fn(async () => quiz);
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const props = {
      course, channel, onFetchQuiz, onFetchAttempts, onReloadStale,
    };
    const { rerender } = render(<QuizView {...props} staleNotice={false} />);
    await waitFor(() => expect(screen.getByText('Question un')).toBeTruthy());

    const fetchCallsBefore = onFetchQuiz.mock.calls.length;
    // Front montant : staleNotice passe à true → rechargement conservant les réponses.
    await act(async () => {
      rerender(<QuizView {...props} staleNotice={true} />);
    });
    await waitFor(() => expect(onReloadStale).toHaveBeenCalledTimes(1));
    // reloadKeepingAnswers a bien redéclenché un fetch du quiz.
    expect(onFetchQuiz.mock.calls.length).toBeGreaterThan(fetchCallsBefore);
    // On reste en passation.
    expect(screen.getByText('Question un')).toBeTruthy();
  });

  it('ne déclenche pas onReloadStale si staleNotice reste false', async () => {
    const { onReloadStale } = renderView({ staleNotice: false });
    await waitLoaded();
    expect(onReloadStale).not.toHaveBeenCalled();
  });

  it('front montant false→true en résumé → reload (rechargement complet) + onReloadStale', async () => {
    const onReloadStale = vi.fn();
    const quiz = makeQuiz();
    const onFetchQuiz = vi.fn(async () => quiz);
    const onFetchAttempts = vi.fn(async () => [] as AttemptSummary[]);
    const onFetchAttemptResult = vi.fn(async () => ({} as QuizResult));
    const props = {
      course, channel, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, onReloadStale,
    };
    const { rerender } = render(<QuizView {...props} staleNotice={false} />);
    await waitFor(() => expect(screen.getByText('Question un')).toBeTruthy());

    // Amène en résumé (grader mock).
    fireEvent.click(screen.getByText('A'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Suivant'));
    fireEvent.click(screen.getByText('Soumettre'));
    await waitFor(() => expect(screen.getByText('Quiz terminé')).toBeTruthy());

    const fetchCallsBefore = onFetchQuiz.mock.calls.length;
    await act(async () => {
      rerender(<QuizView {...props} staleNotice={true} />);
    });
    await waitFor(() => expect(onReloadStale).toHaveBeenCalledTimes(1));
    // reload() recharge complètement le détail.
    expect(onFetchQuiz.mock.calls.length).toBeGreaterThan(fetchCallsBefore);
  });
});

describe('QuizView — labels surchargés', () => {
  it('utilise les libellés fournis (view.next / view.prev)', async () => {
    const quiz = makeQuiz();
    render(
      <QuizView
        course={course}
        channel={channel}
        onFetchQuiz={vi.fn(async () => quiz)}
        onFetchAttempts={vi.fn(async () => [])}
        labels={{ view: { next: 'Next', prev: 'Back' } }}
      />
    );
    await waitFor(() => expect(screen.getByText('Question un')).toBeTruthy());
    expect(screen.getByText('Next')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
  });
});
