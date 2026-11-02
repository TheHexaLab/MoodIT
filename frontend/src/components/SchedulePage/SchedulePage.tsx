import React, { useEffect, useState } from 'react';
import styles from './SchedulePage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { courseTileColor } from '../PortalSidebar/courseTile.ts';
import type { ScheduleCourse, ScheduleSession } from '../../types/domain.ts';
import {
  FIRST_HOUR,
  LAST_HOUR,
  addDays,
  dayIndex,
  dayTitle,
  formatTime,
  isSameDay,
  longDay,
  minutesFromStart,
  placeSessions,
  shortDay,
  startOfWeek,
  weekDays,
  weekLabel,
} from './schedule.ts';

/** Hauteur d'une heure dans la grille, en rem. */
const HOUR_REM = 4.375;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);

interface SchedulePageProps {
  /** Cours de l'étudiant, tous programmes confondus. */
  courses: ScheduleCourse[];
  /** Séances de la semaine qui commence au lundi donné (dashboardApi : données fictives, #206). */
  onFetchSchedule: (weekStart: Date, courses: ScheduleCourse[]) => Promise<ScheduleSession[]>;
  /** Ouvre le cours d'une séance. */
  onOpenCourse: (programId: number, courseId: number) => void;
  /** Mobile : une liste par jour plutôt que la grille. */
  compact?: boolean;
  /** Date de référence (injectée par les tests). */
  now?: Date;
}

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sessions: ScheduleSession[] };

const Chevron = ({ direction }: { direction: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Page Horaire du portail : la semaine de cours de l'étudiant, du lundi au vendredi. */
export default function SchedulePage({
  courses,
  onFetchSchedule,
  onOpenCourse,
  compact = false,
  now = new Date(),
}: SchedulePageProps): React.ReactElement {
  const thisWeek = startOfWeek(now).getTime();
  /** Semaine affichée, en semaines depuis la semaine en cours. */
  const [offset, setOffset] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** Incrémenté par « Réessayer » : relance le chargement. */
  const [attempt, setAttempt] = useState(0);
  const monday = addDays(new Date(thisWeek), offset * 7);
  const mondayTime = monday.getTime();
  const courseKey = courses.map((course) => course.id).join(',');

  useEffect(() => {
    let cancelled = false;
    onFetchSchedule(new Date(mondayTime), courses)
      .then((sessions) => {
        if (!cancelled) setLoad({ status: 'ready', sessions });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `courses` est suivi par ses ids (courseKey) : un nouveau tableau aux mêmes cours ne recharge pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mondayTime, courseKey, onFetchSchedule, attempt]);

  function goTo(nextOffset: number) {
    setLoad({ status: 'loading' });
    setOffset(nextOffset);
  }

  const days = weekDays(monday);
  const byId = new Map(courses.map((course) => [course.id, course]));
  const sessions = load.status === 'ready' ? load.sessions : [];
  const sessionsOf = (index: number) => sessions.filter((s) => dayIndex(s.start) === index);

  function sessionButton(session: ScheduleSession, style?: React.CSSProperties) {
    const course = byId.get(session.courseId);
    if (!course) return null;
    const time = `${formatTime(session.start)} à ${formatTime(session.end)}`;
    return (
      <button
        key={session.id}
        type="button"
        className={styles.session}
        style={{ ...style, ['--course-color' as string]: courseTileColor(course.id) }}
        onClick={() => onOpenCourse(course.programId, course.id)}
      >
        <span className={styles.sessionCode}>{course.code}</span>
        <span className={styles.sessionDetail}>
          {session.kind} · {session.room}
        </span>
        <span className={styles.sessionDetail}>{time}</span>
        {/* Le nom accessible reprend le texte visible (WCAG 2.5.3), suivi du jour. */}
        <span className={styles.visuallyHidden}>, {longDay(new Date(session.start))}</span>
      </button>
    );
  }

  function renderBody(): React.ReactNode {
    if (load.status === 'loading') {
      return (
        <div className={styles.state} role="status" aria-busy="true">
          <Spinner size={24} />
          <p>Chargement de l'horaire…</p>
        </div>
      );
    }
    if (load.status === 'error') {
      return (
        <div className={styles.state} role="alert">
          <p>Impossible de charger l'horaire.</p>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setLoad({ status: 'loading' });
              setAttempt((previous) => previous + 1);
            }}
          >
            Réessayer
          </button>
        </div>
      );
    }
    if (courses.length === 0) {
      return <p className={styles.empty}>Rejoignez un cours pour voir votre horaire.</p>;
    }
    if (compact) {
      return (
        <div className={styles.dayList}>
          {sessions.length === 0 && <p className={styles.empty}>Aucun cours cette semaine.</p>}
          {days.map((day, index) => {
            const ofDay = sessionsOf(index).sort((a, b) => a.start.localeCompare(b.start));
            if (ofDay.length === 0) return null;
            return (
              <section
                key={day.getTime()}
                className={`${styles.daySection} ${isSameDay(day, now) ? styles.today : ''}`}
                aria-label={longDay(day)}
              >
                <h2 className={styles.dayTitle}>
                  {dayTitle(day)}
                  {isSameDay(day, now) && <span className={styles.todayTag}>Aujourd'hui</span>}
                </h2>
                <div className={styles.dayItems}>{ofDay.map((session) => sessionButton(session))}</div>
              </section>
            );
          })}
        </div>
      );
    }
    return (
      <div className={styles.gridWrap}>
        {sessions.length === 0 && (
          <p className={styles.emptyOverlay}>Aucun cours cette semaine.</p>
        )}
        <div className={styles.grid} role="group" aria-label={weekLabel(monday)}>
          <div className={styles.corner} aria-hidden="true" />
          {days.map((day, index) => (
            <div
              key={day.getTime()}
              className={`${styles.dayHead} ${isSameDay(day, now) ? styles.today : ''}`}
              aria-current={isSameDay(day, now) ? 'date' : undefined}
            >
              {shortDay(day, index)}
            </div>
          ))}
          <div className={styles.hours} aria-hidden="true">
            {HOURS.map((hour) => (
              <span key={hour} style={{ height: `${HOUR_REM}rem` }}>
                {hour} h
              </span>
            ))}
          </div>
          {days.map((day, index) => (
            <div
              key={day.getTime()}
              className={`${styles.dayColumn} ${isSameDay(day, now) ? styles.today : ''}`}
              style={{ height: `${HOURS.length * HOUR_REM}rem` }}
            >
              {placeSessions(sessionsOf(index)).map(({ session, lane, lanes }) =>
                sessionButton(session, {
                  top: `${(minutesFromStart(session.start) / 60) * HOUR_REM}rem`,
                  height: `${((minutesFromStart(session.end) - minutesFromStart(session.start)) / 60) * HOUR_REM}rem`,
                  left: `calc(${(lane / lanes) * 100}% + 0.25rem)`,
                  width: `calc(${100 / lanes}% - 0.5rem)`,
                })
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className={styles.page} aria-label="Contenu principal">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Horaire</h1>
          <p className={styles.subtitle}>{weekLabel(monday)}</p>
        </div>
        <div className={styles.nav}>
          <button
            type="button"
            className={styles.button}
            disabled={offset === 0}
            onClick={() => goTo(0)}
          >
            Aujourd'hui
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.iconButton}`}
            aria-label="Semaine précédente"
            onClick={() => goTo(offset - 1)}
          >
            <Chevron direction="left" />
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.iconButton}`}
            aria-label="Semaine suivante"
            onClick={() => goTo(offset + 1)}
          >
            <Chevron direction="right" />
          </button>
        </div>
      </header>
      {renderBody()}
    </section>
  );
}
