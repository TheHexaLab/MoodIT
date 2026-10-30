import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { QuizEditor } from './QuizEditor';
import { defaultQuizEditorLabels } from './quizEditorLabels';
import { defaultQuizListLabels } from './quizListLabels';
import { defaultQuizFormLabels } from './quizFormLabels';
import { defaultQuestionFormLabels } from './questionFormLabels';
import { defaultHarnessLabels } from './harnessLabels';
import { type Quiz, type QuestionTypeOption } from '../../types/domain';
import './editorTestSetup';

afterEach(cleanup);

const editorT = defaultQuizEditorLabels;
const listT = defaultQuizListLabels;
const formT = defaultQuizFormLabels;
const qT = defaultQuestionFormLabels;
const hT = defaultHarnessLabels;

function makeQuiz(over: Partial<Quiz> = {}): Quiz {
  return {
    id: 1,
    title: 'Quiz A',
    isPublished: true,
    isDaily: false,
    questions: [],
    ...over,
  };
}

const QUESTION_TYPES: QuestionTypeOption[] = [
  { id: 10, slug: 'true_false', label: 'Vrai/Faux' },
  { id: 11, slug: 'single_choice', label: 'Choix unique' },
  { id: 15, slug: 'coding', label: 'Code' },
];

function renderEditor(over: Partial<React.ComponentProps<typeof QuizEditor>> = {}) {
  const onClose = vi.fn();
  const props: React.ComponentProps<typeof QuizEditor> = {
    courseId: 42,
    quizzes: [makeQuiz()],
    onClose,
    ...over,
  };
  const utils = render(<QuizEditor {...props} />);
  return { onClose, ...utils };
}

/** L'énoncé (MarkdownEditor) rend un textarea aria-label « Éditeur Markdown ». */
function promptField() {
  return screen.getByLabelText('Éditeur Markdown') as HTMLTextAreaElement;
}

describe('QuizEditor — vue liste', () => {
  it('rend la liste des quiz (mode mémoire, sans fetch)', () => {
    renderEditor({ quizzes: [makeQuiz({ title: 'Algèbre' })] });
    expect(screen.getByText(editorT.listTitle)).toBeTruthy();
    expect(screen.getByText('Algèbre')).toBeTruthy();
  });

  it('affiche l\'état vide quand aucun quiz', () => {
    renderEditor({ quizzes: [] });
    expect(screen.getByText(listT.empty)).toBeTruthy();
  });

  it('clic sur la croix ferme l\'éditeur', () => {
    const { onClose } = renderEditor();
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Échap ferme l\'éditeur depuis la liste (rien en cours de saisie)', () => {
    const { onClose } = renderEditor();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('QuizEditor — Échap ne fait pas perdre la saisie', () => {
  it('dans le formulaire d\'un quiz, Échap ne ferme pas et la saisie reste', () => {
    const { onClose } = renderEditor({ quizzes: [] });
    fireEvent.click(screen.getByText(listT.create));
    const title = screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Quiz en cours' } });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(editorT.newQuizTitle)).toBeTruthy();
    expect((screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement).value).toBe(
      'Quiz en cours'
    );
  });

  it('dans l\'éditeur d\'une question, Échap ne ferme pas et l\'énoncé reste', async () => {
    const { onClose } = renderEditor({ quizzes: [makeQuiz({ title: 'Quiz A' })] });
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    fireEvent.click(await screen.findByText(formT.addQuestion));
    fireEvent.change(promptField(), { target: { value: 'Énoncé en cours' } });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(promptField().value).toBe('Énoncé en cours');
  });
});

describe('QuizEditor — navigation liste → formulaire', () => {
  it('le crayon ouvre le formulaire du quiz', () => {
    renderEditor({ quizzes: [makeQuiz({ title: 'Quiz A' })] });
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    expect(screen.getByText(editorT.editQuizTitle)).toBeTruthy();
    // titre pré-rempli
    expect((screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement).value).toBe('Quiz A');
  });

  it('« Créer » ouvre un formulaire de nouveau quiz vide', () => {
    renderEditor({ quizzes: [] });
    fireEvent.click(screen.getByText(listT.create));
    expect(screen.getByText(editorT.newQuizTitle)).toBeTruthy();
    expect((screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement).value).toBe('');
  });

  it('onFetchQuiz est appelé à l\'ouverture et hydrate le formulaire', async () => {
    const onFetchQuiz = vi.fn(async (id: number) =>
      makeQuiz({ id, title: 'Détaillé', questions: [] })
    );
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Quiz A' })], handlers: { onFetchQuiz } });
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    await waitFor(() => expect(onFetchQuiz).toHaveBeenCalledWith(1));
    await screen.findByText(editorT.editQuizTitle);
  });

  it('échec de onFetchQuiz : reste sur la liste et affiche un popup d\'erreur', async () => {
    const onFetchQuiz = vi.fn(async () => {
      throw new Error('boom');
    });
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Quiz A' })], handlers: { onFetchQuiz } });
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    await screen.findByText(editorT.loadError);
    // toujours en vue liste (pas de titre de formulaire)
    expect(screen.queryByText(editorT.editQuizTitle)).toBeNull();
  });
});

describe('QuizEditor — persistance méta (un seul appel)', () => {
  it('création : onCreateQuiz reçoit le quiz complet ; notifie onQuizzesChange', async () => {
    const onCreateQuiz = vi.fn(async (_courseId: number, quiz: Quiz) => ({
      ...quiz,
      id: 999,
    }));
    const onQuizzesChange = vi.fn();
    renderEditor({ quizzes: [], handlers: { onCreateQuiz }, onQuizzesChange });
    fireEvent.click(screen.getByText(listT.create));
    fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), {
      target: { value: 'Nouveau' },
    });
    fireEvent.click(screen.getByText(formT.create));
    await waitFor(() => expect(onCreateQuiz).toHaveBeenCalledTimes(1));
    const [courseId, payload] = onCreateQuiz.mock.calls[0];
    expect(courseId).toBe(42);
    expect(payload.title).toBe('Nouveau');
    expect(onQuizzesChange).toHaveBeenCalled();
    // le quiz réconcilié (id serveur 999) est remonté
    const last = onQuizzesChange.mock.calls.at(-1)![0] as Quiz[];
    expect(last.some((q) => q.id === 999)).toBe(true);
  });

  it('édition : onUpdateQuiz reçoit méta + questions en un seul appel', async () => {
    const onUpdateQuiz = vi.fn(async (_id: number, quiz: Quiz) => quiz);
    const onQuizzesChange = vi.fn();
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Ancien', isPublished: false })],
      handlers: { onUpdateQuiz },
      onQuizzesChange,
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Ancien')));
    fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), {
      target: { value: 'Renommé' },
    });
    // bascule « Publié »
    fireEvent.click(screen.getByText(formT.published));
    fireEvent.click(screen.getByText(formT.save));
    await waitFor(() => expect(onUpdateQuiz).toHaveBeenCalledTimes(1));
    const [id, payload] = onUpdateQuiz.mock.calls[0];
    expect(id).toBe(1);
    expect(payload.title).toBe('Renommé');
    expect(payload.isPublished).toBe(true);
  });

  it('estampille orderIndex des questions selon leur position finale', async () => {
    const onUpdateQuiz = vi.fn(async (_id: number, quiz: Quiz) => quiz);
    renderEditor({
      quizzes: [
        makeQuiz({
          id: 1,
          title: 'Q',
          questions: [
            { id: 5, qType: 'true_false', prompt: 'p1', totalScore: 1 },
            { id: 6, qType: 'true_false', prompt: 'p2', totalScore: 1 },
          ],
        }),
      ],
      handlers: { onUpdateQuiz },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.save));
    await waitFor(() => expect(onUpdateQuiz).toHaveBeenCalled());
    const payload = onUpdateQuiz.mock.calls[0][1] as Quiz;
    expect(payload.questions?.map((q) => q.orderIndex)).toEqual([0, 1]);
  });

  it('échec de sauvegarde : affiche le popup d\'erreur, reste sur le formulaire', async () => {
    const onUpdateQuiz = vi.fn(async () => {
      throw new Error('nope');
    });
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q' })],
      handlers: { onUpdateQuiz },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.save));
    await screen.findByText(editorT.saveError);
    expect(screen.getByText(editorT.editQuizTitle)).toBeTruthy();
  });
});

describe('QuizEditor — annulation défait la session', () => {
  it('Annuler en création retire le quiz temporaire et revient à la liste', () => {
    renderEditor({ quizzes: [] });
    fireEvent.click(screen.getByText(listT.create));
    fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), {
      target: { value: 'Éphémère' },
    });
    fireEvent.click(screen.getByText(formT.cancel));
    // retour liste, quiz non persisté absent
    expect(screen.getByText(editorT.listTitle)).toBeTruthy();
    expect(screen.getByText(listT.empty)).toBeTruthy();
  });

  it('Annuler après ajout de question défait l\'ajout', async () => {
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q', questions: [] })],
      handlers: { onFetchQuestionTypes: () => QUESTION_TYPES },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    // ajoute une question
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    fireEvent.change(promptField(), { target: { value: 'Nouvelle Q' } });
    // true_false valide, on enregistre la question (en mémoire)
    fireEvent.click(screen.getByLabelText(qT.typeLabel, { exact: false }));
    fireEvent.click(screen.getByRole('option', { name: 'Vrai/Faux' }));
    fireEvent.click(screen.getByText(qT.add));
    // de retour au formulaire, la question apparaît
    await screen.findByText(formT.save);
    // Annule tout le formulaire → défait l'ajout
    fireEvent.click(screen.getByText(formT.cancel));
    expect(screen.getByText(editorT.listTitle)).toBeTruthy();
    // le compte de questions du quiz reste 0
    expect(screen.getByText(listT.questionsCount(0))).toBeTruthy();
  });
});

describe('QuizEditor — navigation question/harnais', () => {
  it('ajouter une question ouvre la vue question', async () => {
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })] });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.addQuestion));
    expect(await screen.findByText(editorT.newQuestionTitle)).toBeTruthy();
  });

  it('éditer une question existante ouvre la vue question pré-remplie', () => {
    renderEditor({
      quizzes: [
        makeQuiz({
          id: 1,
          title: 'Q',
          questions: [{ id: 7, qType: 'true_false', prompt: 'Déjà là', totalScore: 2 }],
        }),
      ],
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByLabelText(formT.editQuestionAria));
    expect(screen.getByText(editorT.editQuestionTitle)).toBeTruthy();
    expect(promptField().value).toBe('Déjà là');
  });

  it('question Code → « Gérer » ouvre la vue harnais ; retour applique les harnais', async () => {
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q' })],
      handlers: { onFetchQuestionTypes: () => QUESTION_TYPES },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    // passe au type Code
    fireEvent.click(screen.getByLabelText(qT.typeLabel, { exact: false }));
    fireEvent.click(screen.getByRole('option', { name: 'Code' }));
    // Gérer les harnais
    fireEvent.click(screen.getByText(qT.manageHarness));
    expect(await screen.findByText(editorT.harnessTitle)).toBeTruthy();
    // ajoute un harnais et le nomme
    fireEvent.click(screen.getByText(`+ ${hT.add}`));
    fireEvent.change(screen.getByPlaceholderText(hT.namePlaceholder), {
      target: { value: 'Cas 1' },
    });
    fireEvent.click(screen.getByText(hT.save));
    // retour à la vue question ; le compteur de harnais reflète 1
    await screen.findByText(editorT.newQuestionTitle);
    expect(screen.getByText(qT.harnessCount(1))).toBeTruthy();
  });

  it('chevron retour depuis la question revient au formulaire', async () => {
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })] });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    fireEvent.click(screen.getByLabelText('Retour'));
    expect(screen.getByText(editorT.editQuizTitle)).toBeTruthy();
  });
});

// Garde : le formulaire du quiz est démonté pendant l'édition d'une question ; le titre et les
// interrupteurs saisis (non encore enregistrés) doivent survivre au retour.
describe('QuizEditor — méta du quiz conservées pendant l’édition d’une question', () => {
  const titleField = () => screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement;
  const publishedSwitch = () => screen.getByRole('switch', { name: formT.published });

  it('création : titre et « Publié » survivent à l’ajout d’une question', async () => {
    renderEditor({ quizzes: [], handlers: { onFetchQuestionTypes: () => QUESTION_TYPES } });
    fireEvent.click(screen.getByText(listT.create));
    fireEvent.change(titleField(), { target: { value: 'Titre saisi en premier' } });
    fireEvent.click(publishedSwitch());
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    fireEvent.change(promptField(), { target: { value: 'Une question.' } });
    fireEvent.click(screen.getByLabelText(qT.typeLabel, { exact: false }));
    fireEvent.click(screen.getByRole('option', { name: 'Vrai/Faux' }));
    fireEvent.click(screen.getByText(qT.add));
    await screen.findByText(editorT.newQuizTitle);
    expect(screen.getByText('Une question.')).toBeTruthy();
    expect(titleField().value).toBe('Titre saisi en premier');
    expect(publishedSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('édition : le chevron retour conserve la saisie ; « Annuler » la défait', async () => {
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q', isPublished: true })] });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.change(titleField(), { target: { value: 'Q renommé' } });
    fireEvent.click(publishedSwitch());
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    // Session modifiée : le chevron demande confirmation avant de quitter la question.
    fireEvent.click(screen.getByLabelText('Retour'));
    expect(screen.getByText(editorT.discardTitle)).toBeTruthy();
    // « Continuer l'édition » : on reste sur la question.
    fireEvent.click(screen.getByText(editorT.discardCancel));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(screen.getByText(editorT.newQuestionTitle)).toBeTruthy();
    // « Quitter sans enregistrer » : retour au formulaire, dont la saisie est conservée.
    fireEvent.click(screen.getByLabelText('Retour'));
    fireEvent.click(screen.getByText(editorT.discardConfirm));
    expect(titleField().value).toBe('Q renommé');
    expect(publishedSwitch().getAttribute('aria-checked')).toBe('false');
    // « Annuler » restaure l'instantané : le titre d'origine revient dans la liste.
    fireEvent.click(screen.getByText(formT.cancel));
    expect(screen.getByLabelText(listT.editAria('Q'))).toBeTruthy();
  });
});

describe('QuizEditor — suppressions via popup de confirmation', () => {
  it('supprimer un quiz : popup de confirmation puis onDeleteQuiz', async () => {
    const onDeleteQuiz = vi.fn(async () => {});
    const onQuizzesChange = vi.fn();
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'À supprimer' })],
      handlers: { onDeleteQuiz },
      onQuizzesChange,
    });
    fireEvent.click(screen.getByLabelText(listT.deleteAria('À supprimer')));
    // popup de confirmation
    expect(screen.getByText(editorT.deleteQuizTitle)).toBeTruthy();
    fireEvent.click(screen.getByText('Supprimer'));
    await waitFor(() => expect(onDeleteQuiz).toHaveBeenCalledWith(1));
    // retiré de la liste
    await waitFor(() => expect(screen.queryByText('À supprimer')).toBeNull());
    expect(onQuizzesChange).toHaveBeenCalled();
  });

  it('annuler la confirmation n\'appelle pas onDeleteQuiz', () => {
    const onDeleteQuiz = vi.fn(async () => {});
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Garde-moi' })],
      handlers: { onDeleteQuiz },
    });
    fireEvent.click(screen.getByLabelText(listT.deleteAria('Garde-moi')));
    fireEvent.click(screen.getByText('Annuler'));
    expect(onDeleteQuiz).not.toHaveBeenCalled();
    expect(screen.getByText('Garde-moi')).toBeTruthy();
  });

  it('supprimer une question : confirmation puis retrait EN MÉMOIRE (pas d\'appel API)', async () => {
    const onDeleteQuiz = vi.fn(async () => {});
    renderEditor({
      quizzes: [
        makeQuiz({
          id: 1,
          title: 'Q',
          questions: [{ id: 7, qType: 'true_false', prompt: 'À retirer', totalScore: 1 }],
        }),
      ],
      handlers: { onDeleteQuiz },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    expect(screen.getByText('À retirer')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(formT.deleteQuestionAria));
    // confirmation « question »
    expect(screen.getByText(editorT.deleteQuestionTitle)).toBeTruthy();
    fireEvent.click(screen.getByText('Supprimer'));
    await waitFor(() => expect(screen.queryByText('À retirer')).toBeNull());
    // aucune suppression API pour une question (persistée à l'enregistrement)
    expect(onDeleteQuiz).not.toHaveBeenCalled();
  });
});

describe('QuizEditor — fetch de la liste', () => {
  it('avec onFetchQuizzes, remplace la liste au retour du fetch', async () => {
    const onFetchQuizzes = vi.fn(async () => [
      makeQuiz({ id: 2, title: 'Depuis le serveur' }),
    ]);
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Périmé' })], handlers: { onFetchQuizzes } });
    await waitFor(() => expect(onFetchQuizzes).toHaveBeenCalledWith(42));
    expect(await screen.findByText('Depuis le serveur')).toBeTruthy();
  });
});

describe('QuizEditor — réordonnancement (échec de persistance)', () => {
  // jsdom n'implémente pas elementFromPoint : on le stubbe pour cibler une rangée.
  function setElementFromPoint(el: Element | null) {
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => el;
  }

  it('un échec (ex. 403) ANNULE le réordre optimiste et remonte un popup', async () => {
    // onReorderQuizzes rejette → simule un 403 (pas les droits) côté serveur.
    const onReorderQuizzes = vi.fn().mockRejectedValue(new Error('403'));
    const onQuizzesChange = vi.fn();
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Quiz A' }), makeQuiz({ id: 2, title: 'Quiz B' })],
      handlers: { onReorderQuizzes },
      onQuizzesChange,
    });

    // Les rangées sont rendues dans un Portal (EditorShell) → on requête le document entier.
    const rowA = document.querySelector('[data-reorder-id="1"]') as HTMLElement;
    const rowB = document.querySelector('[data-reorder-id="2"]') as HTMLElement;
    const gripA = rowA.querySelector('span') as HTMLElement; // 1re <span> = poignée (⋮⋮)
    (gripA as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};

    // Glisse Quiz A au-dessus de Quiz B, puis relâche → commit du nouvel ordre [2, 1].
    fireEvent.pointerDown(gripA, { button: 0, pointerType: 'mouse', pointerId: 1 });
    setElementFromPoint(rowB);
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 0, clientY: 30 }));
    });
    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    // « click » envoyé par le navigateur au relâchement : le hook l'avale après un vrai glissé.
    // Sans lui, l'écouteur resterait armé et avalerait le premier clic du test suivant.
    fireEvent.click(gripA);

    // La persistance a été tentée avec le nouvel ordre…
    await waitFor(() => expect(onReorderQuizzes).toHaveBeenCalledWith(42, [2, 1]));
    // …puis a échoué → popup d'erreur affiché.
    expect(await screen.findByText(editorT.reorderError)).toBeTruthy();
    // …et l'ordre a été REVERTÉ (dernier commit vers la sidebar = ordre initial [1, 2]).
    const lastCommit = onQuizzesChange.mock.calls.at(-1)?.[0] as Quiz[];
    expect(lastCommit.map((q) => q.id)).toEqual([1, 2]);
  });
});

// Confirmation de perte de données (garde de fermeture) : la croix et le voile demandent
// confirmation dès que la session d'édition contient une modification non enregistrée.
describe('QuizEditor — fermeture avec des modifications non enregistrées', () => {
  const titleField = () => screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement;
  const overlay = () => screen.getByRole('dialog').parentElement as HTMLElement;

  async function openForm(onClose?: () => void) {
    const utils = renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })], ...(onClose ? { onClose } : {}) });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    await screen.findByPlaceholderText(formT.titlePlaceholder);
    return utils;
  }

  it('sans modification : la croix ferme directement, sans confirmation', async () => {
    const { onClose } = await openForm();
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('titre modifié : la croix demande confirmation ; « Continuer l’édition » garde la saisie', async () => {
    const { onClose } = await openForm();
    fireEvent.change(titleField(), { target: { value: 'Q modifié' } });
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.getByText(editorT.discardTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(editorT.discardCancel));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(titleField().value).toBe('Q modifié');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('« Quitter sans enregistrer » ferme vraiment l’éditeur', async () => {
    const { onClose } = await openForm();
    fireEvent.click(screen.getByRole('switch', { name: formT.daily }));
    fireEvent.click(screen.getByLabelText('Fermer'));
    fireEvent.click(screen.getByText(editorT.discardConfirm));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('un clic sur le voile passe aussi par la confirmation', async () => {
    const { onClose } = await openForm();
    fireEvent.click(screen.getByRole('switch', { name: formT.allowRetry }));
    fireEvent.mouseDown(overlay());
    fireEvent.click(overlay());
    expect(screen.getByText(editorT.discardTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('sans modification : le chevron revient à la liste sans confirmation', async () => {
    await openForm();
    fireEvent.click(screen.getByLabelText('Retour'));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(screen.getByText(editorT.listTitle)).toBeTruthy();
  });

  it('après « Annuler », la session n’est plus modifiée : la croix ferme directement', async () => {
    const { onClose } = await openForm();
    fireEvent.change(titleField(), { target: { value: 'Q modifié' } });
    fireEvent.click(screen.getByText(formT.cancel));
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Parcours relevés par Stryker (#117) : chacun correspond à un comportement que les tests ne
// vérifiaient pas (chargement, nouvel essai, état « modifié », questions éditées en place…).
describe('QuizEditor — parcours complémentaires', () => {
  const titleField = () => screen.getByPlaceholderText(formT.titlePlaceholder) as HTMLInputElement;

  async function addTrueFalse(prompt: string) {
    fireEvent.click(screen.getByText(formT.addQuestion));
    await screen.findByText(editorT.newQuestionTitle);
    fireEvent.change(promptField(), { target: { value: prompt } });
    fireEvent.click(screen.getByLabelText(qT.typeLabel, { exact: false }));
    fireEvent.click(screen.getByRole('option', { name: 'Vrai/Faux' }));
  }

  it('liste : indicateur de chargement tant que le serveur n’a pas répondu', async () => {
    let resolve!: (quizzes: Quiz[]) => void;
    const onFetchQuizzes = vi.fn(() => new Promise<Quiz[]>((res) => (resolve = res)));
    renderEditor({ quizzes: [], handlers: { onFetchQuizzes } });
    expect(screen.getByText(listT.loading)).toBeTruthy();
    expect(screen.queryByText(listT.empty)).toBeNull();
    await act(async () => resolve([makeQuiz({ id: 3, title: 'Chargé' })]));
    expect(screen.queryByText(listT.loading)).toBeNull();
    expect(screen.getByText('Chargé')).toBeTruthy();
  });

  it('ouverture en échec : « Réessayer » relance le chargement et ouvre le formulaire', async () => {
    const onFetchQuiz = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeQuiz({ id: 1, title: 'Quiz A' }));
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Quiz A' })], handlers: { onFetchQuiz } });
    fireEvent.click(screen.getByLabelText(listT.editAria('Quiz A')));
    await screen.findByText(editorT.loadError);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText(editorT.editQuizTitle)).toBeTruthy();
    expect(onFetchQuiz).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(editorT.loadError)).toBeNull();
  });

  it('après un enregistrement réussi, la session n’est plus modifiée : la croix ferme directement', async () => {
    const onUpdateQuiz = vi.fn(async (_id: number, quiz: Quiz) => quiz);
    const { onClose } = renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q' })],
      handlers: { onUpdateQuiz },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.change(titleField(), { target: { value: 'Q renommé' } });
    fireEvent.click(screen.getByText(formT.save));
    await waitFor(() => expect(onUpdateQuiz).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('supprimer une question rend la session modifiée : la croix demande confirmation', async () => {
    const { onClose } = renderEditor({
      quizzes: [
        makeQuiz({ id: 1, title: 'Q', questions: [{ id: 7, qType: 'true_false', prompt: 'X', totalScore: 1 }] }),
      ],
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByLabelText(formT.deleteQuestionAria));
    expect(screen.getByText(editorT.deleteQuestionBody)).toBeTruthy(); // texte propre aux questions
    fireEvent.click(screen.getByText('Supprimer'));
    await waitFor(() => expect(screen.queryByText(editorT.deleteQuestionTitle)).toBeNull());
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.getByText(editorT.discardTitle)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('supprimer un quiz : la confirmation porte le texte propre aux quiz', () => {
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })] });
    fireEvent.click(screen.getByLabelText(listT.deleteAria('Q')));
    expect(screen.getByText(editorT.deleteQuizBody)).toBeTruthy();
    expect(screen.queryByText(editorT.deleteQuestionBody)).toBeNull();
  });

  it('modifier une question existante la remplace en place (pas de doublon)', async () => {
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q', questions: [] })],
      handlers: { onFetchQuestionTypes: () => QUESTION_TYPES },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    await addTrueFalse('Première version');
    fireEvent.click(screen.getByText(qT.add));
    await screen.findByText('Première version');
    fireEvent.click(screen.getByLabelText(formT.editQuestionAria));
    await screen.findByText(editorT.editQuestionTitle);
    fireEvent.change(promptField(), { target: { value: 'Version corrigée' } });
    fireEvent.click(screen.getByText(qT.save));
    await screen.findByText('Version corrigée');
    expect(screen.queryByText('Première version')).toBeNull();
    expect(screen.getAllByLabelText(formT.editQuestionAria)).toHaveLength(1);
  });

  it('sous-titre de l’éditeur de question : position dans le quiz (« Question n »)', async () => {
    renderEditor({
      quizzes: [
        makeQuiz({
          id: 1,
          title: 'Q',
          questions: [
            { id: 7, qType: 'true_false', prompt: 'Un', totalScore: 1 },
            { id: 8, qType: 'true_false', prompt: 'Deux', totalScore: 1 },
          ],
        }),
      ],
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getAllByLabelText(formT.editQuestionAria)[1]);
    expect(await screen.findByText(editorT.questionSubtitle(2))).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Retour')); // rien de modifié : retour direct
    fireEvent.click(screen.getByText(formT.addQuestion));
    expect(await screen.findByText(editorT.questionSubtitle(3))).toBeTruthy();
  });

  it('retour depuis la vue « Tester » : aucune confirmation, on revient à la question', async () => {
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q', questions: [] })],
      handlers: { onFetchQuestionTypes: () => QUESTION_TYPES },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    await addTrueFalse('À tester'); // session modifiée
    fireEvent.click(screen.getByText(qT.test));
    await screen.findByText(editorT.testTitle);
    fireEvent.click(screen.getByLabelText('Retour'));
    expect(screen.queryByText(editorT.discardTitle)).toBeNull();
    expect(await screen.findByText(editorT.newQuestionTitle)).toBeTruthy();
    expect(promptField().value).toBe('À tester');
  });
});

// Deuxième passe Stryker (#117) : parcours encore non vérifiés (réordonnancements réussis,
// création puis modification, indicateurs d'attente, identifiants temporaires).
describe('QuizEditor — parcours complémentaires (2)', () => {
  function setElementFromPoint(el: Element | null) {
    (
      document as unknown as { elementFromPoint: (x: number, y: number) => Element | null }
    ).elementFromPoint = () => el;
  }

  /** Glisse la rangée `from` (par sa poignée) sur la rangée `over`, puis relâche. */
  function dragRow(from: string, over: string) {
    const src = document.querySelector(`[data-reorder-id="${from}"]`) as HTMLElement;
    const dst = document.querySelector(`[data-reorder-id="${over}"]`) as HTMLElement;
    const grip = src.querySelector('span') as HTMLElement;
    (grip as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
    fireEvent.pointerDown(grip, { button: 0, pointerType: 'mouse', pointerId: 1 });
    setElementFromPoint(dst);
    act(() => {
      window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 0, clientY: 30 }));
    });
    act(() => {
      window.dispatchEvent(new Event('pointerup'));
    });
    fireEvent.click(grip); // clic de fin de geste, avalé par le hook
  }

  const twoQuestions = () =>
    makeQuiz({
      id: 1,
      title: 'Q',
      questions: [
        { id: 7, qType: 'true_false', prompt: 'Première', totalScore: 1 },
        { id: 8, qType: 'true_false', prompt: 'Seconde', totalScore: 1 },
      ],
    });

  it('réordonner les questions du formulaire : nouvel ordre enregistré, session modifiée', async () => {
    const onUpdateQuiz = vi.fn(async (_id: number, quiz: Quiz) => quiz);
    const { onClose } = renderEditor({ quizzes: [twoQuestions()], handlers: { onUpdateQuiz } });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    dragRow('8', '7');
    // Session modifiée : la croix demande confirmation.
    fireEvent.click(screen.getByLabelText('Fermer'));
    expect(screen.getByText(editorT.discardTitle)).toBeTruthy();
    fireEvent.click(screen.getByText(editorT.discardCancel));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(formT.save));
    await waitFor(() => expect(onUpdateQuiz).toHaveBeenCalled());
    const payload = onUpdateQuiz.mock.calls[0][1];
    expect(payload.questions!.map((q) => q.id)).toEqual([8, 7]);
  });

  it('réordonner les quiz (succès) : persisté avec le nouvel ordre et remonté à la barre latérale', async () => {
    const onReorderQuizzes = vi.fn(async () => {});
    const onQuizzesChange = vi.fn();
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Quiz A' }), makeQuiz({ id: 2, title: 'Quiz B' })],
      handlers: { onReorderQuizzes },
      onQuizzesChange,
    });
    dragRow('2', '1');
    await waitFor(() => expect(onReorderQuizzes).toHaveBeenCalledWith(42, [2, 1]));
    const last = onQuizzesChange.mock.calls.at(-1)?.[0] as Quiz[];
    expect(last.map((q) => q.id)).toEqual([2, 1]);
    expect(screen.queryByText(editorT.reorderError)).toBeNull();
  });

  it('réordonner les quiz sans persistance (mode mémoire) : ordre local seulement', () => {
    const onQuizzesChange = vi.fn();
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Quiz A' }), makeQuiz({ id: 2, title: 'Quiz B' })],
      onQuizzesChange,
    });
    dragRow('2', '1');
    const last = onQuizzesChange.mock.calls.at(-1)?.[0] as Quiz[];
    expect(last.map((q) => q.id)).toEqual([2, 1]);
  });

  it('créer puis enregistrer à nouveau : le formulaire passe en modification, le 2e appel met à jour', async () => {
    const onCreateQuiz = vi.fn(async (_c: number, quiz: Quiz) => ({ ...quiz, id: 999 }));
    const onUpdateQuiz = vi.fn(async (_id: number, quiz: Quiz) => quiz);
    renderEditor({ quizzes: [], handlers: { onCreateQuiz, onUpdateQuiz } });
    fireEvent.click(screen.getByText(listT.create));
    // Quiz neuf : rien de coché par défaut.
    expect(screen.getByRole('switch', { name: formT.daily }).getAttribute('aria-checked')).toBe('false');
    fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), { target: { value: 'Nouveau' } });
    fireEvent.click(screen.getByText(formT.create));
    await screen.findByText(editorT.editQuizTitle);
    expect(screen.getByText(formT.save)).toBeTruthy();
    fireEvent.click(screen.getByText(formT.save));
    await waitFor(() =>
      expect(onUpdateQuiz).toHaveBeenCalledWith(999, expect.objectContaining({ title: 'Nouveau' }))
    );
    expect(onCreateQuiz).toHaveBeenCalledTimes(1);
  });

  it('créer sans persistance (mode mémoire) : le formulaire passe aussi en modification', async () => {
    renderEditor({ quizzes: [] });
    fireEvent.click(screen.getByText(listT.create));
    fireEvent.change(screen.getByPlaceholderText(formT.titlePlaceholder), { target: { value: 'Local' } });
    fireEvent.click(screen.getByText(formT.create));
    expect(await screen.findByText(editorT.editQuizTitle)).toBeTruthy();
    expect(screen.queryByText(formT.create)).toBeNull();
  });

  it('pendant l’enregistrement, le bouton est désactivé ; il revient après la réponse', async () => {
    let resolve!: () => void;
    const onUpdateQuiz = vi.fn(() => new Promise<void>((res) => (resolve = res)));
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })], handlers: { onUpdateQuiz } });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    fireEvent.click(screen.getByText(formT.save));
    const lastButton = () => screen.getAllByRole('button').at(-1) as HTMLButtonElement;
    await waitFor(() => expect(lastButton().disabled).toBe(true));
    await act(async () => resolve());
    expect(screen.getByText(formT.save).closest('button')!.disabled).toBe(false);
  });

  it('ouverture en cours : le crayon du quiz est marqué occupé jusqu’à la réponse', async () => {
    let resolve!: (q: Quiz) => void;
    const onFetchQuiz = vi.fn(() => new Promise<Quiz>((res) => (resolve = res)));
    renderEditor({ quizzes: [makeQuiz({ id: 1, title: 'Q' })], handlers: { onFetchQuiz } });
    const pencil = screen.getByLabelText(listT.editAria('Q'));
    fireEvent.click(pencil);
    expect(pencil.getAttribute('aria-busy')).toBe('true');
    await act(async () => resolve(makeQuiz({ id: 1, title: 'Q' })));
    expect(await screen.findByText(editorT.editQuizTitle)).toBeTruthy();
  });

  it('deux nouvelles questions reçoivent des identifiants distincts (aucune n’écrase l’autre)', async () => {
    renderEditor({
      quizzes: [makeQuiz({ id: 1, title: 'Q', questions: [] })],
      handlers: { onFetchQuestionTypes: () => QUESTION_TYPES },
    });
    fireEvent.click(screen.getByLabelText(listT.editAria('Q')));
    for (const prompt of ['Alpha', 'Bêta']) {
      fireEvent.click(screen.getByText(formT.addQuestion));
      await screen.findByText(editorT.newQuestionTitle);
      fireEvent.change(promptField(), { target: { value: prompt } });
      fireEvent.click(screen.getByLabelText(qT.typeLabel, { exact: false }));
      fireEvent.click(screen.getByRole('option', { name: 'Vrai/Faux' }));
      fireEvent.click(screen.getByText(qT.add));
      await screen.findByText(prompt);
    }
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Bêta')).toBeTruthy();
    const ids = [...document.querySelectorAll('[data-reorder-id]')].map((el) =>
      el.getAttribute('data-reorder-id')
    );
    expect(new Set(ids).size).toBe(2);
    // Identifiants temporaires (négatifs) tant que les questions ne sont pas enregistrées.
    expect(ids.every((id) => Number(id) < 0)).toBe(true);
  });
});
