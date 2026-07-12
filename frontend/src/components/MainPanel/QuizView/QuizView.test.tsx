import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import QuizView from './QuizView';
import type { Course, CourseChannel, Quiz } from '../../../types/domain';
import type { AttemptSummary, QuizResult } from './quizAttempt';

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
      onSubmitQuiz={onSubmitQuiz}
      staleNotice={opts.staleNotice ?? false}
      onReloadStale={onReloadStale}
    />
  );
  return { ...utils, quiz, onFetchQuiz, onFetchAttempts, onFetchAttemptResult, onReloadStale };
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
