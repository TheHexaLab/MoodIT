import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import type { RunResult } from '../MainPanel/QuizView/quizAttempt';

// jsdom ne fournit pas ResizeObserver (utilisé par l'auto-dimensionnement de l'éditeur).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

afterEach(cleanup);

/** Récupère le textarea de l'éditeur (unique dans le rendu). */
function getTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

function makeRunResult(over: Partial<RunResult> = {}): RunResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signal: null,
    compileOutput: null,
    timedOut: false,
    ...over,
  };
}

describe('CodeEditor', () => {
  it('affiche la valeur fournie dans le textarea', () => {
    render(<CodeEditor value="print(42)" onChange={() => {}} ariaLabel="code" />);
    expect(getTextarea().value).toBe('print(42)');
  });

  it('notifie onChange à la saisie', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="" onChange={onChange} ariaLabel="code" />);
    fireEvent.change(getTextarea(), { target: { value: 'x = 1' } });
    expect(onChange).toHaveBeenCalledWith('x = 1');
  });

  it('Tab insère 4 espaces (onChange) et empêche le comportement par défaut', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="ab" onChange={onChange} ariaLabel="code" />);
    const ta = getTextarea();
    // curseur au début (start=end=0)
    ta.setSelectionRange(0, 0);
    const prevented = !fireEvent.keyDown(ta, { key: 'Tab' });
    // 4 espaces insérés au début.
    expect(onChange).toHaveBeenCalledWith('    ab');
    // preventDefault appelé → fireEvent renvoie false.
    expect(prevented).toBe(true);
  });

  it('affiche une étiquette de langage quand `language` est fourni', () => {
    render(<CodeEditor value="" onChange={() => {}} language="Python" ariaLabel="code" />);
    expect(screen.getByText('Python')).toBeTruthy();
  });

  it('en lecture seule, le textarea est readOnly et aucune logique Tab ne modifie la valeur', () => {
    const onChange = vi.fn();
    render(<CodeEditor value="ab" onChange={onChange} readOnly ariaLabel="code" />);
    const ta = getTextarea();
    expect(ta.readOnly).toBe(true);
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: 'Tab' });
    // Handler onKeyDown désactivé en lecture seule → pas d'insertion d'espaces.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("affiche le bouton d'exécution quand onRun est fourni et l'appelle au clic", async () => {
    const onRun = vi.fn().mockResolvedValue(makeRunResult({ stdout: 'hello' }));
    render(
      <CodeEditor value="print('hello')" onChange={() => {}} onRun={onRun} runLabel="Exécuter" ariaLabel="code" />
    );
    const runBtn = screen.getByRole('button', { name: 'Exécuter' });
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalledWith("print('hello')");
    // La sortie s'affiche dans la console intégrée.
    await waitFor(() => expect(screen.getByText('hello')).toBeTruthy());
  });

  it("n'affiche pas de bouton d'exécution sans onRun", () => {
    render(<CodeEditor value="" onChange={() => {}} language="Python" ariaLabel="code" />);
    expect(screen.queryByRole('button', { name: 'Exécuter' })).toBeNull();
  });

  it("n'affiche pas le bouton d'exécution en lecture seule même avec onRun", () => {
    const onRun = vi.fn();
    render(<CodeEditor value="" onChange={() => {}} onRun={onRun} readOnly ariaLabel="code" />);
    expect(screen.queryByRole('button', { name: 'Exécuter' })).toBeNull();
  });

  it("affiche un message d'erreur si onRun rejette", async () => {
    const onRun = vi.fn().mockRejectedValue(new Error('boom'));
    render(<CodeEditor value="x" onChange={() => {}} onRun={onRun} ariaLabel="code" />);
    fireEvent.click(screen.getByRole('button', { name: 'Exécuter' }));
    await waitFor(() =>
      expect(screen.getByText(/Exécution impossible pour le moment/)).toBeTruthy()
    );
  });
});
