import React from 'react';
import styles from './MainPanel.module.css';
import { type CourseChannel } from '../CourseChannelList/CourseChannelList.tsx';
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
  /** Un programme est-il selectionne ? (false → etat 1). */
  hasActiveProgram: boolean;
  /** Le programme actif a-t-il au moins un cours ? (false → etat 2). */
  hasCourses: boolean;
  /** Le cours selectionne a-t-il au moins un canal/forum/quiz ? (false → etat 3). */
  hasChannels: boolean;
  /** Canal/forum/quiz actuellement selectionne (null → etat 4). */
  selectedChannel: CourseChannel | null;
  /** Libelle du programme actif (contexte d'en-tete des vues). */
  programLabel: string;
  /** Libelle du cours selectionne (contexte d'en-tete des vues). */
  courseLabel: string;
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
  hasActiveProgram,
  hasCourses,
  hasChannels,
  selectedChannel,
  programLabel,
  courseLabel,
  onAddProgram,
  onAddCourse,
  onCreateChannel,
  onCreateQuiz,
  onCreateForum,
}) => {
  const content = ((): React.ReactElement => {
    // 1 — aucun programme rejoint.
    if (!hasActiveProgram) return <NoProgramState isAdmin={isAdmin} onAddProgram={onAddProgram} />;
    // 2 — le programme n'a aucun cours.
    if (!hasCourses) return <NoCourseState isAdmin={isAdmin} onAddCourse={onAddCourse} />;
    // 3 — le cours selectionne est vide (aucun canal/forum/quiz).
    if (!hasChannels)
      return (
        <EmptyCourseState
          isAdmin={isAdmin}
          onCreateChannel={onCreateChannel}
          onCreateQuiz={onCreateQuiz}
          onCreateForum={onCreateForum}
        />
      );
    // 4 — le cours a du contenu mais rien n'est selectionne.
    if (!selectedChannel) return <NoActiveChannelState />;

    // 5/6/7 — un canal est selectionne : on route selon son type.
    switch (selectedChannel.type) {
      case 'forum': // f_type 'Thread'
        return (
          <ForumView channel={selectedChannel} programLabel={programLabel} courseLabel={courseLabel} />
        );
      case 'quiz':
        return (
          <QuizView channel={selectedChannel} programLabel={programLabel} courseLabel={courseLabel} />
        );
      case 'text': // f_type 'Discussion'
      default:
        return (
          <ChannelView channel={selectedChannel} programLabel={programLabel} courseLabel={courseLabel} />
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
