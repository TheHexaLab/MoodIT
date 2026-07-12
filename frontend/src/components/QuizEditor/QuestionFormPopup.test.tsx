import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { QuestionFormBody } from './QuestionFormPopup';
import { EditorShell } from './EditorShell';
import { defaultQuestionFormLabels } from './questionFormLabels';
import { emptyQuestionDraft, type QuestionDraft } from './editorTypes';
import { QUESTION_TYPE_LABELS, type Language } from '../../types/domain';
import './editorTestSetup';

afterEach(cleanup);

const t = defaultQuestionFormLabels;

const LANGS: Language[] = [
  { id: 1, name: 'Python' },
  { id: 6, name: 'C' },
];

function renderForm(
  draft: QuestionDraft,
  overrides: Partial<React.ComponentProps<typeof QuestionFormBody>> = {}
) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onManageHarness = vi.fn();
  const onTest = vi.fn();
  const props: React.ComponentProps<typeof QuestionFormBody> = {
    draft,
    languages: LANGS,
    onCancel,
    onSave,
    onManageHarness,
    onTest,
    ...overrides,
  };
  const utils = render(
    <EditorShell title="Question" onClose={() => {}}>
      <QuestionFormBody {...props} />
    </EditorShell>
  );
  return { onSave, onCancel, onManageHarness, onTest, ...utils };
}

/** Le champ énoncé (MarkdownEditor embarqué) rend un textarea aria-label « Éditeur Markdown ». */
function promptField() {
  return screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement;
}
/** Bouton d'enregistrement (Ajouter en création, Enregistrer en édition). */
function saveButton(label: string) {
  return screen.getByText(label).closest('button') as HTMLButtonElement;
}

describe('QuestionFormBody', () => {
  it('charge les types de question au montage', () => {
    const onRequestQuestionTypes = vi.fn();
    renderForm(emptyQuestionDraft('single_choice'), { onRequestQuestionTypes });
    expect(onRequestQuestionTypes).toHaveBeenCalled();
  });

  it('affiche l\'énoncé et le barème initiaux', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), prompt: 'Bonjour', totalScore: 2.5 };
    renderForm(draft);
    expect(promptField().value).toBe('Bonjour');
    const points = screen.getByLabelText(t.pointsLabel) as HTMLInputElement;
    expect(points.value).toBe('2.5');
  });

  // ── Validation (canSave) ──

  it('bloque l\'enregistrement quand l\'énoncé est vide', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), prompt: '' };
    renderForm(draft, { isNew: true });
    expect(saveButton(t.add).disabled).toBe(true);
  });

  it('true_false valide dès que l\'énoncé est saisi (options figées)', () => {
    renderForm(emptyQuestionDraft('true_false'), { isNew: true });
    expect(saveButton(t.add).disabled).toBe(true);
    fireEvent.change(promptField(), { target: { value: 'Le ciel est bleu ?' } });
    expect(saveButton(t.add).disabled).toBe(false);
  });

  it('single_choice invalide tant qu\'une option est vide', () => {
    const draft: QuestionDraft = {
      ...emptyQuestionDraft('single_choice'),
      prompt: 'Q',
    };
    renderForm(draft, { isNew: true });
    // options vides → invalide
    expect(saveButton(t.add).disabled).toBe(true);
    const answers = screen.getAllByPlaceholderText(t.answerPlaceholder);
    fireEvent.change(answers[0], { target: { value: 'A' } });
    fireEvent.change(answers[1], { target: { value: 'B' } });
    expect(saveButton(t.add).disabled).toBe(false);
  });

  it('multiple_choice invalide si aucune bonne réponse cochée', () => {
    const draft: QuestionDraft = {
      qType: 'multiple_choice',
      prompt: 'Q',
      totalScore: 1,
      answers: [
        { content: 'A', isCorrect: false },
        { content: 'B', isCorrect: false },
      ],
    };
    renderForm(draft, { isNew: true });
    expect(saveButton(t.add).disabled).toBe(true);
    // cocher la première
    fireEvent.click(screen.getAllByLabelText(t.markCorrectAria)[0]);
    expect(saveButton(t.add).disabled).toBe(false);
  });

  // ── Choix : interaction ──

  it('choix unique : cocher une option décoche les autres (radio)', () => {
    const draft: QuestionDraft = {
      qType: 'single_choice',
      prompt: 'Q',
      totalScore: 1,
      answers: [
        { content: 'A', isCorrect: true },
        { content: 'B', isCorrect: false },
      ],
    };
    const { onSave } = renderForm(draft, { isNew: true });
    fireEvent.click(screen.getAllByLabelText(t.markCorrectAria)[1]);
    fireEvent.click(saveButton(t.add));
    const saved = onSave.mock.calls[0][0] as QuestionDraft;
    expect(saved.answers?.map((a) => a.isCorrect)).toEqual([false, true]);
  });

  it('choix multiple : bascule indépendamment (checkbox)', () => {
    const draft: QuestionDraft = {
      qType: 'multiple_choice',
      prompt: 'Q',
      totalScore: 1,
      answers: [
        { content: 'A', isCorrect: true },
        { content: 'B', isCorrect: false },
      ],
    };
    const { onSave } = renderForm(draft, { isNew: true });
    fireEvent.click(screen.getAllByLabelText(t.markCorrectAria)[1]);
    fireEvent.click(saveButton(t.add));
    const saved = onSave.mock.calls[0][0] as QuestionDraft;
    expect(saved.answers?.map((a) => a.isCorrect)).toEqual([true, true]);
  });

  it('ajouter puis supprimer une option', () => {
    const draft: QuestionDraft = {
      qType: 'single_choice',
      prompt: 'Q',
      totalScore: 1,
      answers: [
        { content: 'A', isCorrect: true },
        { content: 'B', isCorrect: false },
      ],
    };
    renderForm(draft, { isNew: true });
    fireEvent.click(screen.getByText(`+ ${t.addAnswer}`));
    expect(screen.getAllByPlaceholderText(t.answerPlaceholder)).toHaveLength(3);
    fireEvent.click(screen.getAllByLabelText(t.deleteAnswerAria)[2]);
    expect(screen.getAllByPlaceholderText(t.answerPlaceholder)).toHaveLength(2);
  });

  it('true_false : options figées (inputs désactivés, pas de suppression)', () => {
    renderForm(emptyQuestionDraft('true_false'));
    const inputs = screen.getAllByRole('textbox').filter((el) => el.tagName === 'INPUT') as HTMLInputElement[];
    // les 2 inputs d'option sont désactivés
    const optionInputs = inputs.filter((i) => i.value === 'Vrai' || i.value === 'Faux');
    expect(optionInputs).toHaveLength(2);
    optionInputs.forEach((i) => expect(i.disabled).toBe(true));
    expect(screen.queryByLabelText(t.deleteAnswerAria)).toBeNull();
  });

  // ── Changement de type ──

  it('changer de type repart d\'un corps vierge en gardant énoncé + points', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('single_choice'), prompt: 'Gardé', totalScore: 4 };
    const { onSave } = renderForm(draft, { isNew: true });
    // passe à « Remise en ordre »
    fireEvent.click(screen.getByLabelText(t.typeLabel));
    fireEvent.click(screen.getByRole('option', { name: QUESTION_TYPE_LABELS.ordering }));
    // la section « ordering » apparaît
    expect(screen.getByText(t.orderingSection)).toBeTruthy();
    // remplir pour pouvoir enregistrer
    const items = screen.getAllByPlaceholderText(t.elementPlaceholder);
    fireEvent.change(items[0], { target: { value: 'un' } });
    fireEvent.change(items[1], { target: { value: 'deux' } });
    fireEvent.click(saveButton(t.add));
    const saved = onSave.mock.calls[0][0] as QuestionDraft;
    expect(saved.qType).toBe('ordering');
    expect(saved.prompt).toBe('Gardé');
    expect(saved.totalScore).toBe(4);
  });

  it('passer au type Code demande le chargement des langages', () => {
    const onRequestLanguages = vi.fn();
    renderForm(emptyQuestionDraft('single_choice'), { onRequestLanguages });
    onRequestLanguages.mockClear();
    fireEvent.click(screen.getByLabelText(t.typeLabel));
    fireEvent.click(screen.getByRole('option', { name: QUESTION_TYPE_LABELS.coding }));
    expect(onRequestLanguages).toHaveBeenCalled();
  });

  // ── Points ──

  it('barème : arrondi au dixième borné ≥ 0.1 au blur', () => {
    renderForm(emptyQuestionDraft('true_false'));
    const points = screen.getByLabelText(t.pointsLabel) as HTMLInputElement;
    fireEvent.change(points, { target: { value: '2.37' } });
    fireEvent.blur(points);
    expect(points.value).toBe('2.4');
  });

  it('barème : vide → 0 (bloque l\'enregistrement)', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), prompt: 'Q' };
    renderForm(draft, { isNew: true });
    const points = screen.getByLabelText(t.pointsLabel) as HTMLInputElement;
    fireEvent.change(points, { target: { value: '' } });
    expect(saveButton(t.add).disabled).toBe(true);
  });

  // ── Remise en ordre / association ──

  it('ordering : ajouter/supprimer des éléments et valider', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('ordering'), prompt: 'Q' };
    renderForm(draft, { isNew: true });
    // 2 éléments vides → invalide
    expect(saveButton(t.add).disabled).toBe(true);
    const items = screen.getAllByPlaceholderText(t.elementPlaceholder);
    fireEvent.change(items[0], { target: { value: 'a' } });
    fireEvent.change(items[1], { target: { value: 'b' } });
    expect(saveButton(t.add).disabled).toBe(false);
    // ajouter un 3e
    fireEvent.click(screen.getByText(`+ ${t.addItem}`));
    expect(screen.getAllByPlaceholderText(t.elementPlaceholder)).toHaveLength(3);
  });

  it('matching : invalide tant qu\'une catégorie manque, valide une fois remplie', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('matching'), prompt: 'Q' };
    const { onSave } = renderForm(draft, { isNew: true });
    expect(saveButton(t.add).disabled).toBe(true);
    const elements = screen.getAllByPlaceholderText(t.elementPlaceholder);
    const cats = screen.getAllByPlaceholderText(t.categoryPlaceholder);
    fireEvent.change(elements[0], { target: { value: 'chien' } });
    fireEvent.change(cats[0], { target: { value: 'animal' } });
    fireEvent.change(elements[1], { target: { value: 'rose' } });
    // catégorie 2 encore vide → invalide
    expect(saveButton(t.add).disabled).toBe(true);
    fireEvent.change(cats[1], { target: { value: 'fleur' } });
    expect(saveButton(t.add).disabled).toBe(false);
    fireEvent.click(saveButton(t.add));
    const saved = onSave.mock.calls[0][0] as QuestionDraft;
    expect(saved.dragItems?.map((d) => d.groupName)).toEqual(['animal', 'fleur']);
  });

  // ── Code : harnais + langage ──

  it('code : « Gérer » ouvre le harnais avec le brouillon courant', () => {
    const draft: QuestionDraft = emptyQuestionDraft('coding');
    const { onManageHarness } = renderForm(draft);
    fireEvent.click(screen.getByText(t.manageHarness));
    expect(onManageHarness).toHaveBeenCalledTimes(1);
    const passed = onManageHarness.mock.calls[0][0] as QuestionDraft;
    expect(passed.qType).toBe('coding');
  });

  it('code : sans harnais → enregistrement bloqué', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('coding'), prompt: 'Q', testCases: [] };
    renderForm(draft, { isNew: true });
    expect(saveButton(t.add).disabled).toBe(true);
  });

  it('code : avec un harnais → enregistrement possible', () => {
    const draft: QuestionDraft = {
      ...emptyQuestionDraft('coding'),
      prompt: 'Q',
      testCases: [{ name: 'c', harnessCode: 'h', weight: 1 }],
    };
    renderForm(draft, { isNew: true });
    expect(saveButton(t.add).disabled).toBe(false);
  });

  it('code : changer de langage repose le code de départ et vide les harnais', () => {
    const draft: QuestionDraft = {
      ...emptyQuestionDraft('coding'),
      prompt: 'Q',
      languageId: 1,
      testCases: [{ name: 'c', harnessCode: 'h', weight: 1 }],
    };
    renderForm(draft, { isNew: true });
    // valide au départ (1 harnais)
    expect(saveButton(t.add).disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(t.languageLabel));
    fireEvent.click(screen.getByRole('option', { name: 'C' }));
    // harnais vidés → enregistrement de nouveau bloqué
    expect(saveButton(t.add).disabled).toBe(true);
    expect(screen.getByText(t.harnessCount(0))).toBeTruthy();
  });

  // ── Boutons de pied ──

  it('bouton « Tester » désactivé tant que la question est invalide, actif ensuite', () => {
    renderForm(emptyQuestionDraft('true_false'), { isNew: true });
    const test = screen.getByText(t.test).closest('button') as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    fireEvent.change(promptField(), { target: { value: 'Q' } });
    expect(test.disabled).toBe(false);
  });

  it('« Tester » transmet le brouillon courant', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), prompt: 'Q' };
    const { onTest } = renderForm(draft);
    fireEvent.click(screen.getByText(t.test));
    expect(onTest).toHaveBeenCalledTimes(1);
    expect((onTest.mock.calls[0][0] as QuestionDraft).prompt).toBe('Q');
  });

  it('Annuler appelle onCancel', () => {
    const { onCancel } = renderForm(emptyQuestionDraft('true_false'));
    fireEvent.click(screen.getByText(t.cancel));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('en édition, le bouton affiche « Enregistrer »', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), id: 5, prompt: 'Q' };
    renderForm(draft, { isNew: false });
    expect(screen.getByText(t.save)).toBeTruthy();
    expect(screen.queryByText(t.add)).toBeNull();
  });

  it('onSave transmet un brouillon avec l\'énoncé édité', () => {
    const draft: QuestionDraft = { ...emptyQuestionDraft('true_false'), prompt: 'orig' };
    const { onSave } = renderForm(draft, { isNew: true });
    fireEvent.change(promptField(), { target: { value: 'nouvel énoncé' } });
    fireEvent.click(saveButton(t.add));
    expect((onSave.mock.calls[0][0] as QuestionDraft).prompt).toBe('nouvel énoncé');
  });

  it('utilise les types fournis (questionTypes) dans le sélecteur', () => {
    renderForm(emptyQuestionDraft('single_choice'), {
      questionTypes: [
        { id: 1, slug: 'single_choice', label: 'MON CHOIX' },
        { id: 2, slug: 'coding', label: 'MON CODE' },
      ],
    });
    fireEvent.click(screen.getByLabelText(t.typeLabel));
    expect(screen.getByRole('option', { name: 'MON CHOIX' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'MON CODE' })).toBeTruthy();
  });
});
