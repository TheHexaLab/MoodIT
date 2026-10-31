import React from 'react';
import { Link } from 'react-router-dom';
import styles from './CourseRail.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { courseTileColor } from './courseTile.ts';
import type { Course } from '../../types/domain.ts';

export interface RailCourse {
  course: Course;
  /** Programme par lequel ouvrir le cours. */
  programId: number;
}

interface CourseRailProps {
  courses: RailCourse[];
  selectedCourseId?: number;
  onSelectCourse: (programId: number, courseId: number) => void;
  loading?: boolean;
  loadError?: string | null;
  onReload?: () => void;
}

/** Rail de gauche d'un cours ouvert : retour à l'Accueil, puis les cours de l'utilisateur. */
export default function CourseRail({
  courses,
  selectedCourseId,
  onSelectCourse,
  loading = false,
  loadError = null,
  onReload,
}: CourseRailProps): React.ReactElement {
  return (
    <nav className={styles.rail} aria-label="Mes cours">
      <Link to="/home" className={styles.back} aria-label="Retour à l'Accueil" title="Retour à l'Accueil">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M19 12H5M11 6l-6 6 6 6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>

      <span className={styles.divider} />

      {loadError ? (
        <button
          type="button"
          className={styles.retry}
          onClick={onReload}
          title={loadError}
          aria-label="Réessayer le chargement des cours"
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M12.5 6.5A5 5 0 1 0 13 9M12.5 3v3.5H9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : loading ? (
        <span className={styles.spinner} role="status" aria-label="Chargement des cours" aria-busy="true">
          <Spinner size={24} />
        </span>
      ) : (
        <ul className={styles.list} role="list">
          {courses.map(({ course, programId }) => {
            const isActive = course.id === selectedCourseId;
            const code = course.code?.trim() || course.title?.trim() || 'Cours';
            return (
              <li
                key={course.id}
                className={`${styles.item} ${isActive ? styles.itemActive : ''}`}
              >
                <button
                  type="button"
                  className={`${styles.course} ${isActive ? styles.courseActive : ''}`}
                  style={{ background: courseTileColor(course.id) }}
                  title={course.title ?? code}
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => onSelectCourse(programId, course.id)}
                >
                  <span className={styles.code}>{code}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
