import React from 'react';
import { Link } from 'react-router-dom';
import styles from './PortalSidebar.module.css';
import ProgramMenu from '../ProgramMenu/ProgramMenu.tsx';
import { courseTileColor } from '../CourseRail/courseTile.ts';
import type { Course, Program } from '../../types/domain.ts';

/** Pages du portail à venir : présentes pour la maquette, sans action pour l'instant. */
const UPCOMING_PAGES = [
  { label: 'Horaire', path: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { label: 'Factures', path: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  {
    label: "Centre d'aide",
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  },
];

type ProgramActions = Pick<
  React.ComponentProps<typeof ProgramMenu>,
  | 'onAddCourseToProgram'
  | 'onEditProgram'
  | 'onManageRoles'
  | 'onDeleteProgram'
  | 'onJoinCourses'
  | 'onLeaveProgram'
>;

interface PortalSidebarProps {
  programs: Program[];
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  /** Programmes dont les cours n'ont pas pu être chargés. */
  failedProgramIds?: number[];
  /** L'utilisateur est-il administrateur global ? (actions du menu contextuel des programmes) */
  isGlobalAdmin?: boolean;
  /** Actions du menu contextuel (clic droit) d'un programme. */
  programActions?: ProgramActions;
  onOpenCourse: (programId: number, courseId: number) => void;
  onJoin: () => void;
  /** Menu du compte, au pied de la barre. */
  userMenu: React.ReactNode;
}

function NavIcon({ path }: { path: string }): React.ReactElement {
  return (
    <svg className={styles.navIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={path}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Tuile d'un cours : les lettres de son sigle (ex. « MAT » pour MAT265). */
function tileLabel(course: Course): string {
  const letters = (course.code ?? course.title ?? '').replace(/[^\p{L}]/gu, '');
  return letters.slice(0, 3).toUpperCase();
}

/**
 * Barre de gauche du portail : pages du portail, puis les cours de l'utilisateur, tous programmes
 * confondus. Un cours inscrit dans deux programmes n'apparaît que sous le premier.
 */
export default function PortalSidebar({
  programs,
  loading,
  loadError,
  onReload,
  failedProgramIds = [],
  isGlobalAdmin = false,
  programActions,
  onOpenCourse,
  onJoin,
  userMenu,
}: PortalSidebarProps): React.ReactElement {
  // Calculé ici, pas pendant le rendu de ProgramMenu : un rendu doit rester pur (StrictMode rend
  // deux fois, et un second passage verrait tous les cours comme déjà affichés).
  const seenCourseIds = new Set<number>();
  const coursesByProgram = new Map(
    programs.map((program) => [
      program.id,
      (program.courses ?? []).filter((course) => {
        if (seenCourseIds.has(course.id)) return false;
        seenCourseIds.add(course.id);
        return true;
      }),
    ])
  );

  return (
    <div className={styles.sidebar}>
      <nav className={styles.pages} aria-label="Portail">
        <Link to="/home" className={`${styles.navItem} ${styles.navItemActive}`} aria-current="page">
          <NavIcon path="M3 11l9-8 9 8M5 9.5V21h14V9.5M10 21v-6h4v6" />
          Accueil
        </Link>
        {UPCOMING_PAGES.map(({ label, path }) => (
          <button
            key={label}
            type="button"
            className={styles.navItem}
            aria-disabled="true"
            title="Bientôt disponible"
          >
            <NavIcon path={path} />
            {label}
          </button>
        ))}
      </nav>

      <h2 className={styles.heading}>Mes cours</h2>
      <div className={styles.courses}>
        <ProgramMenu
          programs={programs}
          loading={loading}
          loadError={loadError}
          onReload={onReload}
          isGlobalAdmin={isGlobalAdmin}
          {...programActions}
          renderCourses={(program) => (
            <>
              {failedProgramIds.includes(program.id) && (
                <p className={styles.status}>Cours indisponibles pour l'instant.</p>
              )}
              {(coursesByProgram.get(program.id) ?? [])
                .map((course) => (
                  <button
                    key={course.id}
                    type="button"
                    className={styles.course}
                    onClick={() => onOpenCourse(program.id, course.id)}
                  >
                    <span
                      className={styles.tile}
                      style={{ background: courseTileColor(course.id) }}
                      aria-hidden="true"
                    >
                      {tileLabel(course)}
                    </span>
                    <span className={styles.courseText}>
                      <span className={styles.courseTitle}>{course.title}</span>
                      {course.code && <span className={styles.courseCode}>{course.code}</span>}
                    </span>
                  </button>
                ))}
            </>
          )}
        />
        <button type="button" className={`${styles.navItem} ${styles.join}`} onClick={onJoin}>
          <NavIcon path="M12 5v14M5 12h14" />
          Rejoindre un cours
        </button>
      </div>

      <div className={styles.footer}>{userMenu}</div>
    </div>
  );
}
