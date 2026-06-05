import React from 'react';
import styles from './CourseMenu.module.css';
import { type Program } from '../ProgramMenu/ProgramMenu';
import CourseChannelList, {
  type ChannelTypeDefinition,
  type CourseChannel,
} from '../CourseChannelList/CourseChannelList';
import {
  type ForumChannelSource,
  normalizeCourseChannelsFromSources,
  type QuizChannelSource,
  type TextChannelSource,
} from '../CourseChannelList/courseChannelSources';

export interface Course {
  /** Identifiant UI optionnel. */
  id?: string;
  /** Identifiant backend du cours. */
  id_course?: string | number;
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
  /** Quiz issus de la BD. */
  quizzes?: QuizChannelSource[];
  /** Forums issus de la BD. */
  forums?: ForumChannelSource[];
  /** Canaux texte futurs / normalisés. */
  textChannels?: TextChannelSource[];
}

interface CourseMenuProps {
  /** Programme actuellement sélectionné ; null si aucun. */
  activeProgram?: Program | null;
  /** Cours disponibles pour le programme actif. */
  courses?: Course[];
  /** Cours actuellement sélectionné dans la liste déroulante. */
  selectedCourseId?: string;
  /** Callback lors d'un changement de cours. */
  onSelectCourse?: (courseId: string) => void;
  /** Definition des types de canaux affiches dans la liste. */
  channelTypeDefinitions?: ChannelTypeDefinition[];
  /** Canal actuellement sélectionné. */
  selectedChannelId?: string;
  /** Callback lors d'un changement de canal. */
  onSelectChannel?: (channelId: string) => void;
  /**
   * Callback d'ouverture d'un canal (vue a implementer).
   * Distinct de "onSelectChannel" pour permettre une navigation indépendante.
   */
  onOpenChannel?: (channel: CourseChannel) => void;
  /**
   * Nœud React injecte dans le panneau utilisateur en bas.
   * Sera remplacé par le vrai composant UserPanel ultérieurement.
   */
  userSlot?: React.ReactNode;
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
  userSlot,
}) => {
  const courseOptions = courses.map((course) => ({
    id: String(course.id ?? course.id_course ?? ''),
    label: formatCourseLabel(course),
    channels: normalizeCourseChannelsFromSources({
      channels: course.channels,
      quizzes: course.quizzes,
      textChannels: course.textChannels,
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
              onChange={(event) => onSelectCourse?.(event.target.value)}
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
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 9H17M7 13H12M21 20L17.6757 18.3378C17.4237 18.2118 17.2977 18.1488 17.1656 18.1044C17.0484 18.065 16.9277 18.0365 16.8052 18.0193C16.6672 18 16.5263 18 16.2446 18H6.2C5.07989 18 4.51984 18 4.09202 17.782C3.71569 17.5903 3.40973 17.2843 3.21799 16.908C3 16.4802 3 15.9201 3 14.8V7.2C3 6.07989 3 5.51984 3.21799 5.09202C3.40973 4.71569 3.71569 4.40973 4.09202 4.21799C4.51984 4 5.0799 4 6.2 4H17.8C18.9201 4 19.4802 4 19.908 4.21799C20.2843 4.40973 20.5903 4.71569 20.782 5.09202C21 5.51984 21 6.0799 21 7.2V20Z"
                  stroke="var(--brand-teal, #0d9488)"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
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

      {/* Panneau utilisateur (placeholder — composant à venir) */}
      <footer className={styles.userPanel}>{userSlot ?? <DefaultUserPlaceholder />}</footer>
    </nav>
  );
};

/**
 * Placeholder de compte utilisateur affiche tant que le vrai composant
 * UserPanel n'est pas injecté via la prop `userSlot`.
 */
function DefaultUserPlaceholder() {
  return (
    <div className={styles.userPlaceholder} aria-label="Compte utilisateur">
      <div className={styles.userAvatar}>J</div>
      <div className={styles.userInfo}>
        <span className={styles.userName}>Jean D.</span>
        <span className={styles.userHandle}>@jeandubois</span>
      </div>
    </div>
  );
}

/**
 * Retourne le libelle visible dans le sélecteur.
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
  selectedChannelId: string | undefined
): string | undefined {
  if (!selectedChannelId) return undefined;
  return channels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : undefined;
}

export default CourseMenu;
