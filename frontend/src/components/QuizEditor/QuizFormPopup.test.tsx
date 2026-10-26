import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuizFormBody } from './QuizFormPopup';
import { EditorShell } from './EditorShell';
import { defaultQuizFormLabels } from './quizFormLabels';
import { type Question, type Quiz } from '../../types/domain';
import './editorTestSetup';

/**
 * Formulaire des méta d'un quiz (titre, interrupteurs) et liste de ses questions, monté dans la
 * coquille (`EditorShell`) pour disposer du pied de page (Annuler / Enregistrer).
 */

afterEach(cleanup);

const t = defaultQuizFormLabels;

function question(id: number, over: Partial<Question> = {}): Question {
  return { id, prompt: `Question ${id}`, qType: 'true_false', totalScore: 1, ...over } as Question;
}

function renderForm(
  quiz: Partial<Quiz> = {},
  overrides: Partial<React.ComponentProps<typeof QuizFormBody>> = {}
) {
  const handlers = {
    onCancel: vi.fn(),
    onDirty: vi.fn(),
    onSaveMeta: vi.fn(),
    onStashMeta: vi.fn(),
    onAddQuestion: vi.fn(),
    onEditQuestion: vi.fn(),
    onDeleteQuestion: vi.fn(),
    onReorderQuestions: vi.fn(),
  };
  const props: React.ComponentProps<typeof QuizFormBody> = {
    quiz: { id: 1, title: 'Quiz A', questions: [], ...quiz } as Quiz,
    ...handlers,
    ...overrides,
  };
  render(
    <EditorShell title="Quiz" onClose={() => {}}>
      <QuizFormBody {...props} />
    </EditorShell>
  );
  return handlers;
}

const titleField = () => screen.getByPlaceholderText(t.titlePlaceholder) as HTMLInputElement;
const toggle = (name: string) => screen.getByRole('switch', { name });
const saveButton = () => screen.getByRole('button', { name: t.save }) as HTMLButtonElement;

describe('QuizFormBody — méta du quiz', () => {
  it('les interrupteurs partent des valeurs du quiz', () => {
    renderForm({ isPublished: true, isDaily: true, allowRetry: false });
    expect(toggle(t.published).getAttribute('aria-checked')).toBe('true');
    expect(toggle(t.daily).getAttribute('aria-checked')).toBe('true');
    expect(toggle(t.allowRetry).getAttribute('aria-checked')).toBe('false');
  });

  it('chaque interrupteur bascule, signale la modification et part à l’enregistrement', () => {
    const { onDirty, onSaveMeta } = renderForm({ isPublished: false, isDaily: false, allowRetry: true });
    fireEvent.click(toggle(t.daily));
    expect(toggle(t.daily).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle(t.allowRetry));
    expect(toggle(t.allowRetry).getAttribute('aria-checked')).toBe('false');
    expect(onDirty).toHaveBeenCalledTimes(2);
    fireEvent.click(saveButton());
    expect(onSaveMeta).toHaveBeenCalledWith({
      title: 'Quiz A',
      isPublished: false,
      isDaily: true,
      allowRetry: false,
    });
  });

  it('titre vide ou blanc : Enregistrer désactivé ; le titre est rogné à l’enregistrement', () => {
    const { onSaveMeta, onDirty } = renderForm();
    fireEvent.change(titleField(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
    expect(onDirty).toHaveBeenCalled();
    fireEvent.change(titleField(), { target: { value: '  Nouveau titre  ' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ title: 'Nouveau titre' }));
  });

  it('pendant l’enregistrement, Enregistrer est désactivé même avec un titre valide', () => {
    renderForm({}, { saving: true });
    // Le libellé est remplacé par un indicateur : le bouton est le dernier du pied de page.
    const buttons = screen.getAllByRole('button');
    expect((buttons[buttons.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('quiz neuf : le bouton principal dit « Créer »', () => {
    renderForm({}, { isNew: true });
    expect(screen.getByRole('button', { name: t.create })).toBeTruthy();
  });

  it('Annuler délègue au parent', () => {
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: t.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('QuizFormBody — liste des questions', () => {
  it('total des points : somme des barèmes', () => {
    renderForm({ questions: [question(1, { totalScore: 2 }), question(2, { totalScore: 3.5 })] });
    expect(screen.getByText(t.points(5.5))).toBeTruthy();
  });

  it('titre de ligne : première ligne non vide, sans dièses de titre ni marques Markdown', () => {
    renderForm({
      questions: [
        question(1, { prompt: '\n\n  ## **Le *titre* `important`**\nsuite' }),
        question(2, { prompt: '   \n  ' }),
        question(3, { prompt: '#Collé' }),
      ],
    });
    expect(screen.getByText('Le titre important')).toBeTruthy();
    expect(screen.getByText(t.noPrompt)).toBeTruthy();
    expect(screen.getByText('Collé')).toBeTruthy();
  });

  it('ajouter ou modifier une question garde d’abord les méta saisies (onStashMeta)', () => {
    const q = question(7);
    const { onStashMeta, onAddQuestion, onEditQuestion } = renderForm({ questions: [q] });
    fireEvent.change(titleField(), { target: { value: 'Brouillon' } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t.addQuestion) }));
    expect(onStashMeta).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Brouillon' }));
    expect(onAddQuestion).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: t.editQuestionAria }));
    expect(onStashMeta).toHaveBeenCalledTimes(2);
    expect(onEditQuestion).toHaveBeenCalledWith(q);
  });

  it('mobile : un appui sur la ligne révèle ses actions, un second les masque', () => {
    renderForm({ questions: [question(7)] });
    const row = document.querySelector('[data-reorder-id="7"]') as HTMLElement;
    const actions = () => screen.getByRole('button', { name: t.editQuestionAria }).parentElement as HTMLElement;
    expect(actions().className).not.toContain('rowActionsRevealed');
    fireEvent.click(row);
    expect(actions().className).toContain('rowActionsRevealed');
    fireEvent.click(row);
    expect(actions().className).not.toContain('rowActionsRevealed');
  });

  it('un clic sur une action ou sur la poignée ne bascule pas l’affichage des actions', () => {
    const q = question(7);
    const { onDeleteQuestion } = renderForm({ questions: [q] });
    const row = document.querySelector('[data-reorder-id="7"]') as HTMLElement;
    const actions = () => screen.getByRole('button', { name: t.editQuestionAria }).parentElement as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: t.deleteQuestionAria }));
    expect(onDeleteQuestion).toHaveBeenCalledWith(q);
    fireEvent.click(row.querySelector('[aria-hidden]') as HTMLElement); // poignée
    expect(actions().className).not.toContain('rowActionsRevealed');
  });
});
