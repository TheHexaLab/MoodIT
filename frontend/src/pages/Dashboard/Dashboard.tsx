import { useState } from 'react';
import ProgramMenu from '../../components/ProgramMenu/ProgramMenu.tsx';
import CourseMenu, { type Course } from '../../components/CourseMenu/CourseMenu.tsx';
import {
  type ChannelRef,
  type CourseChannel,
  isSameChannel,
} from '../../components/CourseChannelList/CourseChannelList.tsx';
import { getPrefixForType } from '../../components/CourseChannelList/channelTypePrefix.ts';
import { type UserMenuUser } from '../../components/UserMenu/UserMenu.tsx';
import LeftMenuGroup from '../../components/LeftMenuGroup/LeftMenuGroup.tsx';
import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import MainPanel from '../../components/MainPanel/MainPanel.tsx';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import styles from './Dashboard.module.css';

const loggedInUserMock: UserMenuUser = {
  id: 1,
  username: 'jeandubois',
  firstName: 'Jean',
  lastName: 'D.',
  displayName: 'Jean D.',
};

// TODO : deriver du role reel de l'utilisateur connecte (mock pour l'instant).
const isAdminMock = true;

export default function Dashboard() {
  const dashboardPrograms = getDashboardPrograms();
  const [activeProgramId, setActiveProgramId] = useState<number>(
    dashboardPrograms && dashboardPrograms.length > 0 ?  dashboardPrograms[0].id : -1
  );
  const [selectedCourseId, setSelectedCourseId] = useState<number | undefined>(undefined);
  const [selectedChannelRef, setSelectedChannelRef] = useState<ChannelRef | undefined>(undefined);

  // TODO : remplacer par une navigation ou un rendu de vue lors de l'implémentation des canaux.
  const handleOpenChannel = (channel: CourseChannel) => {
    console.log('[Dashboard] Ouverture du canal :', channel);
  };

  // TODO : ouvrir le formulaire d'ajout de programme.
  const handleAddProgram = () => {
    console.log("[Dashboard] Ajout d'un programme demandé.");
  };

  // TODO : ouvrir le formulaire d'ajout de cours.
  const handleAddCourse = () => console.log('[Dashboard] Ajouter un cours demandé.');
  // TODO : ouvrir le formulaire de création de canal texte.
  const handleCreateChannel = () => console.log('[Dashboard] Créer un canal demandé.');
  // TODO : ouvrir le formulaire de création de quiz.
  const handleCreateQuiz = () => console.log('[Dashboard] Créer un quiz demandé.');
  // TODO : ouvrir le formulaire de création de forum.
  const handleCreateForum = () => console.log('[Dashboard] Créer un forum demandé.');

  const activeProgram =
    dashboardPrograms.find((program) => program.id === activeProgramId) ?? null;
  const courses = activeProgram?.courses ?? [];
  const effectiveSelectedCourseId = getEffectiveSelectedCourseId(courses, selectedCourseId);
  const selectedCourse = getSelectedCourse(courses, effectiveSelectedCourseId);
  const selectedCourseChannels = selectedCourse
    ? normalizeCourseChannelsFromSources({
        channels: selectedCourse.channels,
        quizzes: selectedCourse.quizzes,
        forums: selectedCourse.forums,
      })
    : [];
  const selectedChannel =
    selectedCourseChannels.find((channel) => isSameChannel(channel, selectedChannelRef)) ?? null;
  const mobileTopbarTitle = selectedChannel
    ? `${getPrefixForType(selectedChannel.type)} ${selectedChannel.name}`
    : 'Accueil';
  const mobileUserInitial = getUserInitial(loggedInUserMock);

  return (
    <div className={styles.dashboardLayout}>
      <LeftMenuGroup
        mobileTitle={mobileTopbarTitle}
        mobileUserInitial={mobileUserInitial}
        programMenu={
          <ProgramMenu
            programs={dashboardPrograms}
            activeProgramId={activeProgramId}
            onSelectProgram={(nextProgramId) => {
              setActiveProgramId(nextProgramId);
              setSelectedChannelRef(undefined);

              const nextProgram = dashboardPrograms.find((program) => program.id === nextProgramId);

              setSelectedCourseId(getEffectiveSelectedCourseId(nextProgram?.courses ?? [], undefined));
            }}
            onAddProgram={handleAddProgram}
          />
        }
        courseMenu={
          <CourseMenu
            activeProgram={activeProgram}
            courses={courses}
            currentUser={loggedInUserMock}
            selectedCourseId={effectiveSelectedCourseId}
            onSelectCourse={(courseId) => {
              setSelectedCourseId(courseId);
              setSelectedChannelRef(undefined);
            }}
            selectedChannel={selectedChannelRef}
            onSelectChannel={setSelectedChannelRef}
            onOpenChannel={handleOpenChannel}
          />
        }
      />

      <MainPanel
        isAdmin={isAdminMock}
        program={activeProgram}
        selectedCourse={effectiveSelectedCourseId ?? null}
        selectedChannel={selectedChannelRef ?? null}
        onAddProgram={handleAddProgram}
        onAddCourse={handleAddCourse}
        onCreateChannel={handleCreateChannel}
        onCreateQuiz={handleCreateQuiz}
        onCreateForum={handleCreateForum}
      />
    </div>
  );
}

function getUserInitial(user: UserMenuUser): string {
  const display =
    user.displayName?.trim() || user.firstName?.trim() || user.username?.trim() || 'U';
  return display[0].toUpperCase();
}

function getEffectiveSelectedCourseId(
  courses: Course[],
  selectedCourseId: number | undefined
): number | undefined {
  if (courses.length === 0) return undefined;

  const selectedCourseStillExists = courses.some((course) => course.id === selectedCourseId);

  return selectedCourseStillExists ? selectedCourseId : courses[0].id;
}

function getSelectedCourse(courses: Course[], selectedCourseId: number | undefined): Course | null {
  return courses.find((course) => course.id === selectedCourseId) ?? courses[0] ?? null;
}
