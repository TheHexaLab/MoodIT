import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import styles from './PortalSidebar.module.css';
import type { Course, Program } from '../../types/domain.ts';

/** Teintes des tuiles de cours : toutes à 4,5:1 mini sous du texte blanc. */
const TILE_COLORS = ['#0f766e', '#1f4799', '#454559', '#115e59', '#0a5cc0'];

/** Pages du portail à venir : présentes pour la maquette, sans action pour l'instant. */
const UPCOMING_PAGES = [
  { label: 'Horaire', path: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4' },
  { label: 'Factures', path: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
  {
    label: "Centre d'aide",
    path: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01',
  },
];

interface PortalSidebarProps {
  programs: Program[];
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  /** Charge les cours de l'utilisateur dans un programme. */
  loadCourses: (programId: number) => Promise<Course[]>;
  onOpenProgram: (programId: number) => void;
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
  loadCourses,
  onOpenProgram,
  onOpenCourse,
  onJoin,
  userMenu,
}: PortalSidebarProps): React.ReactElement {
  const [coursesByProgram, setCoursesByProgram] = useState<Record<number, Course[] | 'error'>>({});

  // Dépend des identifiants, pas du tableau : la liste change de référence à chaque mise à jour
  // d'un programme (rôle, nom) sans que ses cours changent.
  const programIds = programs.map((program) => program.id).join(',');
  useEffect(() => {
    if (!programIds) return;
    let cancelled = false;
    for (const id of programIds.split(',').map(Number)) {
      loadCourses(id)
        .then((courses) => {
          if (!cancelled) setCoursesByProgram((previous) => ({ ...previous, [id]: courses }));
        })
        .catch(() => {
          if (!cancelled) setCoursesByProgram((previous) => ({ ...previous, [id]: 'error' }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [programIds, loadCourses]);

  const seenCourseIds = new Set<number>();

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
        {loading && (
          <p className={styles.status} role="status">
            Chargement de vos cours…
          </p>
        )}
        {loadError && (
          <div className={styles.status} role="alert">
            Impossible de charger vos cours.{' '}
            <button type="button" className={styles.retry} onClick={onReload}>
              Réessayer
            </button>
          </div>
        )}
        {!loading &&
          !loadError &&
          programs.map((program) => {
            const courses = coursesByProgram[program.id];
            const visibleCourses = Array.isArray(courses)
              ? courses.filter((course) => {
                  if (seenCourseIds.has(course.id)) return false;
                  seenCourseIds.add(course.id);
                  return true;
                })
              : [];
            return (
              <section key={program.id} className={styles.program}>
                <button
                  type="button"
                  className={styles.programButton}
                  onClick={() => onOpenProgram(program.id)}
                >
                  {program.name}
                </button>
                {courses === 'error' && (
                  <p className={styles.status}>Cours indisponibles pour l'instant.</p>
                )}
                {visibleCourses.map((course) => (
                  <button
                    key={course.id}
                    type="button"
                    className={styles.course}
                    onClick={() => onOpenCourse(program.id, course.id)}
                  >
                    <span
                      className={styles.tile}
                      style={{ background: TILE_COLORS[course.id % TILE_COLORS.length] }}
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
              </section>
            );
          })}
        <button type="button" className={`${styles.navItem} ${styles.join}`} onClick={onJoin}>
          <NavIcon path="M12 5v14M5 12h14" />
          Rejoindre un cours
        </button>
      </div>

      <div className={styles.footer}>{userMenu}</div>
    </div>
  );
}
