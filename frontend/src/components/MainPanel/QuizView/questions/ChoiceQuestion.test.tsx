import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChoiceQuestion } from './ChoiceQuestion';
import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

afterEach(cleanup);

/** Question « à options » minimale valide (V/F, choix unique ou multiple). */
function choiceQuestion(qType: Question['qType']): Question {
  return {
    id: 1,
    prompt: 'Prompt',
    qType,
    totalScore: 1,
    answers: [
      { id: 10, content: 'Option A' },
      { id: 11, content: 'Option B' },
      { id: 12, content: 'Option C' },
    ],
  };
}

const noop = () => {};

/** Récupère les boutons d'option dans l'ordre de rendu. */
function optionButtons(): HTMLButtonElement[] {
  return screen.getAllByRole('button') as HTMLButtonElement[];
}

describe('ChoiceQuestion — rendu', () => {
  it('rend une option (bouton) par réponse avec son libellé', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(optionButtons()).toHaveLength(3);
    expect(screen.getByText('Option A')).toBeTruthy();
    expect(screen.getByText('Option B')).toBeTruthy();
    expect(screen.getByText('Option C')).toBeTruthy();
  });

  it('choix multiple : affiche le texte d’aide', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Plusieurs réponses possibles.')).toBeTruthy();
  });

  it('choix unique : pas de texte d’aide « choix multiple »', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.queryByText('Plusieurs réponses possibles.')).toBeNull();
  });

  it('surcharge du libellé d’aide via labels', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        labels={{ multipleHelper: 'AIDE PERSO' }}
      />
    );
    expect(screen.getByText('AIDE PERSO')).toBeTruthy();
  });

  it('question sans answers : ne rend aucune option', () => {
    const q: Question = { id: 1, prompt: 'p', qType: 'single_choice', totalScore: 1 };
    render(<ChoiceQuestion question={q} mode="answer" answer={undefined} onChange={noop} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('ChoiceQuestion — aria-pressed (mode answer)', () => {
  it('reflète la sélection courante et neutre pour les autres', () => {
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [11] };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="answer"
        answer={answer}
        onChange={noop}
      />
    );
    const [a, b, c] = optionButtons();
    expect(a.getAttribute('aria-pressed')).toBe('false');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(c.getAttribute('aria-pressed')).toBe('false');
  });

  it('en review, aria-pressed est absent (undefined)', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={{ questionId: 1, earned: 0, max: 1, correctAnswerIds: [10], selectedAnswerIds: [] }}
        onChange={noop}
      />
    );
    for (const btn of optionButtons()) {
      expect(btn.getAttribute('aria-pressed')).toBeNull();
    }
  });
});

describe('ChoiceQuestion — interaction choix unique', () => {
  it('clic sur une option → onChange({kind:choice, answerIds:[id]})', () => {
    const onChange = vi.fn();
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="answer"
        answer={undefined}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[1]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [11] });
  });

  it('choix unique : une nouvelle sélection REMPLACE l’ancienne', () => {
    const onChange = vi.fn();
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [10] };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="answer"
        answer={answer}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[2]);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [12] });
  });

  it('true_false se comporte comme un choix unique (remplace)', () => {
    const onChange = vi.fn();
    const q: Question = {
      id: 1,
      prompt: 'p',
      qType: 'true_false',
      totalScore: 1,
      answers: [
        { id: 1, content: 'Vrai' },
        { id: 2, content: 'Faux' },
      ],
    };
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [1] };
    render(<ChoiceQuestion question={q} mode="answer" answer={answer} onChange={onChange} />);
    fireEvent.click(optionButtons()[1]);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [2] });
  });
});

describe('ChoiceQuestion — interaction choix multiple', () => {
  it('clic sur une option non sélectionnée l’AJOUTE', () => {
    const onChange = vi.fn();
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [10] };
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="answer"
        answer={answer}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[1]);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [10, 11] });
  });

  it('clic sur une option déjà sélectionnée la RETIRE', () => {
    const onChange = vi.fn();
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [10, 11] };
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="answer"
        answer={answer}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[0]);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [11] });
  });

  it('premier clic sans réponse initiale crée un tableau à un id', () => {
    const onChange = vi.fn();
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="answer"
        answer={undefined}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[2]);
    expect(onChange).toHaveBeenCalledWith({ kind: 'choice', answerIds: [12] });
  });
});

describe('ChoiceQuestion — mode review (disabled + surlignage)', () => {
  it('toutes les options sont disabled en review', () => {
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={{ questionId: 1, earned: 1, max: 1, correctAnswerIds: [10], selectedAnswerIds: [10] }}
        onChange={noop}
      />
    );
    for (const btn of optionButtons()) expect(btn.disabled).toBe(true);
  });

  it('clic en review n’appelle PAS onChange', () => {
    const onChange = vi.fn();
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={{ questionId: 1, earned: 1, max: 1, correctAnswerIds: [10], selectedAnswerIds: [10] }}
        onChange={onChange}
      />
    );
    fireEvent.click(optionButtons()[0]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('option correcte ET choisie → classe optionCorrect', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 1,
      max: 1,
      correctAnswerIds: [10],
      selectedAnswerIds: [10],
    };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(optionButtons()[0].className).toContain('optionCorrect');
  });

  it('option incorrecte mais choisie → classe optionWrong', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 1,
      correctAnswerIds: [10],
      selectedAnswerIds: [11],
    };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Option B (index 1) : choisie à tort.
    expect(optionButtons()[1].className).toContain('optionWrong');
  });

  it('aucune réponse soumise : la bonne réponse est signalée « manquée » (optionWrongMissed)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 1,
      correctAnswerIds: [10],
      selectedAnswerIds: [],
    };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    expect(optionButtons()[0].className).toContain('optionWrongMissed');
  });

  it('réponse soumise mais fausse : la bonne réponse manquée est en vert (optionCorrectMissed)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 0,
      max: 1,
      correctAnswerIds: [10],
      selectedAnswerIds: [11],
    };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Option A (correcte, non choisie, une réponse soumise ailleurs).
    expect(optionButtons()[0].className).toContain('optionCorrectMissed');
  });

  it('choix multiple : distracteur bien évité → optionCorrectMissed (contour vert)', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 1,
      max: 1,
      correctAnswerIds: [10],
      selectedAnswerIds: [10],
    };
    render(
      <ChoiceQuestion
        question={choiceQuestion('multiple_choice')}
        mode="review"
        answer={undefined}
        result={result}
        onChange={noop}
      />
    );
    // Options B et C : ni correctes ni choisies → en choix multiple, contour vert.
    expect(optionButtons()[1].className).toContain('optionCorrectMissed');
    expect(optionButtons()[2].className).toContain('optionCorrectMissed');
  });

  it('review sans result : se rabat sur `answer` pour les ids choisis', () => {
    const answer: QuestionAnswer = { kind: 'choice', answerIds: [11] };
    render(
      <ChoiceQuestion
        question={choiceQuestion('single_choice')}
        mode="review"
        answer={answer}
        onChange={noop}
      />
    );
    // Pas de correctAnswerIds → aucune option « correcte » ; l'option choisie (B) est fausse.
    expect(optionButtons()[1].className).toContain('optionWrong');
  });
});
