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
    fireEvent.click(screen.getByLabelText(qT.typeLabel));
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
    fireEvent.click(screen.getByLabelText(qT.typeLabel));
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

    // La persistance a été tentée avec le nouvel ordre…
    await waitFor(() => expect(onReorderQuizzes).toHaveBeenCalledWith(42, [2, 1]));
    // …puis a échoué → popup d'erreur affiché.
    expect(await screen.findByText(editorT.reorderError)).toBeTruthy();
    // …et l'ordre a été REVERTÉ (dernier commit vers la sidebar = ordre initial [1, 2]).
    const lastCommit = onQuizzesChange.mock.calls.at(-1)?.[0] as Quiz[];
    expect(lastCommit.map((q) => q.id)).toEqual([1, 2]);
  });
});
