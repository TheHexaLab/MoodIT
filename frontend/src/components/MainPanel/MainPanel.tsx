import React from 'react';
import styles from './MainPanel.module.css';
import {
  type ChannelMessage,
  type ChannelMessageAuthor,
  type ChannelRef,
  isSameChannel,
} from '../CourseChannelList/CourseChannelList.tsx';
import { normalizeCourseChannelsFromSources } from '../CourseChannelList/courseChannelSources.ts';
import { type Program } from '../ProgramMenu/ProgramMenu.tsx';
import { type MaybePromise } from './ChannelView/useChannelMessages.ts';
import ChannelView, {
  type ChannelSocket,
  type DeleteMessageHandler,
  type EditMessageHandler,
  type SendMessageHandler,
} from './ChannelView/ChannelView.tsx';
import ForumView, {
  type CreatePostHandler,
  type DeletePostHandler,
  type EditPostHandler,
  type FetchRepliesHandler,
  type FetchThreadsHandler,
  type ForumSocket,
  type VotePostHandler,
} from './ForumView/ForumView.tsx';
import QuizView from './QuizView/QuizView.tsx';
import {
  type FetchAttemptResultHandler,
  type FetchAttemptsHandler,
  type FetchQuizHandler,
  type RunCodeHandler,
  type SubmitQuizHandler,
  type SubscribeCodeGrading,
} from './QuizView/quizAttempt.ts';
import NoProgramState from './states/NoProgramState/NoProgramState.tsx';
import NoCourseState from './states/NoCourseState/NoCourseState.tsx';
import EmptyCourseState from './states/EmptyCourseState/EmptyCourseState.tsx';
import NoActiveChannelState from './states/NoActiveChannelState/NoActiveChannelState.tsx';

interface MainPanelProps {
  /** Utilisateur administrateur : débloque les actions de creation dans les états vides. */
  isAdmin?: boolean;
  /** Programme actif (null → état 1 ; sans cours → état 2). */
  program: Program | null;
  /** Id du cours sélectionné dans le programme actif. */
  selectedCourse: number | null;
  /** Reference (type + id) du canal/forum/quiz sélectionné (null → état 4). */
  selectedChannel: ChannelRef | null;
  /** Utilisateur connecte (auteur des messages envoyes dans un canal). */
  currentUser: ChannelMessageAuthor;
  /** Chargement paginé des messages d'un canal (API-ready ; voir ChannelView). */
  onFetchMessages?: (
    channelId: number,
    before?: number,
    limit?: number
  ) => MaybePromise<ChannelMessage[]>;
  /** Envoi d'un message dans le canal actif (API-ready ; voir ChannelView). */
  onSendMessage?: SendMessageHandler;
  /** Modification d'un de ses messages (API-ready ; voir ChannelView). */
  onEditMessage?: EditMessageHandler;
  /** Suppression d'un de ses messages (API-ready ; voir ChannelView). */
  onDeleteMessage?: DeleteMessageHandler;
  /** Socket temps reel (optionnel) : reception des messages des autres users. */
  socket?: ChannelSocket;
  /** Chargement des sujets d'un forum (API-ready ; voir ForumView). */
  onFetchThreads?: FetchThreadsHandler;
  /** Chargement paresseux des reponses d'un post de forum (API-ready ; voir ForumView). */
  onFetchReplies?: FetchRepliesHandler;
  /** Publication d'une reponse dans le forum actif (API-ready ; voir ForumView). */
  onCreatePost?: CreatePostHandler;
  /** Modification d'un post de forum (API-ready ; voir ForumView). */
  onEditPost?: EditPostHandler;
  /** Suppression d'un post de forum (API-ready ; voir ForumView). */
  onDeletePost?: DeletePostHandler;
  /** Vote sur un post de forum (API-ready ; voir ForumView). */
  onVotePost?: VotePostHandler;
  /** Socket temps reel du forum (optionnel) : posts/votes des autres users. */
  forumSocket?: ForumSocket;
  /** Ouvre le formulaire d'ajout / d'adhésion a un programme (admin). */
  onAddProgram?: () => void;
  /** Ouvre le formulaire d'ajout de cours (admin). */
  onAddCourse?: () => void;
  /** Ouvre le formulaire de creation de canal (admin). */
  onCreateChannel?: () => void;
  /** Ouvre le formulaire de creation de quiz (admin). */
  onCreateQuiz?: () => void;
  /** Chargement du detail d'un quiz (API-ready ; voir QuizView). */
  onFetchQuiz?: FetchQuizHandler;
  /** Historique des tentatives (API-ready ; voir QuizView). */
  onFetchAttempts?: FetchAttemptsHandler;
  /** Détail corrigé d'une tentative (API-ready ; voir QuizView). */
  onFetchAttemptResult?: FetchAttemptResultHandler;
  /** Soumission d'une tentative de quiz (API-ready ; voir QuizView). */
  onSubmitQuiz?: SubmitQuizHandler;
  onSubscribeCodeGrading?: SubscribeCodeGrading;
  /** Exécute le code d'une question Code dans le sandbox (bouton « play » ; voir QuizView). */
  onRunCode?: RunCodeHandler;
  /** Bump à chaque mise à jour de quiz : remonte la vue de quiz ouverte (rechargement). */
  quizRefreshKey?: number;
  /** Le quiz ouvert a été modifié à distance → bannière de rechargement. */
  quizStale?: boolean;
  /** Ferme/efface la bannière « quiz modifié » (après rechargement ou rejet). */
  onReloadStale?: () => void;
  /** Ouvre le formulaire de creation de forum (admin). */
  onCreateForum?: () => void;
}

/**
 * Panneau principal (colonne de droite) du Dashboard.
 * Route, selon l'état courant, vers l'un des 7 contenus possibles :
 * 4 états vides (propres au Dashboard) puis 3 vues de contenu
 * (canal 'Discussion', forum 'Thread', quiz).
 */
const MainPanel: React.FC<MainPanelProps> = ({
  isAdmin = false,
  program,
  selectedCourse,
  selectedChannel,
  currentUser,
  onFetchMessages,
  onSendMessage,
  onEditMessage,
  onDeleteMessage,
  socket,
  onFetchThreads,
  onFetchReplies,
  onCreatePost,
  onEditPost,
  onDeletePost,
  onVotePost,
  forumSocket,
  onAddProgram,
  onAddCourse,
  onCreateChannel,
  onCreateQuiz,
  onCreateForum,
  onFetchQuiz,
  onFetchAttempts,
  onFetchAttemptResult,
  onSubmitQuiz,
  onSubscribeCodeGrading,
  onRunCode,
  quizRefreshKey = 0,
  quizStale = false,
  onReloadStale,
}) => {
  const content = ((): React.ReactElement => {
    // 1 — aucun programme rejoint.
    if (!program) {
      return <NoProgramState isAdmin={isAdmin} onAddProgram={onAddProgram} />;
    }
    // 2 — le programme n'a aucun cours.
    const courses = program.courses ?? [];
    if (courses.length === 0) {
      return <NoCourseState isAdmin={isAdmin} onAddCourse={onAddCourse} />;
    }
    // 3 — le cours sélectionné est vide (aucun canal/forum/quiz).
    const course = courses.find((c) => c.id === selectedCourse) ?? null;
    const courseChannels = course
      ? normalizeCourseChannelsFromSources({
          quizzes: course.quizzes,
          forums: course.forums,
        })
      : [];
    if (courseChannels.length === 0) {
      return (
        <EmptyCourseState
          isAdmin={isAdmin}
          onCreateChannel={onCreateChannel}
          onCreateQuiz={onCreateQuiz}
          onCreateForum={onCreateForum}
        />
      );
    }
    // 4 — le cours a du contenu, mais rien n'est sélectionné.
    const channel = courseChannels.find((ch) => isSameChannel(ch, selectedChannel)) ?? null;
    if (!course || !channel) {
      return <NoActiveChannelState />;
    }

    // 5/6/7 — un canal est sélectionné : on route selon son type.
    switch (channel.type) {
      case 'forum': // fType 'Thread'
        return (
          <ForumView
            key={`${channel.type}-${channel.id}`}
            course={course}
            channel={channel}
            currentUser={currentUser}
            onFetchThreads={onFetchThreads}
            onFetchReplies={onFetchReplies}
            onCreatePost={onCreatePost}
            onEditPost={onEditPost}
            onDeletePost={onDeletePost}
            onVotePost={onVotePost}
            socket={forumSocket}
          />
        );
      case 'quiz':
        return (
          <QuizView
            key={`${channel.type}-${channel.id}-${quizRefreshKey}`}
            course={course}
            channel={channel}
            onFetchQuiz={onFetchQuiz}
            onFetchAttempts={onFetchAttempts}
            onFetchAttemptResult={onFetchAttemptResult}
            onSubmitQuiz={onSubmitQuiz}
            onSubscribeCodeGrading={onSubscribeCodeGrading}
            onRunCode={onRunCode}
            staleNotice={quizStale}
            onReloadStale={onReloadStale}
          />
        );
      case 'text': // fType 'Discussion'
      default:
        return (
          <ChannelView
            key={`${channel.type}-${channel.id}`}
            course={course}
            channel={channel}
            currentUser={currentUser}
            onFetchMessages={onFetchMessages}
            onSendMessage={onSendMessage}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
            socket={socket}
          />
        );
    }
  })();

  return (
    <section className={styles.mainPanel} aria-label="Contenu principal">
      {content}
    </section>
  );
};

export default MainPanel;
