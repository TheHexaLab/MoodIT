import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuizSummary } from './QuizSummary';
import { QUESTION_TYPE_LABELS, type Quiz } from '../../../types/domain';
import type { AttemptSummary, QuizResult } from './quizAttempt';

/**
 * Écran récapitulatif : score global (pourcentage + palier), barre de sélection des
 * tentatives (≥ 2), et liste cliquable par question (ouvre la révision). On teste le
 * rendu (textes/scores), la sélection de tentative, et la navigation en révision.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const quiz: Quiz = {
  id: 1,
  title: 'Mon quiz',
  questions: [
    { id: 10, prompt: '## Première question\nblabla', qType: 'single_choice', totalScore: 5 },
    { id: 11, prompt: 'Deuxième', qType: 'coding', totalScore: 10 },
  ],
};

// 8/15 = 53.3 % → tone warn.
const result: QuizResult = {
  quizId: 1,
  earned: 8,
  max: 15,
  questions: [
    { questionId: 10, earned: 5, max: 5 },
    { questionId: 11, earned: 3, max: 10, tests: [] },
  ],
};

function renderSummary(overrides: {
  attempts?: AttemptSummary[];
  currentAttemptId?: number | null;
  onSelectAttempt?: (id: number) => void;
  onReview?: (index: number) => void;
  result?: QuizResult;
} = {}) {
  const onSelectAttempt = overrides.onSelectAttempt ?? vi.fn();
  const onReview = overrides.onReview ?? vi.fn();
  render(
    <QuizSummary
      quiz={quiz}
      result={overrides.result ?? result}
      attempts={overrides.attempts ?? []}
      currentAttemptId={overrides.currentAttemptId ?? null}
      onSelectAttempt={onSelectAttempt}
      onReview={onReview}
    />
  );
  return { onSelectAttempt, onReview };
}

describe('QuizSummary', () => {
  it('affiche le titre « terminé » et le pourcentage global', () => {
    renderSummary();
    expect(screen.getByText('Mon quiz — terminé !')).toBeTruthy();
    // 8/15 → 53.3 %.
    expect(screen.getByText('53.3 %')).toBeTruthy();
  });

  it('affiche le sous-titre score + nombre de questions parfaites', () => {
    renderSummary();
    // 1 question parfaite (10 → 5/5) sur 2 ; 5/10 code n'est pas parfait.
    expect(screen.getByText(/8 \/ 15 points/)).toBeTruthy();
    expect(screen.getByText(/1 question parfaite sur 2/)).toBeTruthy();
  });

  it('liste chaque question avec son badge de type et son score', () => {
    renderSummary();
    expect(screen.getByText(QUESTION_TYPE_LABELS.single_choice)).toBeTruthy();
    expect(screen.getByText(QUESTION_TYPE_LABELS.coding)).toBeTruthy();
    // Énoncé court dérivé de la première ligne (marques Markdown retirées).
    expect(screen.getByText('Première question')).toBeTruthy();
    expect(screen.getByText('Deuxième')).toBeTruthy();
    // Scores de ligne.
    expect(screen.getByText('5 / 5')).toBeTruthy();
    expect(screen.getByText('3 / 10')).toBeTruthy();
  });

  it('clic sur une ligne → onReview(index)', () => {
    const { onReview } = renderSummary();
    fireEvent.click(screen.getByText('Première question'));
    expect(onReview).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByText('Deuxième'));
    expect(onReview).toHaveBeenCalledWith(1);
  });

  it('sans plusieurs tentatives : pas de barre de sélection', () => {
    renderSummary({ attempts: [{ id: 100, attemptNo: 1, earned: 8, max: 15 }] });
    expect(screen.queryByText('Tentatives')).toBeNull();
  });

  it('avec ≥ 2 tentatives : barre de sélection + meilleur score', () => {
    const attempts: AttemptSummary[] = [
      { id: 100, attemptNo: 1, earned: 8, max: 15 },
      { id: 101, attemptNo: 2, earned: 15, max: 15 },
    ];
    renderSummary({ attempts, currentAttemptId: 100 });
    expect(screen.getByText('Tentatives')).toBeTruthy();
    // Meilleur score = 100 % (tentative 2).
    expect(screen.getByText('Meilleur score : 100 %')).toBeTruthy();
    // Une puce par tentative.
    expect(screen.getByText('#1 · 8/15')).toBeTruthy();
    expect(screen.getByText('#2 · 15/15')).toBeTruthy();
  });

  it('clic sur une puce de tentative → onSelectAttempt(id)', () => {
    const attempts: AttemptSummary[] = [
      { id: 100, attemptNo: 1, earned: 8, max: 15 },
      { id: 101, attemptNo: 2, earned: 15, max: 15 },
    ];
    const { onSelectAttempt } = renderSummary({ attempts, currentAttemptId: 100 });
    fireEvent.click(screen.getByText('#2 · 15/15'));
    expect(onSelectAttempt).toHaveBeenCalledWith(101);
  });

  it('marque la tentative courante (classe active)', () => {
    const attempts: AttemptSummary[] = [
      { id: 100, attemptNo: 1, earned: 8, max: 15 },
      { id: 101, attemptNo: 2, earned: 15, max: 15 },
    ];
    renderSummary({ attempts, currentAttemptId: 101 });
    const activeChip = screen.getByText('#2 · 15/15');
    const otherChip = screen.getByText('#1 · 8/15');
    expect(activeChip.className).toMatch(/attemptChipActive/);
    expect(otherChip.className).not.toMatch(/attemptChipActive/);
  });

  it('question Code non évaluée (tests null) → « en attente », score « en validation »', () => {
    const pendingResult: QuizResult = {
      quizId: 1,
      earned: 5,
      max: 15,
      questions: [
        { questionId: 10, earned: 5, max: 5 },
        { questionId: 11, earned: 0, max: 10, tests: null },
      ],
    };
    renderSummary({ result: pendingResult });
    // Titre « soumis » (pas « terminé »), score global masqué (« - »).
    expect(screen.getByText('Mon quiz — soumis')).toBeTruthy();
    expect(screen.getByText('-')).toBeTruthy();
    expect(screen.getByText('En attente…')).toBeTruthy();
  });

  it('score parfait → titre « terminé » et 100 %', () => {
    const perfect: QuizResult = {
      quizId: 1,
      earned: 15,
      max: 15,
      questions: [
        { questionId: 10, earned: 5, max: 5 },
        { questionId: 11, earned: 10, max: 10, tests: [] },
      ],
    };
    renderSummary({ result: perfect });
    expect(screen.getByText('100 %')).toBeTruthy();
    expect(screen.getByText(/2 questions parfaites sur 2/)).toBeTruthy();
  });
});
