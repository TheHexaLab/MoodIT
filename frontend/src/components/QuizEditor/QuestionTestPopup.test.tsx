import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { QuestionTestBody } from './QuestionTestPopup';
import { EditorShell } from './EditorShell';
import { defaultQuestionTestLabels } from './questionTestLabels';
import { emptyQuestionDraft, type QuestionDraft } from './editorTypes';
import { ExecutionBusyError, type CodingTestResult } from '../MainPanel/QuizView/quizAttempt';
import type { Language } from '../../types/domain';
import './editorTestSetup';

afterEach(cleanup);

const t = defaultQuestionTestLabels;

const LANGS: Language[] = [
  { id: 1, name: 'Python' },
  { id: 6, name: 'C' },
];

/** Brouillon « choix unique » : A (correcte, id 10) / B (id 11). */
function choiceDraft(): QuestionDraft {
  return {
    qType: 'single_choice',
    prompt: 'Capitale ?',
    totalScore: 2,
    answers: [
      { id: 10, content: 'Paris', isCorrect: true },
      { id: 11, content: 'Lyon', isCorrect: false },
    ],
  };
}

/** Brouillon « code » Python avec deux harnais (poids 1 et 3). */
function codingDraft(): QuestionDraft {
  return {
    ...emptyQuestionDraft('coding'),
    prompt: 'Écris f',
    totalScore: 4,
    languageId: 1,
    startCode: 'def f(): pass',
    testCases: [
      { name: 'h1', harnessCode: 'assert True', weight: 1 },
      { name: 'h2', harnessCode: 'assert True', weight: 3 },
    ],
  };
}

function renderBody(
  draft: QuestionDraft,
  overrides: Partial<React.ComponentProps<typeof QuestionTestBody>> = {}
) {
  return render(
    <EditorShell title="Tester" onClose={() => {}}>
      <QuestionTestBody draft={draft} languages={LANGS} {...overrides} />
    </EditorShell>
  );
}

function correctButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: t.correct }) as HTMLButtonElement;
}

/** Bouton « Réessayer » du pied (hors popup d'erreur). */
function retryFooterButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: t.retry }) as HTMLButtonElement;
}

describe('QuestionTestBody — rendu', () => {
  it('affiche le bandeau, l’énoncé du brouillon et le barème', () => {
    renderBody(choiceDraft());
    expect(screen.getByText(t.infoBanner)).toBeTruthy();
    expect(screen.getByText('Capitale ?')).toBeTruthy();
    expect(screen.getByText('2 pts')).toBeTruthy();
    expect(correctButton().disabled).toBe(false);
  });

  it('accepte des libellés surchargés', () => {
    renderBody(choiceDraft(), { labels: { correct: 'VÉRIFIER', infoBanner: 'BANDEAU' } });
    expect(screen.getByText('BANDEAU')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'VÉRIFIER' })).toBeTruthy();
  });

  it('question Code : demande le chargement des langages', () => {
    const onRequestLanguages = vi.fn();
    renderBody(codingDraft(), { onRequestLanguages });
    expect(onRequestLanguages).toHaveBeenCalledTimes(1);
  });

  it('question non-Code : ne demande pas les langages', () => {
    const onRequestLanguages = vi.fn();
    renderBody(choiceDraft(), { onRequestLanguages });
    expect(onRequestLanguages).not.toHaveBeenCalled();
  });
});

describe('QuestionTestBody — correction locale (types à réponses)', () => {
  it('bonne réponse → score plein, puis « Réessayer » remet à zéro', () => {
    renderBody(choiceDraft());
    fireEvent.click(screen.getByRole('button', { name: 'Paris' }));
    fireEvent.click(correctButton());
    // Pastille : score obtenu / max.
    expect(screen.getByText('2 / 2 pts')).toBeTruthy();
    // « Corriger » laisse la place à « Réessayer ».
    expect(screen.queryByRole('button', { name: t.correct })).toBeNull();
    fireEvent.click(retryFooterButton());
    // Retour en saisie : barème affiché, réponse vidée.
    expect(screen.getByText('2 pts')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Paris' }).getAttribute('aria-pressed')).toBe('false');
    expect(correctButton()).toBeTruthy();
  });

  it('mauvaise réponse → score nul', () => {
    renderBody(choiceDraft());
    fireEvent.click(screen.getByRole('button', { name: 'Lyon' }));
    fireEvent.click(correctButton());
    expect(screen.getByText('0 / 2 pts')).toBeTruthy();
  });

  it('question Code sans onEvaluateCode : correction locale, sans appel réseau', () => {
    renderBody(codingDraft());
    fireEvent.click(correctButton());
    // La correction locale ne sait pas exécuter le code : on passe quand même en révision.
    expect(retryFooterButton()).toBeTruthy();
  });
});

describe('QuestionTestBody — correction Code via l’API', () => {
  it('envoie langage, code et harnais, puis affiche le score pondéré', async () => {
    const tests: CodingTestResult[] = [
      { name: 'h1', passed: true, weight: 1 },
      { name: 'h2', passed: false, weight: 3 },
    ];
    const onEvaluateCode = vi.fn().mockResolvedValue(tests);
    renderBody(codingDraft(), { onEvaluateCode });
    fireEvent.click(correctButton());

    expect(onEvaluateCode).toHaveBeenCalledTimes(1);
    const input = onEvaluateCode.mock.calls[0][0];
    expect(input.language).toBe('Python');
    expect(input.languageId).toBe(1);
    expect(input.code).toBe('def f(): pass');
    expect(input.testCases.map((tc: { name: string }) => tc.name)).toEqual(['h1', 'h2']);

    // 4 × (1 / 4) = 1 point.
    expect(await screen.findByText('1 / 4 pts')).toBeTruthy();
    expect(screen.getByText('h1')).toBeTruthy();
    expect(screen.getByText('h2')).toBeTruthy();
  });

  it('arrondit le score au dixième', async () => {
    const draft = { ...codingDraft(), totalScore: 1 };
    const onEvaluateCode = vi.fn().mockResolvedValue([
      { name: 'a', passed: true, weight: 1 },
      { name: 'b', passed: false, weight: 2 },
    ]);
    renderBody(draft, { onEvaluateCode });
    fireEvent.click(correctButton());
    // 1 × 1/3 = 0.333… → 0.3
    expect(await screen.findByText('0.3 / 1 pts')).toBeTruthy();
  });

  it('aucun harnais (poids total nul) → score 0', async () => {
    const onEvaluateCode = vi.fn().mockResolvedValue([]);
    renderBody(codingDraft(), { onEvaluateCode });
    fireEvent.click(correctButton());
    expect(await screen.findByText('0 / 4 pts')).toBeTruthy();
  });

  it('pendant l’évaluation, le bouton est désactivé (spinner)', async () => {
    let resolve!: (v: CodingTestResult[]) => void;
    const onEvaluateCode = vi.fn(
      () => new Promise<CodingTestResult[]>((r) => (resolve = r))
    );
    renderBody(codingDraft(), { onEvaluateCode });
    const btn = correctButton();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    // Le libellé est remplacé par le spinner.
    expect(btn.textContent).not.toContain(t.correct);
    resolve([{ name: 'h1', passed: true, weight: 1 }]);
    expect(await screen.findByText('4 / 4 pts')).toBeTruthy();
  });

  it('échec de l’évaluation → popup d’erreur ; « Réessayer » relance la correction', async () => {
    const onEvaluateCode = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ name: 'h1', passed: true, weight: 1 }]);
    renderBody(codingDraft(), { onEvaluateCode });
    fireEvent.click(correctButton());

    const dialog = await screen.findByRole('alertdialog', { name: 'Une erreur est survenue' });
    expect(within(dialog).getByText(t.evalError)).toBeTruthy();
    // Toujours en saisie : le bouton « Corriger » est réactivé.
    expect(correctButton().disabled).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(onEvaluateCode).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('4 / 4 pts')).toBeTruthy();
    expect(screen.queryByText(t.evalError)).toBeNull();
  });

  it('service d’exécution saturé (429) → popup d’erreur avec le message dédié', async () => {
    const onEvaluateCode = vi.fn().mockRejectedValue(new ExecutionBusyError());
    renderBody(codingDraft(), { onEvaluateCode });
    fireEvent.click(correctButton());

    const dialog = await screen.findByRole('alertdialog', { name: 'Une erreur est survenue' });
    expect(within(dialog).getByText(t.evalBusy)).toBeTruthy();
    expect(within(dialog).queryByText(t.evalError)).toBeNull();
  });

  it('échec de l’évaluation → « Fermer » masque la popup sans relancer', async () => {
    const onEvaluateCode = vi.fn().mockRejectedValue(new Error('boom'));
    renderBody(codingDraft(), { onEvaluateCode });
    fireEvent.click(correctButton());
    const dialog = await screen.findByRole('alertdialog', { name: 'Une erreur est survenue' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByText(t.evalError)).toBeNull());
    expect(onEvaluateCode).toHaveBeenCalledTimes(1);
  });

  it('transmet onRunCode à l’éditeur (bouton « play » visible)', () => {
    const onRunCode = vi.fn();
    renderBody(codingDraft(), { onRunCode });
    expect(screen.getByRole('button', { name: 'Exécuter' })).toBeTruthy();
  });
});
