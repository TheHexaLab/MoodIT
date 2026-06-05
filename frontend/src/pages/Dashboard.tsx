import { useState } from 'react';
import ProgramMenu, { type Program } from '../components/ProgramMenu/ProgramMenu';
import CourseMenu, { type Course } from '../components/CourseMenu/CourseMenu';
import { type CourseChannel } from '../components/CourseChannelList/CourseChannelList';
import { dashboardProgramsMock } from '../mocks/dashboardData';

export default function Dashboard() {
  const [activeProgramId, setActiveProgramId] = useState<string>(
    getProgramStateId(dashboardProgramsMock[0])
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
    dashboardProgramsMock.find((program) => getProgramStateId(program) === activeProgramId) ?? null;
  const effectiveSelectedCourseId = getEffectiveSelectedCourseId(
    activeProgram?.courses ?? [],
    selectedCourseId
  );

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <ProgramMenu
        programs={dashboardProgramsMock}
        activeProgramId={activeProgramId}
        onSelectProgram={(nextProgramId) => {
          setActiveProgramId(nextProgramId);
          setSelectedChannelId(undefined);

          const nextProgram = dashboardProgramsMock.find(
            (program) => getProgramStateId(program) === nextProgramId
          );

          setSelectedCourseId(getEffectiveSelectedCourseId(nextProgram?.courses ?? [], ''));
        }}
        onAddProgram={handleAddProgram}
      />
      <CourseMenu
        activeProgram={activeProgram}
        courses={activeProgram?.courses ?? []}
        selectedCourseId={effectiveSelectedCourseId}
        onSelectCourse={(courseId) => {
          setSelectedCourseId(courseId);
          setSelectedChannelId(undefined);
        }}
        selectedChannelId={selectedChannelId}
        onSelectChannel={setSelectedChannelId}
        onOpenChannel={handleOpenChannel}
      />
    </div>
  );
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
