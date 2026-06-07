import { useState } from 'react';
import ProgramMenu, { type Program } from '../../components/ProgramMenu/ProgramMenu.tsx';
import CourseMenu, { type Course } from '../../components/CourseMenu/CourseMenu.tsx';
import { type CourseChannel } from '../../components/CourseChannelList/CourseChannelList.tsx';
import { getPrefixForType } from '../../components/CourseChannelList/channelTypePrefix.ts';
import { type UserMenuUser } from '../../components/UserMenu/UserMenu.tsx';
import LeftMenuGroup from '../../components/LeftMenuGroup/LeftMenuGroup.tsx';
import { normalizeCourseChannelsFromSources } from '../../components/CourseChannelList/courseChannelSources.ts';
import { getDashboardPrograms } from './dashboardDataSource.ts';
import styles from './Dashboard.module.css';
import gradCapIcon from '../../assets/grad-cap.svg';
import messageSquareIcon from '../../assets/message-square-lines.svg';

const loggedInUserMock: UserMenuUser = {
  id: '1',
  username: 'jeandubois',
  firstName: 'Jean',
  lastName: 'D.',
  displayName: 'Jean D.',
};

export default function Dashboard() {
  const dashboardPrograms = getDashboardPrograms();
  const [activeProgramId, setActiveProgramId] = useState<string>(
    getProgramStateId(dashboardPrograms[0])
  );
  const [selectedCourseId, setSelectedCourseId] = useState<string>('');
  const [selectedChannelId, setSelectedChannelId] = useState<string | undefined>(undefined);

  // TODO : remplacer par une navigation ou un rendu de vue lors de l'implémentation des canaux.
  const handleOpenChannel = (channel: CourseChannel) => {
    console.log('[Dashboard] Ouverture du canal :', channel);
  };

  // TODO : ouvrir le formulaire d'ajout de programme.
  const handleAddProgram = () => {
    console.log("[Dashboard] Ajout d'un programme demandé.");
  };

  const activeProgram =
    dashboardPrograms.find((program) => getProgramStateId(program) === activeProgramId) ?? null;
  const effectiveSelectedCourseId = getEffectiveSelectedCourseId(
    activeProgram?.courses ?? [],
    selectedCourseId
  );
  const selectedCourse = getSelectedCourse(activeProgram?.courses ?? [], effectiveSelectedCourseId);
  const selectedCourseChannels = selectedCourse
    ? normalizeCourseChannelsFromSources({
        channels: selectedCourse.channels,
        quizzes: selectedCourse.quizzes,
        forums: selectedCourse.forums,
      })
    : [];
  const selectedChannel =
    selectedCourseChannels.find((channel) => channel.id === selectedChannelId) ?? null;
  const activeProgramLabel = getProgramDisplayLabel(activeProgram);
  const selectedCourseLabel = selectedCourse
    ? getCourseDisplayLabel(selectedCourse)
    : 'Aucun cours';
  const mobileTopbarTitle = selectedChannel
    ? `${getPrefixForType(selectedChannel.type)} ${selectedChannel.name}`
    : 'Accueil';
  const mobileUserInitial = getUserInitial(loggedInUserMock);
  const isEmptyProgramsState = activeProgram === null;
  const isEmptyCourseState =
    activeProgram !== null && selectedCourse !== null && selectedCourseChannels.length === 0;

  // TODO : ouvrir le formulaire de création de canal texte.
  const handleCreateChannel = () => console.log('[Dashboard] Créer un canal demandé.');
  // TODO : ouvrir le formulaire de création de quiz.
  const handleCreateQuiz = () => console.log('[Dashboard] Créer un quiz demandé.');
  // TODO : ouvrir le formulaire de création de forum.
  const handleCreateForum = () => console.log('[Dashboard] Créer un forum demandé.');

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
              setSelectedChannelId(undefined);

              const nextProgram = dashboardPrograms.find((program) => getProgramStateId(program) === nextProgramId);

              setSelectedCourseId(getEffectiveSelectedCourseId(nextProgram?.courses ?? [], ''));
            }}
            onAddProgram={handleAddProgram}
          />
        }
        courseMenu={
          <CourseMenu
            activeProgram={activeProgram}
            courses={activeProgram?.courses ?? []}
            currentUser={loggedInUserMock}
            selectedCourseId={effectiveSelectedCourseId}
            onSelectCourse={(courseId) => {
              setSelectedCourseId(courseId);
              setSelectedChannelId(undefined);
            }}
            selectedChannelId={selectedChannelId}
            onSelectChannel={setSelectedChannelId}
            onOpenChannel={handleOpenChannel}
          />
        }
      />

      <section className={styles.mainPanel} aria-label="Contenu principal">
        {isEmptyProgramsState ? (
          <div className={styles.emptyMainState}>
            <div className={styles.emptyMainIcon} aria-hidden="true">
              <img src={gradCapIcon} alt="" className={styles.emptyMainIconImage} />
            </div>

            <h1 className={styles.emptyMainTitle}>Bienvenue sur MoodIT 👋</h1>
            <p className={styles.emptyMainSubtitle}>
              Tu n'as encore rejoint aucun programme.
              <br />
              Ajoute ou rejoins-en un pour accéder à tes canaux, forums et quiz.
            </p>

            <button type="button" className={styles.emptyMainAction} onClick={handleAddProgram}>
              + Ajouter un programme
            </button>
          </div>
        ) : isEmptyCourseState ? (
          <div className={styles.emptyMainState}>
            <div className={styles.emptyMainIcon} aria-hidden="true">
              <img src={messageSquareIcon} alt="" className={styles.emptyMainIconImage} />
            </div>

            <h1 className={styles.emptyMainTitle}>Ce cours est vide</h1>
            <p className={styles.emptyMainSubtitle}>
              Aucun canal, forum ou quiz pour l'instant.
              <br />
              Crée le premier canal pour lancer les échanges.
            </p>

            <div className={styles.emptyCourseActions}>
              <button type="button" className={styles.emptyMainAction} onClick={handleCreateChannel}>
                + Créer un canal
              </button>
              <button type="button" className={styles.emptyMainActionOutline} onClick={handleCreateQuiz}>
                + Créer un Quiz
              </button>
              <button type="button" className={styles.emptyMainActionOutline} onClick={handleCreateForum}>
                + Créer un Forum
              </button>
            </div>
          </div>
        ) : (
          <>
            <header className={styles.mainHeader}>
              <p className={styles.mainMeta}>Programme</p>
              <h1 className={styles.mainTitle}>{activeProgramLabel}</h1>
            </header>

            <div className={styles.mainBody}>
              <p className={styles.mainCourse}>Cours: {selectedCourseLabel}</p>
              {selectedChannel ? (
                <p className={styles.mainChannel}>
                  Canal actif: <span>{selectedChannel.name}</span>
                </p>
              ) : (
                <p className={styles.mainHint}>
                  Selectionne un canal dans le menu de gauche pour afficher son contenu ici.
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function getUserInitial(user: UserMenuUser): string {
  const display =
    user.displayName?.trim() || user.firstName?.trim() || user.username?.trim() || 'U';
  return display[0].toUpperCase();
}

function getProgramDisplayLabel(program: Program | null): string {
  if (!program) return 'Accueil';
  return (program.label ?? program.cohort ?? program.name ?? 'Accueil').trim() || 'Accueil';
}

function getCourseDisplayLabel(course: Course): string {
  if (course.name?.trim()) return course.name.trim();

  const title = course.title?.trim() ?? '';
  const code = course.code?.trim() ?? '';

  if (code && title) return `${code} · ${title}`;
  return title || code || 'Cours';
}

function getProgramStateId(program: Program | undefined): string {
  if (!program) return '';
  return String(program.id ?? program.id_program ?? '');
}

function getCourseStateId(course: Course | undefined): string {
  if (!course) return '';
  return String(course.id ?? course.id_course ?? '');
}

function getEffectiveSelectedCourseId(courses: Course[], selectedCourseId: string): string {
  if (courses.length === 0) return '';

  const selectedCourseStillExists = courses.some(
    (course) => getCourseStateId(course) === selectedCourseId
  );

  return selectedCourseStillExists ? selectedCourseId : getCourseStateId(courses[0]);
}

function getSelectedCourse(courses: Course[], selectedCourseId: string): Course | null {
  return (
    courses.find((course) => getCourseStateId(course) === selectedCourseId) ?? courses[0] ?? null
  );
}
