import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { Program } from '../ProgramMenu/ProgramMenu';
import type { ChannelMessageAuthor } from '../CourseChannelList/CourseChannelList';
import { ROLE } from '../../helpers/roles';
import { defaultLabels as noProgramLabels } from './states/NoProgramState/labels';
import { defaultLabels as noCourseLabels } from './states/NoCourseState/labels';
import { defaultLabels as emptyCourseLabels } from './states/EmptyCourseState/labels';
import { defaultLabels as noActiveLabels } from './states/NoActiveChannelState/labels';

// Les trois vues de contenu sont remplacées par des doublures qui enregistrent leurs props :
// on teste ici le ROUTAGE du panneau (quelle vue, avec quelles données), pas les vues
// elles-mêmes (couvertes par ChannelView.test / ForumView.test / QuizView.test).
const channelViewProps = vi.fn();
const forumViewProps = vi.fn();
const quizViewProps = vi.fn();
vi.mock('./ChannelView/ChannelView.tsx', () => ({
  default: (props: { channel: { name: string } }) => {
    channelViewProps(props);
    return <div data-testid="channel-view">{props.channel.name}</div>;
  },
}));
vi.mock('./ForumView/ForumView.tsx', () => ({
  default: (props: { channel: { name: string } }) => {
    forumViewProps(props);
    return <div data-testid="forum-view">{props.channel.name}</div>;
  },
}));
vi.mock('./QuizView/QuizView.tsx', () => ({
  default: (props: { channel: { name: string } }) => {
    quizViewProps(props);
    return <div data-testid="quiz-view">{props.channel.name}</div>;
  },
}));

import MainPanel from './MainPanel';

beforeEach(() => {
  channelViewProps.mockClear();
  forumViewProps.mockClear();
  quizViewProps.mockClear();
});
afterEach(cleanup);

const me: ChannelMessageAuthor = { id: 1, username: 'jean', firstName: 'Jean', lastName: 'D' };

function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 1,
    name: 'Génie',
    code: 'GIN',
    cohort: '',
    color: '',
    courses: [
      {
        id: 10,
        code: 'IFT101',
        forums: [
          { id: 5, title: 'general', fType: 'Discussion' },
          { id: 6, title: 'entraide', fType: 'Thread' },
        ],
        quizzes: [{ id: 5, title: 'Quiz intro' }],
      },
      { id: 20, code: 'VIDE' },
    ],
    ...overrides,
  };
}

type Props = React.ComponentProps<typeof MainPanel>;
function renderPanel(props: Partial<Props> = {}) {
  return render(
    <MainPanel
      program={makeProgram()}
      selectedCourse={10}
      selectedChannel={null}
      currentUser={me}
      {...props}
    />
  );
}

describe('MainPanel', () => {
  it('enveloppe le contenu dans une région « Contenu principal »', () => {
    renderPanel();
    expect(screen.getByRole('region', { name: 'Contenu principal' })).toBeTruthy();
  });

  describe('états vides', () => {
    it('1 — aucun programme : NoProgramState, actions transmises', () => {
      const onJoinProgram = vi.fn();
      const onAddProgram = vi.fn();
      renderPanel({ program: null, isAdmin: true, onJoinProgram, onAddProgram });
      expect(screen.getByRole('heading', { name: noProgramLabels.title })).toBeTruthy();
      fireEvent.click(screen.getByText(noProgramLabels.joinProgram));
      fireEvent.click(screen.getByText(noProgramLabels.addProgram));
      expect(onJoinProgram).toHaveBeenCalledTimes(1);
      expect(onAddProgram).toHaveBeenCalledTimes(1);
    });

    it('2 — programme sans cours : NoCourseState (courses absent ou vide)', () => {
      const onJoinCourse = vi.fn();
      renderPanel({ program: makeProgram({ courses: undefined }), onJoinCourse });
      expect(screen.getByRole('heading', { name: noCourseLabels.title })).toBeTruthy();
      // Non-admin : pas de bouton de création.
      expect(screen.queryByText(noCourseLabels.addCourse)).toBeNull();
      fireEvent.click(screen.getByText(noCourseLabels.joinCourse));
      expect(onJoinCourse).toHaveBeenCalledTimes(1);
    });

    it('2 — admin : le bouton « Créer un cours » appelle onAddCourse', () => {
      const onAddCourse = vi.fn();
      renderPanel({ program: makeProgram({ courses: [] }), isAdmin: true, onAddCourse });
      fireEvent.click(screen.getByText(noCourseLabels.addCourse));
      expect(onAddCourse).toHaveBeenCalledTimes(1);
    });

    it('3 — cours sélectionné vide : EmptyCourseState, création transmise (admin)', () => {
      const onCreateChannel = vi.fn();
      const onCreateQuiz = vi.fn();
      const onCreateForum = vi.fn();
      renderPanel({
        selectedCourse: 20,
        isAdmin: true,
        onCreateChannel,
        onCreateQuiz,
        onCreateForum,
      });
      expect(screen.getByRole('heading', { name: emptyCourseLabels.title })).toBeTruthy();
      fireEvent.click(screen.getByText(emptyCourseLabels.createChannel));
      fireEvent.click(screen.getByText(emptyCourseLabels.createQuiz));
      fireEvent.click(screen.getByText(emptyCourseLabels.createForum));
      expect(onCreateChannel).toHaveBeenCalledTimes(1);
      expect(onCreateQuiz).toHaveBeenCalledTimes(1);
      expect(onCreateForum).toHaveBeenCalledTimes(1);
    });

    it('3 — cours sélectionné introuvable : traité comme un cours vide', () => {
      renderPanel({ selectedCourse: 999 });
      expect(screen.getByRole('heading', { name: emptyCourseLabels.title })).toBeTruthy();
    });

    it('4 — cours avec contenu mais rien de sélectionné : NoActiveChannelState', () => {
      renderPanel({ selectedChannel: null });
      expect(screen.getByRole('heading', { name: noActiveLabels.title })).toBeTruthy();
    });

    it('4 — canal sélectionné absent du cours : NoActiveChannelState', () => {
      renderPanel({ selectedChannel: { type: 'text', id: 999 } });
      expect(screen.getByRole('heading', { name: noActiveLabels.title })).toBeTruthy();
      expect(channelViewProps).not.toHaveBeenCalled();
    });
  });

  describe('vues de contenu', () => {
    it('canal « Discussion » : ChannelView avec le canal, le cours et les handlers', () => {
      const onSendMessage = vi.fn();
      const socket = { subscribe: vi.fn() };
      renderPanel({
        selectedChannel: { type: 'text', id: 5 },
        onSendMessage,
        socket: socket as unknown as Props['socket'],
      });
      expect(screen.getByTestId('channel-view').textContent).toBe('general');
      const props = channelViewProps.mock.calls.at(-1)?.[0];
      expect(props.channel).toEqual(expect.objectContaining({ id: 5, type: 'text' }));
      expect(props.course.id).toBe(10);
      expect(props.currentUser).toBe(me);
      expect(props.onSendMessage).toBe(onSendMessage);
      expect(props.socket).toBe(socket);
      expect(props.canModerate).toBe(false);
    });

    it('forum « Thread » : ForumView avec son propre socket', () => {
      const forumSocket = { subscribe: vi.fn() };
      const onVotePost = vi.fn();
      renderPanel({
        selectedChannel: { type: 'forum', id: 6 },
        forumSocket: forumSocket as unknown as Props['forumSocket'],
        onVotePost,
      });
      expect(screen.getByTestId('forum-view').textContent).toBe('entraide');
      const props = forumViewProps.mock.calls.at(-1)?.[0];
      expect(props.socket).toBe(forumSocket);
      expect(props.onVotePost).toBe(onVotePost);
      expect(screen.queryByTestId('channel-view')).toBeNull();
    });

    it('quiz : QuizView, en distinguant le quiz id 5 du canal id 5', () => {
      const onSubmitQuiz = vi.fn();
      const onReloadStale = vi.fn();
      renderPanel({
        selectedChannel: { type: 'quiz', id: 5 },
        onSubmitQuiz,
        quizStale: true,
        onReloadStale,
      });
      expect(screen.getByTestId('quiz-view').textContent).toBe('Quiz intro');
      expect(screen.queryByTestId('channel-view')).toBeNull();
      const props = quizViewProps.mock.calls.at(-1)?.[0];
      expect(props.onSubmitQuiz).toBe(onSubmitQuiz);
      expect(props.staleNotice).toBe(true);
      expect(props.onReloadStale).toBe(onReloadStale);
    });

    it('type inconnu : retombe sur ChannelView', () => {
      renderPanel({
        program: makeProgram({
          courses: [{ id: 10, forums: [{ id: 7, title: 'divers', fType: 'Discussion' }] }],
        }),
        selectedChannel: { type: 'text', id: 7 },
      });
      expect(screen.getByTestId('channel-view').textContent).toBe('divers');
    });

    it('changer quizRefreshKey remonte la vue de quiz (nouvelle instance)', () => {
      const { rerender } = renderPanel({ selectedChannel: { type: 'quiz', id: 5 }, quizRefreshKey: 0 });
      const first = screen.getByTestId('quiz-view');
      rerender(
        <MainPanel
          program={makeProgram()}
          selectedCourse={10}
          selectedChannel={{ type: 'quiz', id: 5 }}
          currentUser={me}
          quizRefreshKey={1}
        />
      );
      expect(screen.getByTestId('quiz-view')).not.toBe(first);
    });
  });

  describe('droit de modération', () => {
    it('admin global : canModerate vrai', () => {
      renderPanel({ isAdmin: true, selectedChannel: { type: 'text', id: 5 } });
      expect(channelViewProps.mock.calls.at(-1)?.[0].canModerate).toBe(true);
    });

    it('administrateur du programme : canModerate vrai', () => {
      renderPanel({
        program: makeProgram({ roleName: ROLE.ADMIN }),
        selectedChannel: { type: 'forum', id: 6 },
      });
      expect(forumViewProps.mock.calls.at(-1)?.[0].canModerate).toBe(true);
    });

    it('enseignant du programme : canModerate faux', () => {
      renderPanel({
        program: makeProgram({ roleName: ROLE.TEACHER }),
        selectedChannel: { type: 'text', id: 5 },
      });
      expect(channelViewProps.mock.calls.at(-1)?.[0].canModerate).toBe(false);
    });
  });
});
