import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CodingQuestion } from './CodingQuestion';
import { type Question } from '../../../../types/domain';
import { type QuestionAnswer, type QuestionResult } from '../quizAttempt';

// jsdom ne fournit pas ResizeObserver, utilisé par CodeEditor (auto-dimensionnement).
// On pose un stub inerte (aucun comportement à observer sous jsdom).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

afterEach(cleanup);

/** Question Code minimale. `languageName` alimente question.language.name. */
function codingQuestion(languageName = 'Python', overrides: Partial<Question> = {}): Question {
  return {
    id: 1,
    prompt: 'Prompt',
    qType: 'coding',
    totalScore: 5,
    startCode: 'print("hi")',
    language: { id: 1, name: languageName },
    ...overrides,
  };
}

const noop = () => {};

/** Le textarea de l'éditeur de code (aria-label = codeAria(langue)). */
function codeTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

/** Le bouton « play » s'il est présent (aria-label = runLabel « Exécuter »). */
function runButton(): HTMLButtonElement | null {
  return screen.queryByRole('button', { name: 'Exécuter' }) as HTMLButtonElement | null;
}

describe('CodingQuestion — rendu de l’éditeur', () => {
  it('pré-remplit avec answer.code quand présent', () => {
    const answer: QuestionAnswer = { kind: 'coding', code: 'let x = 1;' };
    render(
      <CodingQuestion question={codingQuestion()} mode="answer" answer={answer} onChange={noop} />
    );
    expect(codeTextarea().value).toBe('let x = 1;');
  });

  it('se rabat sur question.startCode sans réponse', () => {
    render(
      <CodingQuestion
        question={codingQuestion()}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(codeTextarea().value).toBe('print("hi")');
  });

  it('code vide si ni answer ni startCode', () => {
    const q = codingQuestion('Python', { startCode: undefined });
    render(<CodingQuestion question={q} mode="answer" answer={undefined} onChange={noop} />);
    expect(codeTextarea().value).toBe('');
  });

  it('aria-label du textarea reflète le langage', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByLabelText('Éditeur de code (Python)')).toBeTruthy();
  });

  it('affiche l’étiquette du langage', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(screen.getByText('Python')).toBeTruthy();
  });
});

describe('CodingQuestion — saisie (onChange)', () => {
  it('la frappe remonte onChange({kind:coding, code})', () => {
    const onChange = vi.fn();
    render(
      <CodingQuestion
        question={codingQuestion()}
        mode="answer"
        answer={{ kind: 'coding', code: '' }}
        onChange={onChange}
      />
    );
    fireEvent.change(codeTextarea(), { target: { value: 'x = 42' } });
    expect(onChange).toHaveBeenCalledWith({ kind: 'coding', code: 'x = 42' });
  });
});

describe('CodingQuestion — bouton play (onRunCode + runnable)', () => {
  it('langage exécutable + onRunCode + mode answer → bouton présent', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        onRunCode={vi.fn()}
      />
    );
    expect(runButton()).not.toBeNull();
  });

  it('clic play appelle onRunCode avec {language, code}', () => {
    const onRunCode = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      compileOutput: null,
      timedOut: false,
    });
    const answer: QuestionAnswer = { kind: 'coding', code: 'print(1)' };
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="answer"
        answer={answer}
        onChange={noop}
        onRunCode={onRunCode}
      />
    );
    fireEvent.click(runButton()!);
    expect(onRunCode).toHaveBeenCalledWith({ language: 'Python', code: 'print(1)' });
  });

  it('sans onRunCode → pas de bouton play', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="answer"
        answer={undefined}
        onChange={noop}
      />
    );
    expect(runButton()).toBeNull();
  });

  it('langage NON autonome (SQL) → pas de bouton play même avec onRunCode', () => {
    render(
      <CodingQuestion
        question={codingQuestion('SQL')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        onRunCode={vi.fn()}
      />
    );
    expect(runButton()).toBeNull();
  });

  it('langage non autonome HTML → pas de bouton play', () => {
    render(
      <CodingQuestion
        question={codingQuestion('HTML')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        onRunCode={vi.fn()}
      />
    );
    expect(runButton()).toBeNull();
  });

  it('JSX / TSX → pas de bouton play (insensible à la casse)', () => {
    const { unmount } = render(
      <CodingQuestion
        question={codingQuestion('jsx')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        onRunCode={vi.fn()}
      />
    );
    expect(runButton()).toBeNull();
    unmount();
    render(
      <CodingQuestion
        question={codingQuestion('TSX')}
        mode="answer"
        answer={undefined}
        onChange={noop}
        onRunCode={vi.fn()}
      />
    );
    expect(runButton()).toBeNull();
  });

  it('en review, pas de bouton play même si exécutable + onRunCode', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="review"
        answer={{ kind: 'coding', code: 'print(1)' }}
        onChange={noop}
        onRunCode={vi.fn()}
        result={{ questionId: 1, earned: 0, max: 5, tests: [] }}
      />
    );
    expect(runButton()).toBeNull();
  });
});

describe('CodingQuestion — mode review (lecture seule + TestResults)', () => {
  it('éditeur en lecture seule (textarea readOnly)', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="review"
        answer={{ kind: 'coding', code: 'print(1)' }}
        onChange={noop}
        result={{ questionId: 1, earned: 0, max: 5, tests: null }}
      />
    );
    expect(codeTextarea().readOnly).toBe(true);
  });

  it('affiche le libellé « Ta réponse »', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="review"
        answer={{ kind: 'coding', code: 'print(1)' }}
        onChange={noop}
        result={{ questionId: 1, earned: 0, max: 5, tests: [] }}
      />
    );
    expect(screen.getByText('Ta réponse')).toBeTruthy();
  });

  it('result.tests null → placeholder « Évaluation en cours »', () => {
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="review"
        answer={{ kind: 'coding', code: 'print(1)' }}
        onChange={noop}
        result={{ questionId: 1, earned: 0, max: 5, tests: null }}
      />
    );
    expect(screen.getByText('Évaluation du code en cours…')).toBeTruthy();
  });

  it('result.tests fourni → une ligne par harnais avec nom et verdict', () => {
    const result: QuestionResult = {
      questionId: 1,
      earned: 3,
      max: 5,
      tests: [
        { name: 'Cas simple', passed: true, weight: 3 },
        { name: 'Cas limite', passed: false, weight: 2 },
      ],
    };
    render(
      <CodingQuestion
        question={codingQuestion('Python')}
        mode="review"
        answer={{ kind: 'coding', code: 'print(1)' }}
        onChange={noop}
        result={result}
      />
    );
    expect(screen.getByText('Cas simple')).toBeTruthy();
    expect(screen.getByText('Cas limite')).toBeTruthy();
    expect(screen.getByText('Résultat des tests')).toBeTruthy();
    // Score par harnais : +3/5 (réussi) et −2/5 (échoué), total = 5.
    expect(screen.getByText('+3/5')).toBeTruthy();
    expect(screen.getByText('−2/5')).toBeTruthy();
  });

  it('les langages non autonomes restent éditables/révisables (SQL en review, lecture seule)', () => {
    render(
      <CodingQuestion
        question={codingQuestion('SQL')}
        mode="review"
        answer={{ kind: 'coding', code: 'SELECT 1' }}
        onChange={noop}
        result={{ questionId: 1, earned: 0, max: 5, tests: [] }}
      />
    );
    expect(codeTextarea().value).toBe('SELECT 1');
    expect(codeTextarea().readOnly).toBe(true);
  });
});
