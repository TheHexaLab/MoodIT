import React from 'react';
import styles from './MainPanel.module.css';
import { type ChannelRef, isSameChannel } from '../CourseChannelList/CourseChannelList.tsx';
import { normalizeCourseChannelsFromSources } from '../CourseChannelList/courseChannelSources.ts';
import { type Program } from '../ProgramMenu/ProgramMenu.tsx';
import ChannelView from './ChannelView/ChannelView.tsx';
import ForumView from './ForumView/ForumView.tsx';
import QuizView from './QuizView/QuizView.tsx';
import NoProgramState from './states/NoProgramState/NoProgramState.tsx';
import NoCourseState from './states/NoCourseState/NoCourseState.tsx';
import EmptyCourseState from './states/EmptyCourseState/EmptyCourseState.tsx';
import NoActiveChannelState from './states/NoActiveChannelState/NoActiveChannelState.tsx';

interface MainPanelProps {
  /** Utilisateur administrateur : debloque les actions de creation dans les etats vides. */
  isAdmin?: boolean;
  /** Programme actif (null → etat 1 ; sans cours → etat 2). */
  program: Program | null;
  /** Id du cours selectionne dans le programme actif. */
  selectedCourse?: number;
  /** Reference (type + id) du canal/forum/quiz selectionne (undefined → etat 4). */
  selectedChannel?: ChannelRef;
  /** Ouvre le formulaire d'ajout / d'adhesion a un programme (admin). */
  onAddProgram?: () => void;
  /** Ouvre le formulaire d'ajout de cours (admin). */
  onAddCourse?: () => void;
  /** Ouvre le formulaire de creation de canal (admin). */
  onCreateChannel?: () => void;
  /** Ouvre le formulaire de creation de quiz (admin). */
  onCreateQuiz?: () => void;
  /** Ouvre le formulaire de creation de forum (admin). */
  onCreateForum?: () => void;
}

/**
 * Panneau principal (colonne de droite) du Dashboard.
 * Route, selon l'etat courant, vers l'un des 7 contenus possibles :
 * 4 etats vides (propres au Dashboard) puis 3 vues de contenu
 * (canal 'Discussion', forum 'Thread', quiz).
 */
const MainPanel: React.FC<MainPanelProps> = ({
  isAdmin = false,
  program,
  selectedCourse,
  selectedChannel,
  onAddProgram,
  onAddCourse,
  onCreateChannel,
  onCreateQuiz,
  onCreateForum,
}) => {
  const content = ((): React.ReactElement => {
    // 1 — aucun programme rejoint.
    if (!program) return <NoProgramState isAdmin={isAdmin} onAddProgram={onAddProgram} />;
    // 2 — le programme n'a aucun cours.
    const courses = program.courses ?? [];
    if (courses.length === 0)
      return <NoCourseState isAdmin={isAdmin} onAddCourse={onAddCourse} />;
    // 3 — le cours selectionne est vide (aucun canal/forum/quiz).
    const course = courses.find((c) => c.id === selectedCourse) ?? null;
    const courseChannels = course
      ? normalizeCourseChannelsFromSources({
          channels: course.channels,
          quizzes: course.quizzes,
          forums: course.forums,
        })
      : [];
    if (courseChannels.length === 0)
      return (
        <EmptyCourseState
          isAdmin={isAdmin}
          onCreateChannel={onCreateChannel}
          onCreateQuiz={onCreateQuiz}
          onCreateForum={onCreateForum}
        />
      );
    // 4 — le cours a du contenu mais rien n'est selectionne.
    const channel = courseChannels.find((ch) => isSameChannel(ch, selectedChannel)) ?? null;
    if (!course || !channel) return <NoActiveChannelState />;

    // 5/6/7 — un canal est selectionne : on route selon son type.
    switch (channel.type) {
      case 'forum': // f_type 'Thread'
        return <ForumView course={course} channel={channel} />;
      case 'quiz':
        return <QuizView course={course} channel={channel} />;
      case 'text': // f_type 'Discussion'
      default:
        return <ChannelView course={course} channel={channel} />;
    }
  })();

  return (
    <section className={styles.mainPanel} aria-label="Contenu principal">
      {content}
    </section>
  );
};

export default MainPanel;
