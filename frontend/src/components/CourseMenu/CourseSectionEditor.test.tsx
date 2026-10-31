import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { CourseChannel } from '../CourseChannelList/CourseChannelList';
import type { Quiz } from '../../types/domain';

// L'éditeur de quiz riche est remplacé par une doublure qui expose les props reçues :
// on vérifie ici l'AIGUILLAGE (quiz → QuizEditor), pas l'éditeur lui-même (testé à part).
const quizEditorProps = vi.fn();
vi.mock('../QuizEditor/QuizEditor.tsx', () => ({
  QuizEditor: (props: Record<string, unknown>) => {
    quizEditorProps(props);
    return <div data-testid="quiz-editor" />;
  },
}));

import { CourseSectionEditor } from './CourseSectionEditor';

// Le popup lit prefers-reduced-motion (fermeture sans animation sous jsdom).
beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
  quizEditorProps.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const channels: CourseChannel[] = [
  { id: 1, name: 'general', type: 'text' },
  { id: 2, name: 'annonces', type: 'text' },
  { id: 3, name: 'entraide', type: 'forum' },
  { id: 4, name: 'Quiz 1', type: 'quiz' },
];

describe('CourseSectionEditor', () => {
  it('section « canaux » : popup générique titré, ne listant que les canaux texte', () => {
    render(
      <CourseSectionEditor
        section={{ type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' }}
        channels={channels}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Modifier les canaux')).toBeTruthy();
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByText('annonces')).toBeTruthy();
    expect(screen.queryByText('entraide')).toBeNull();
    expect(screen.queryByText('Quiz 1')).toBeNull();
    expect(screen.getByText('Ajouter un canal')).toBeTruthy();
    expect(screen.queryByTestId('quiz-editor')).toBeNull();
  });

  it('section « forums » : libellés au singulier « forum » et état vide', () => {
    render(
      <CourseSectionEditor
        section={{ type: 'forum', label: 'FORUMS', emptyLabel: 'Aucun forum' }}
        channels={[]}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Modifier les forums')).toBeTruthy();
    expect(screen.getByText('Ajouter un forum')).toBeTruthy();
    expect(screen.getByText('Aucun forum pour le moment.')).toBeTruthy();
    fireEvent.click(screen.getByText('Ajouter un forum'));
    expect(screen.getByRole('textbox', { name: 'Nom du forum' })).toBeTruthy();
  });

  it('type inconnu : libellés génériques « élément »', () => {
    render(
      <CourseSectionEditor
        section={{ type: 'wiki', label: 'WIKIS', emptyLabel: '' }}
        channels={[]}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Ajouter un élément')).toBeTruthy();
    expect(screen.getByText('Aucun élément pour le moment.')).toBeTruthy();
    // Élision devant voyelle : « de l'élément ».
    fireEvent.click(screen.getByText('Ajouter un élément'));
    expect(screen.getByRole('textbox', { name: "Nom de l'élément" })).toBeTruthy();
  });

  it('section « quiz » avec courseId : ouvre l’éditeur de quiz avec les bonnes props', () => {
    const onClose = vi.fn();
    const onQuizzesChange = vi.fn();
    const handlers = { onFetchQuizzes: vi.fn() };
    const quizzes: Quiz[] = [{ id: 4, title: 'Quiz 1' }];
    render(
      <CourseSectionEditor
        section={{ type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' }}
        channels={channels}
        onClose={onClose}
        courseId={7}
        quizzes={quizzes}
        quizSubtitle="IFT101"
        quizHandlers={handlers}
        onQuizzesChange={onQuizzesChange}
      />
    );
    expect(screen.getByTestId('quiz-editor')).toBeTruthy();
    expect(quizEditorProps).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: 7,
        courseSubtitle: 'IFT101',
        quizzes,
        handlers,
        onQuizzesChange,
        onClose,
      })
    );
  });

  it('section « quiz » sans quiz en cache : l’éditeur reçoit une liste vide', () => {
    render(
      <CourseSectionEditor
        section={{ type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' }}
        channels={[]}
        onClose={vi.fn()}
        courseId={7}
      />
    );
    expect(quizEditorProps).toHaveBeenCalledWith(expect.objectContaining({ quizzes: [] }));
  });

  it('section « quiz » sans courseId : retombe sur le popup générique', () => {
    render(
      <CourseSectionEditor
        section={{ type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' }}
        channels={channels}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByTestId('quiz-editor')).toBeNull();
    expect(screen.getByText('Modifier les quiz')).toBeTruthy();
    expect(screen.getByText('Quiz 1')).toBeTruthy();
  });

  it('une suppression confirmée est transmise à onChange avec l’id en chaîne', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <CourseSectionEditor
        section={{ type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' }}
        channels={channels}
        onClose={vi.fn()}
        onChange={onChange}
      />
    );
    // Icônes d'action de la ligne : [crayon, corbeille] (svg nus, cf. SectionEditorPopup.test).
    const li = screen.getByText('annonces').closest('li') as HTMLLIElement;
    const svgs = li.querySelectorAll(':scope > div:last-child > svg');
    fireEvent.click(svgs[1]);
    // Corps de confirmation propre au type « canal ».
    expect(
      screen.getByText(
        'Le canal « annonces » et tout son contenu seront définitivement supprimés. Cette action est irréversible.'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ type: 'delete', id: '2' }));
  });
});
