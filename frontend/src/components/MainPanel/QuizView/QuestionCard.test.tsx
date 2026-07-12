import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QuestionCard } from './QuestionCard';
import { QUESTION_TYPE_LABELS, type Question } from '../../../types/domain';
import type { QuestionResult } from './quizAttempt';

/**
 * Carte d'une question : badge de type, « Question N », pastille de points (barème en
 * passation, score coloré en révision) et variante `bare`. Le contenu propre au type est
 * fourni en children — ici on passe un enfant sentinelle pour isoler la coquille.
 */

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const codingQuestion: Question = {
  id: 7,
  prompt: '# Ma question\nRésous ceci',
  qType: 'coding',
  totalScore: 10,
};

function renderCard(props: Partial<Parameters<typeof QuestionCard>[0]> = {}) {
  return render(
    <QuestionCard question={codingQuestion} index={2} {...props}>
      <div data-testid="child">contenu</div>
    </QuestionCard>
  );
}

describe('QuestionCard', () => {
  it('affiche le badge de type via QUESTION_TYPE_LABELS', () => {
    renderCard();
    expect(screen.getByText(QUESTION_TYPE_LABELS.coding)).toBeTruthy();
    // Slug 'coding' → libellé FR « Code ».
    expect(QUESTION_TYPE_LABELS.coding).toBe('Code');
  });

  it('affiche « Question N » (index 0-based → N = index + 1)', () => {
    renderCard();
    expect(screen.getByText('Question 3')).toBeTruthy();
  });

  it('rend le prompt Markdown et les children', () => {
    renderCard();
    expect(screen.getByText('Ma question')).toBeTruthy();
    expect(screen.getByTestId('child')).toBeTruthy();
  });

  it('pastille de points : barème « 10 pts » en passation (sans result)', () => {
    renderCard();
    expect(screen.getByText('10 pts')).toBeTruthy();
    // Aucun affichage de score obtenu en passation.
    expect(screen.queryByText(/\/ .* pts/)).toBeNull();
  });

  it('pastille de points : « earned / max pts » en révision (avec result)', () => {
    const result: QuestionResult = { questionId: 7, earned: 5, max: 5 };
    renderCard({ result });
    expect(screen.getByText('5 / 5 pts')).toBeTruthy();
  });

  it('pastille colorée « bonne » (vert) quand earned === max', () => {
    const result: QuestionResult = { questionId: 7, earned: 5, max: 5 };
    const { container } = renderCard({ result });
    const pill = screen.getByText('5 / 5 pts');
    // scoreTone(5,5) = good → classe pointsFull appliquée.
    expect(pill.className).toMatch(/pointsFull/);
    expect(container.querySelector('.pointsZero, [class*="pointsZero"]')).toBeNull();
  });

  it('pastille colorée « nulle » (rouge) quand earned = 0', () => {
    const result: QuestionResult = { questionId: 7, earned: 0, max: 10 };
    renderCard({ result });
    const pill = screen.getByText('0 / 10 pts');
    expect(pill.className).toMatch(/pointsZero/);
  });

  it('pastille colorée « partielle » (jaune) pour un score intermédiaire', () => {
    // 6/10 = 60 % → tone warn → pointsPartial.
    const result: QuestionResult = { questionId: 7, earned: 6, max: 10 };
    renderCard({ result });
    expect(screen.getByText('6 / 10 pts').className).toMatch(/pointsPartial/);
  });

  it('variante `bare` : ajoute la classe cardBare', () => {
    const { container } = renderCard({ bare: true });
    const article = container.querySelector('article');
    expect(article?.className).toMatch(/cardBare/);
  });

  it('sans `bare` : pas de classe cardBare', () => {
    const { container } = renderCard();
    const article = container.querySelector('article');
    expect(article?.className).not.toMatch(/cardBare/);
  });

  it('respecte les labels surchargés (questionLabel / points / score)', () => {
    renderCard({
      labels: {
        questionLabel: (n) => `Q#${n}`,
        points: (v) => `${v} points`,
      },
    });
    expect(screen.getByText('Q#3')).toBeTruthy();
    expect(screen.getByText('10 points')).toBeTruthy();
  });

  it('badge distinct pour un autre type (Vrai/Faux)', () => {
    const q: Question = { id: 1, prompt: 'Vrai ?', qType: 'true_false', totalScore: 2 };
    render(
      <QuestionCard question={q} index={0}>
        <span>x</span>
      </QuestionCard>
    );
    expect(screen.getByText('Vrai/Faux')).toBeTruthy();
    expect(screen.getByText('Question 1')).toBeTruthy();
    expect(screen.getByText('2 pts')).toBeTruthy();
  });
});
