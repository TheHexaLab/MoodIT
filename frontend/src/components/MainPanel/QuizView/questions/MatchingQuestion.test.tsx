import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MatchingQuestion } from './MatchingQuestion';
import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

afterEach(cleanup);

function matchingQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 1,
    prompt: 'Prompt',
    qType: 'matching',
    totalScore: 4,
    dragItems: [
      { id: 200, content: 'Chien', groupName: 'Animaux' },
      { id: 201, content: 'Rose', groupName: 'Plantes' },
      { id: 202, content: 'Chat', groupName: 'Animaux' },
    ],
    groups: ['Animaux', 'Plantes'],
    ...overrides,
  };
}

const noop = () => {};

/** Zone (pool ou groupe) par son attribut data-zone. */
function zone(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-zone="${name}"]`);
}

describe('MatchingQuestion — rendu (mode answer)', () => {
  it('affiche le texte d’aide', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Glisse chaque étiquette dans la catégorie qui convient.')).toBeTruthy();
  });

  it('rend une zone par catégorie (question.groups) + la réserve (pool)', () => {
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(zone(container, '__pool__')).toBeTruthy();
    expect(zone(container, 'Animaux')).toBeTruthy();
    expect(zone(container, 'Plantes')).toBeTruthy();
  });

  it('affiche le libellé de chaque catégorie', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Animaux')).toBeTruthy();
    expect(screen.getByText('Plantes')).toBeTruthy();
  });

  it('sans placement : tous les items sont dans le pool', () => {
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    const pool = zone(container, '__pool__')!;
    expect(pool.textContent).toContain('Chien');
    expect(pool.textContent).toContain('Rose');
    expect(pool.textContent).toContain('Chat');
  });

  it('placement partiel : items classés dans leur zone, le reste au pool', () => {
    const answer: QuestionAnswer = {
      kind: 'matching',
      placement: { 200: 'Animaux', 201: null, 202: null },
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const animaux = zone(container, 'Animaux')!;
    const pool = zone(container, '__pool__')!;
    expect(animaux.textContent).toContain('Chien');
    expect(animaux.textContent).not.toContain('Rose');
    expect(pool.textContent).toContain('Rose');
    expect(pool.textContent).toContain('Chat');
    expect(pool.textContent).not.toContain('Chien');
  });

  it('deux items placés dans la même zone y apparaissent tous les deux', () => {
    const answer: QuestionAnswer = {
      kind: 'matching',
      placement: { 200: 'Animaux', 202: 'Animaux', 201: 'Plantes' },
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const animaux = zone(container, 'Animaux')!;
    expect(animaux.textContent).toContain('Chien');
    expect(animaux.textContent).toContain('Chat');
    expect(zone(container, 'Plantes')!.textContent).toContain('Rose');
    expect(zone(container, '__pool__')!.textContent).toBe('');
  });

  it('sans question.groups : catégories dérivées des groupName des items (triées)', () => {
    const q = matchingQuestion({ groups: undefined });
    const { container } = render(
      <MatchingQuestion question={q} mode="answer" answer={undefined} onChange={noop} />
    );
    expect(zone(container, 'Animaux')).toBeTruthy();
    expect(zone(container, 'Plantes')).toBeTruthy();
  });
});

describe('MatchingQuestion — mode review', () => {
  it('une ligne par item corrigé avec sa catégorie choisie', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 2,
      max: 4,
      matching: [
        { itemId: 200, chosenGroup: 'Animaux', correctGroup: 'Animaux', correct: true },
        { itemId: 201, chosenGroup: 'Animaux', correctGroup: 'Plantes', correct: false },
      ],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(screen.getByText('Chien')).toBeTruthy();
    expect(screen.getByText('Rose')).toBeTruthy();
    // Deux occurrences de « Animaux » (choix des deux items).
    expect(screen.getAllByText('Animaux')).toHaveLength(2);
  });

  it('item correct → optionCorrect ; incorrect → optionWrong', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 2,
      max: 4,
      matching: [
        { itemId: 200, chosenGroup: 'Animaux', correctGroup: 'Animaux', correct: true },
        { itemId: 201, chosenGroup: 'Animaux', correctGroup: 'Plantes', correct: false },
      ],
    };
    const { container } = render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Les lignes externes portent optionCorrect / optionWrong (une par item corrigé).
    const correctRows = container.querySelectorAll('[class*="optionCorrect"]');
    const wrongRows = container.querySelectorAll('[class*="optionWrong"]');
    expect(correctRows).toHaveLength(1);
    expect(wrongRows).toHaveLength(1);
    // La ligne « Chien » (correcte) contient le libellé de sa catégorie.
    expect(correctRows[0].textContent).toContain('Chien');
    expect(wrongRows[0].textContent).toContain('Rose');
  });

  it('chosenGroup null → affiche le libellé « non classé » (unplacedGroup)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 4,
      matching: [{ itemId: 200, chosenGroup: null, correctGroup: 'Animaux', correct: false }],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Défaut FR de unplacedGroup = '—'.
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('surcharge du libellé « non classé » via labels', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 4,
      matching: [{ itemId: 200, chosenGroup: null, correctGroup: 'Animaux', correct: false }],
    };
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
        labels={{ unplacedGroup: 'NON CLASSÉ' }}
      />
    );
    expect(screen.getByText('NON CLASSÉ')).toBeTruthy();
  });

  it('review sans matching : aucune ligne, pas de crash', () => {
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="review"
        answer={undefined}
        result={{ questionId: 1, earned: 0, max: 4 }}
        onChange={noop}
      />
    );
    expect(screen.queryByText('Chien')).toBeNull();
  });

  it('onChange n’est pas appelé au rendu', () => {
    const onChange = vi.fn();
    render(
      <MatchingQuestion
        question={matchingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={onChange}
      />
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
