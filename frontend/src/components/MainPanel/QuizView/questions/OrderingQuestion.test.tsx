import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { OrderingQuestion } from './OrderingQuestion';
import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

afterEach(cleanup);

function orderingQuestion(): Question {
  return {
    id: 1,
    prompt: 'Prompt',
    qType: 'ordering',
    totalScore: 3,
    dragItems: [
      { id: 100, content: 'Alpha', correctOrder: 0 },
      { id: 101, content: 'Beta', correctOrder: 1 },
      { id: 102, content: 'Gamma', correctOrder: 2 },
    ],
  };
}

const noop = () => {};


describe('OrderingQuestion — rendu (mode answer)', () => {
  it('rend les éléments dans l’ordre de answer.itemIds', () => {
    const answer: QuestionAnswer = { kind: 'ordering', itemIds: [102, 100, 101] };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Gamma');
    expect(items[1].textContent).toContain('Alpha');
    expect(items[2].textContent).toContain('Beta');
  });

  it('numérote les positions à partir de 1', () => {
    const answer: QuestionAnswer = { kind: 'ordering', itemIds: [100, 101, 102] };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('1');
    expect(items[1].textContent).toContain('2');
    expect(items[2].textContent).toContain('3');
  });

  it('sans answer d’ordering : ordre par défaut = ordre des dragItems', () => {
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Alpha');
    expect(items[1].textContent).toContain('Beta');
    expect(items[2].textContent).toContain('Gamma');
  });

  it('affiche le texte d’aide en mode answer', () => {
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Glisse les éléments pour les réordonner.')).toBeTruthy();
  });

  it('rend une poignée (data-reorder-id) par ligne en mode answer', () => {
    const answer: QuestionAnswer = { kind: 'ordering', itemIds: [100, 101, 102] };
    const { container } = render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const handles = container.querySelectorAll('[data-reorder-id]');
    expect(handles).toHaveLength(3);
    expect(handles[0].getAttribute('data-reorder-id')).toBe('100');
  });

  it('question sans dragItems : liste vide', () => {
    const q: Question = { id: 1, prompt: 'p', qType: 'ordering', totalScore: 1 };
    render(<OrderingQuestion question={q} mode="answer" answer={undefined} onChange={noop} />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('un id inconnu dans answer.itemIds est ignoré (pas de ligne)', () => {
    const answer: QuestionAnswer = { kind: 'ordering', itemIds: [100, 999, 101] };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Alpha');
    expect(items[1].textContent).toContain('Beta');
  });
});

describe('OrderingQuestion — mode review', () => {
  it('affiche l’ordre soumis (result.submittedOrder)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 1,
      max: 3,
      correctOrder: [100, 101, 102],
      submittedOrder: [101, 100, 102],
    };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Beta');
    expect(items[1].textContent).toContain('Alpha');
    expect(items[2].textContent).toContain('Gamma');
  });

  it('pas de texte d’aide en review', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 3,
      max: 3,
      correctOrder: [100, 101, 102],
      submittedOrder: [100, 101, 102],
    };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(screen.queryByText('Glisse les éléments pour les réordonner.')).toBeNull();
  });

  it('pas de poignée (data-reorder-id) en review', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 3,
      max: 3,
      correctOrder: [100, 101, 102],
      submittedOrder: [100, 101, 102],
    };
    const { container } = render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(container.querySelectorAll('[data-reorder-id]')).toHaveLength(0);
  });

  it('ligne à la bonne position → classe optionCorrect ; mauvaise → optionWrong', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 1,
      max: 3,
      correctOrder: [100, 101, 102],
      submittedOrder: [100, 102, 101],
    };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    // Position 0 : 100 attendu, 100 soumis → correct.
    expect(items[0].className).toContain('optionCorrect');
    // Position 1 : 101 attendu, 102 soumis → wrong.
    expect(items[1].className).toContain('optionWrong');
    // Position 2 : 102 attendu, 101 soumis → wrong.
    expect(items[2].className).toContain('optionWrong');
  });

  it('review sans submittedOrder : se rabat sur l’ordre de base (answer)', () => {
    const answer: QuestionAnswer = { kind: 'ordering', itemIds: [102, 101, 100] };
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 3,
      correctOrder: [100, 101, 102],
    };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={answer}
        result={result}
        onChange={noop}
      />
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Gamma');
    expect(items[2].textContent).toContain('Alpha');
  });

  it('onChange n’est pas appelé au rendu review', () => {
    const onChange = vi.fn();
    const result: QuestionResult = {
      questionId: 1,
      earned: 3,
      max: 3,
      correctOrder: [100, 101, 102],
      submittedOrder: [100, 101, 102],
    };
    render(
      <OrderingQuestion
        question={orderingQuestion()}
        mode="review"
        answer={undefined}
        result={result}
        onChange={onChange}
      />
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
