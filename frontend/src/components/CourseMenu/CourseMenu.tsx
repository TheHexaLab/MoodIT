import React from 'react';
import styles from './CourseMenu.module.css';
import messageSquareIcon from '../../assets/message-square-lines.svg';
import { type Program } from '../ProgramMenu/ProgramMenu';
import UserMenu, { type UserMenuUser } from '../UserMenu/UserMenu';
import CourseChannelList, {
  type ChannelTypeDefinition,
  type CourseChannel,
} from '../CourseChannelList/CourseChannelList';
import {
  type ForumChannelSource,
  normalizeCourseChannelsFromSources,
  type QuizChannelSource,
} from '../CourseChannelList/courseChannelSources';

export interface Course {
  /** Identifiant du cours (Course.id, SERIAL). */
  id: number;
  /** Nom deja formate pour l'UI. */
  name?: string;
  /** Titre provenant du backend. */
  title?: string;
  /** Code officiel du cours provenant du backend. */
  code?: string;
  /** Description du cours provenant du backend. */
  description?: string;
  /** Canaux deja normalises cote UI. */
  channels?: CourseChannel[];
  /** Quiz issus de la BD (table Quiz). */
  quizzes?: QuizChannelSource[];
  /** Forums issus de la BD (table Forum) : canaux ('Discussion') et forums ('Thread'). */
  forums?: ForumChannelSource[];
}

interface CourseMenuProps {
  /** Programme actuellement sélectionné ; null si aucun. */
  activeProgram?: Program | null;
  /** Cours disponibles pour le programme actif. */
  courses?: Course[];
  /** Cours actuellement sélectionné dans la liste déroulante. */
  selectedCourseId?: number;
  /** Callback lors d'un changement de cours. */
  onSelectCourse?: (courseId: number) => void;
  /** Definition des types de canaux affiches dans la liste. */
  channelTypeDefinitions?: ChannelTypeDefinition[];
  /** Canal actuellement sélectionné. */
  selectedChannelId?: number;
  /** Callback lors d'un changement de canal. */
  onSelectChannel?: (channelId: number) => void;
  /**
   * Callback d'ouverture d'un canal (vue a implementer).
   * Distinct de "onSelectChannel" pour permettre une navigation indépendante.
   */
  onOpenChannel?: (channel: CourseChannel) => void;
  /**
   * Utilisateur connecte affiche en bas du panneau.
   */
  currentUser?: UserMenuUser | null;
}

/**
 * Panneau lateral secondaire affichant les canaux du cours sélectionné.
 * Si le programme n'a aucun cours, un état vide est affiché.
 * Sinon, un sélecteur de cours puis les canaux groupes par type sont rendus.
 */
const CourseMenu: React.FC<CourseMenuProps> = ({
  activeProgram,
  courses = [],
  selectedCourseId,
  onSelectCourse,
  channelTypeDefinitions,
  selectedChannelId,
  onSelectChannel,
  onOpenChannel,
  currentUser,
}) => {
  const courseOptions = courses.map((course) => ({
    id: course.id,
    label: formatCourseLabel(course),
    channels: normalizeCourseChannelsFromSources({
      channels: course.channels,
      quizzes: course.quizzes,
      forums: course.forums,
    }),
  }));
  const selectedCourse =
    courseOptions.find((course) => course.id === selectedCourseId) ?? courseOptions[0] ?? null;
  const effectiveSelectedChannelId = getEffectiveSelectedChannelId(
    selectedCourse?.channels ?? [],
    selectedChannelId
  );
  const hasCourses = courseOptions.length > 0;
  const emptySubtitle = activeProgram
    ? 'Ce programme ne contient encore aucun cours a afficher.'
    : 'Rejoins un programme pour voir tes cours, canaux et forums.';

  return (
    <nav className={styles.sidebar} aria-label="Cours">
      {/* En-tete : titre simple ou sélecteur de cours */}
      <header className={styles.header}>
        {hasCourses ? (
          <div className={styles.selectWrapper}>
            <label htmlFor="course-menu-select" className={styles.visuallyHidden}>
              Cours selectionne
            </label>
            <select
              id="course-menu-select"
              className={styles.courseSelect}
              value={selectedCourse?.id ?? ''}
              onChange={(event) => onSelectCourse?.(Number(event.target.value))}
            >
              {courseOptions.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.label}
                </option>
              ))}
            </select>
            <svg
              className={styles.selectChevron}
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M4.5 6.5 8 10l3.5-3.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <span className={styles.headerTitle}>{activeProgram?.label ?? 'Accueil'}</span>
        )}
      </header>

      {/* Zone principale : état vide ou canaux du cours sélectionné */}
      <main className={styles.main}>
        {!hasCourses ? (
          <div className={styles.emptyState}>
            {/* Icone decorative */}
            <div className={styles.emptyIcon} aria-hidden="true">
              <img src={messageSquareIcon} alt="" className={styles.emptyIconImage} />
            </div>

            <p className={styles.emptyTitle}>Aucun cours</p>
            <p className={styles.emptySubtitle}>{emptySubtitle}</p>
          </div>
        ) : (
          <CourseChannelList
            channels={selectedCourse?.channels ?? []}
            typeDefinitions={channelTypeDefinitions}
            selectedChannelId={effectiveSelectedChannelId}
            onSelectChannel={onSelectChannel}
            onOpenChannel={onOpenChannel}
          />
        )}
      </main>

      {/* Panneau utilisateur */}
      <footer className={styles.userPanel}>
        <UserMenu user={currentUser} />
      </footer>
    </nav>
  );
};

/**
 * Retourne le libellé visible dans le sélecteur.
 * Priorité: nom UI > "CODE · Titre" backend > titre backend.
 */
function formatCourseLabel(course: Course): string {
  if (course.name?.trim()) return course.name.trim();

  const title = course.title?.trim() ?? '';
  const code = course.code?.trim() ?? '';

  if (code && title) return `${code} · ${title}`;
  return title || code || 'Cours';
}

function getEffectiveSelectedChannelId(
  channels: CourseChannel[],
  selectedChannelId: number | undefined
): number | undefined {
  if (selectedChannelId === undefined) return undefined;
  return channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : undefined;
}

export default CourseMenu;
