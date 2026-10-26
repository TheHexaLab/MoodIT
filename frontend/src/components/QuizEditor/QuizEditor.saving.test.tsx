import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { QuizEditor } from './QuizEditor';
import { defaultQuizEditorLabels } from './quizEditorLabels';
import { defaultQuizListLabels } from './quizListLabels';
import { defaultQuizFormLabels } from './quizFormLabels';
import { type Quiz } from '../../types/domain';
import './editorTestSetup';

/**
 * Pendant l'enregistrement d'un quiz, aucune sortie n'est possible avant la réponse : le chevron
 * et la croix sont désactivés, Échap et le clic sur le fond sont ignorés. Avant, quitter à ce
 * moment-là affichait « Modifications non enregistrées » alors qu'elles étaient en train d'être
 * enregistrées (vu dans l'e2e de quiz-editor.spec.ts, #154).
 */

afterEach(cleanup);

const editorT = defaultQuizEditorLabels;
const listT = defaultQuizListLabels;
const formT = defaultQuizFormLabels;

function setup() {
  let resolve!: () => void;
  const onUpdateQuiz = vi.fn(() => new Promise<void>((res) => (resolve = res)));
  const onClose = vi.fn();
  const quiz: Quiz = { id: 1, title: 'Q', isPublished: true, questions: [] } as Quiz;
  render(
    <QuizEditor courseId={42} quizzes={[quiz]} onClose={onClose} handlers={{ onUpdateQuiz }} />
  );
  fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
  fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), { target: { value: 'Q2' } });
  fireEvent.click(screen.getByText(formT.save));
  return { onClose, onUpdateQuiz, finish: () => act(async () => resolve()) };
}

const back = () => screen.getByLabelText('Retour') as HTMLButtonElement;
const close = () => screen.getByLabelText('Fermer') as HTMLButtonElement;

describe('QuizEditor — aucune sortie pendant l’enregistrement', () => {
  it('chevron et croix désactivés pendant l’enregistrement, réactivés après la réponse', async () => {
    const { finish, onUpdateQuiz } = setup();
    expect(onUpdateQuiz).toHaveBeenCalledTimes(1);
    expect(back().disabled).toBe(true);
    expect(close().disabled).toBe(true);
    await finish();
    expect(back().disabled).toBe(false);
    expect(close().disabled).toBe(false);
  });

  it('pendant l’enregistrement : ni la croix, ni Échap, ni le fond ne ferment ou n’alertent', async () => {
    const { finish, onClose } = setup();
    fireEvent.click(close());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    fireEvent.click(overlay);
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await finish();
  });

  it('après la réponse, la session est enregistrée : la croix ferme sans confirmation', async () => {
    const { finish, onClose } = setup();
    await finish();
    fireEvent.click(close());
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
