import React, { useEffect, useId, useRef, useState } from 'react';
import styles from './SchedulePage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { Popup } from '../Popup/Popup.tsx';
import { PopupVariant } from '../Popup/popupVariant.ts';
import { usePopupController } from '../Popup/popupController.ts';
import ScheduleForm from './ScheduleForm.tsx';
import { Header, SessionPopup, TaskPopup } from './SchedulePopups.tsx';
import type {
  ScheduleColor,
  ScheduleCourse,
  ScheduleSession,
  ScheduleSessionInput,
  ScheduleTask,
  ScheduleTaskInput,
} from '../../types/domain.ts';
import {
  COLORS,
  FIRST_HOUR,
  LAST_HOUR,
  type Draft,
  addDays,
  courseColor,
  dayIndex,
  dayTitle,
  draftError,
  draftToSession,
  draftToTask,
  emptyDraft,
  formatTime,
  isSameDay,
  longDay,
  minutesFromStart,
  placeItems,
  shortDay,
  startOfWeek,
  toIso,
  weekDays,
  weekLabel,
} from './schedule.ts';

/** Hauteur d'une heure dans la grille, en rem. */
const HOUR_REM = 4.375;
/** Décalage d'un cran de cascade, en rem. */
const STEP_REM = 1.25;
/** Hauteur visible sous laquelle un événement recouvert ne montre plus que son titre. */
const DETAIL_MIN_REM = 3.25;
const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i);

/** Accès aux données de l'agenda (dashboardApi : données fictives, #206). */
export interface ScheduleApi {
  /** Séances de la semaine qui commence au lundi donné. */
  fetchSessions: (weekStart: Date, courses: ScheduleCourse[]) => Promise<ScheduleSession[]>;
  fetchTasks: (weekStart: Date) => Promise<ScheduleTask[]>;
  createTask: (input: ScheduleTaskInput) => Promise<ScheduleTask>;
  updateTask: (id: number, input: ScheduleTaskInput) => Promise<ScheduleTask>;
  deleteTask: (id: number) => Promise<void>;
  /** Toutes les occurrences de la séance ajoutée. */
  createSessions: (input: ScheduleSessionInput) => Promise<ScheduleSession[]>;
}

interface SchedulePageProps {
  /** Cours de l'utilisateur, tous programmes confondus. */
  courses: ScheduleCourse[];
  api: ScheduleApi;
  /** Ouvre le cours d'une séance. */
  onOpenCourse: (programId: number, courseId: number) => void;
  /** Mobile : une liste par jour plutôt que la grille, et l'ajout dans une fenêtre. */
  compact?: boolean;
  /** Date de référence (injectée par les tests). */
  now?: Date;
}

type Load =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sessions: ScheduleSession[]; tasks: ScheduleTask[] };

/** Ce que montre la grille : une séance, une tâche, ou l'aperçu de l'ajout en cours. */
type GridItem = { start: string; end: string } & (
  | { kind: 'session'; session: ScheduleSession; course: ScheduleCourse }
  | { kind: 'task'; task: ScheduleTask }
  | { kind: 'preview'; draft: Draft }
);

const Chevron = ({ direction }: { direction: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d={direction === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Pencil = () => (
  <svg className={styles.editIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const hueStyle = (color: ScheduleColor) => ({
  ['--hue' as string]: COLORS[color].hue,
  ['--sat' as string]: `${COLORS[color].saturation}%`,
});

/**
 * Page Horaire du portail, qui est aussi l'agenda : les séances des cours (fixées par leur
 * personnel) et les tâches personnelles de l'utilisateur, du lundi au vendredi. L'enseignant ou le
 * responsable d'un cours y ajoute aussi des séances.
 */
export default function SchedulePage({
  courses,
  api,
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
  /** Ajout en cours (panneau ouvert), avec son brouillon. */
  const [adding, setAdding] = useState<Draft | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [openSession, setOpenSession] = useState<ScheduleSession | null>(null);
  const [openTask, setOpenTask] = useState<ScheduleTask | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelId = useId();
  const monday = addDays(new Date(thisWeek), offset * 7);
  const mondayTime = monday.getTime();
  const courseKey = courses.map((course) => course.id).join(',');
  const managesCourse = courses.some((course) => course.canManage);
  const addLabel = managesCourse ? "Ajouter à l'horaire" : 'Ajouter une tâche';
  const panelOpen = adding != null && !compact;

  useEffect(() => {
    let cancelled = false;
    const weekStart = new Date(mondayTime);
    Promise.all([api.fetchSessions(weekStart, courses), api.fetchTasks(weekStart)])
      .then(([sessions, tasks]) => {
        if (!cancelled) setLoad({ status: 'ready', sessions, tasks });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `courses` est suivi par ses ids (courseKey) : un nouveau tableau aux mêmes cours ne recharge pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mondayTime, courseKey, api, attempt]);

  // Le panneau d'ajout prend le focus à l'ouverture.
  useEffect(() => {
    if (panelOpen) panelRef.current?.querySelector<HTMLElement>('input, select')?.focus();
  }, [panelOpen]);

  function goTo(nextOffset: number) {
    setLoad({ status: 'loading' });
    setOffset(nextOffset);
  }

  const days = weekDays(monday);
  const byId = new Map(courses.map((course) => [course.id, course]));
  const sessions = load.status === 'ready' ? load.sessions : [];
  const tasks = load.status === 'ready' ? load.tasks : [];
  const inShownWeek = (iso: string) => dayIndex(iso) !== -1 && startOfWeek(new Date(iso)).getTime() === mondayTime;

  function openAdd() {
    if (adding) {
      closeAdd();
      return;
    }
    const today = days.find((day) => isSameDay(day, now));
    setAdding(emptyDraft('task', today ?? monday, now.getHours() + 1, null));
    setAddError(null);
  }

  function closeAdd() {
    setAdding(null);
    if (!compact) addButtonRef.current?.focus();
  }

  async function submitAdd() {
    if (!adding) return;
    const problem = draftError(adding);
    if (problem) {
      setAddError(problem);
      return;
    }
    setAddBusy(true);
    try {
      if (adding.kind === 'task') {
        const task = await api.createTask(draftToTask(adding));
        setLoad((previous) =>
          previous.status === 'ready' && inShownWeek(task.start) ? { ...previous, tasks: [...previous.tasks, task] } : previous
        );
      } else {
        const created = (await api.createSessions(draftToSession(adding))).filter((s) => inShownWeek(s.start));
        setLoad((previous) =>
          previous.status === 'ready' ? { ...previous, sessions: [...previous.sessions, ...created] } : previous
        );
      }
      closeAdd();
    } catch {
      setAddError("L'ajout a échoué. Réessayez.");
    } finally {
      setAddBusy(false);
    }
  }

  async function saveTask(id: number, input: ScheduleTaskInput) {
    const task = await api.updateTask(id, input);
    setLoad((previous) =>
      previous.status === 'ready'
        ? {
            ...previous,
            tasks: previous.tasks.filter((known) => known.id !== id).concat(inShownWeek(task.start) ? [task] : []),
          }
        : previous
    );
  }

  async function removeTask(id: number) {
    await api.deleteTask(id);
    setLoad((previous) =>
      previous.status === 'ready' ? { ...previous, tasks: previous.tasks.filter((known) => known.id !== id) } : previous
    );
  }

  /** Séances, tâches et aperçu de l'ajout, pour le jour `index` (0 = lundi). */
  function itemsOf(index: number): GridItem[] {
    const items: GridItem[] = [];
    for (const session of sessions) {
      const course = byId.get(session.courseId);
      if (course && dayIndex(session.start) === index) items.push({ kind: 'session', session, course, start: session.start, end: session.end });
    }
    for (const task of tasks) {
      if (dayIndex(task.start) === index) items.push({ kind: 'task', task, start: task.start, end: task.end });
    }
    if (adding && adding.date && adding.end > adding.start) {
      const start = toIso(adding.date, adding.start);
      if (inShownWeek(start) && dayIndex(start) === index) {
        items.push({ kind: 'preview', draft: adding, start, end: toIso(adding.date, adding.end) });
      }
    }
    return items;
  }

  /** `layout` : position dans la grille ; `titleOnly` quand un autre événement le recouvre tôt. */
  function renderItem(item: GridItem, layout?: { style: React.CSSProperties; stacked: boolean; titleOnly: boolean }): React.ReactNode {
    const style = layout?.style;
    const extra = `${layout?.stacked ? styles.stacked : ''} ${layout?.titleOnly ? styles.titleOnly : ''}`;
    const time = `${formatTime(item.start)} à ${formatTime(item.end)}`;
    const day = <span className={styles.visuallyHidden}>, {longDay(new Date(item.start))}</span>;
    if (item.kind === 'session') {
      const { session, course } = item;
      return (
        <button
          key={`s${session.id}`}
          type="button"
          className={`${styles.block} ${styles.session} ${extra}`}
          style={{ ...style, ...hueStyle(courseColor(course.id)) }}
          onClick={() => setOpenSession(session)}
        >
          <span className={styles.blockTitle}>{course.code}</span>
          <span className={styles.blockDetail}>
            {session.kind} · {session.room}
          </span>
          <span className={styles.blockDetail}>{time}</span>
          {/* Le nom accessible reprend le texte visible (WCAG 2.5.3), suivi du jour. */}
          {day}
        </button>
      );
    }
    if (item.kind === 'task') {
      const { task } = item;
      const linked = task.courseId != null ? byId.get(task.courseId)?.code : undefined;
      return (
        <button
          key={`t${task.id}`}
          type="button"
          className={`${styles.block} ${styles.task} ${extra}`}
          style={{ ...style, ...hueStyle(task.color) }}
          onClick={() => setOpenTask(task)}
        >
          <span className={styles.blockTitle}>{task.title}</span>
          <span className={styles.blockDetail}>{linked ?? 'Tâche personnelle'}</span>
          <span className={styles.blockDetail}>{time}</span>
          {day}
          <Pencil />
        </button>
      );
    }
    const { draft } = item;
    const isTask = draft.kind === 'task';
    const course = draft.courseId != null ? byId.get(draft.courseId) : undefined;
    return (
      <div
        key="preview"
        className={`${styles.block} ${isTask ? styles.task : styles.session} ${styles.preview}`}
        style={{ ...style, ...hueStyle(isTask ? draft.color : courseColor(draft.courseId ?? 0)) }}
        aria-hidden="true"
      >
        <span className={styles.blockTitle}>{isTask ? draft.title.trim() || 'Nouvelle tâche' : course?.code}</span>
        <span className={styles.blockDetail}>{isTask ? 'Nouvelle tâche' : 'Nouvelle séance'}</span>
        <span className={styles.blockDetail}>{time}</span>
      </div>
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
    const empty =
      sessions.length + tasks.length > 0
        ? null
        : courses.length === 0
          ? 'Rejoignez un cours pour voir votre horaire.'
          : "Rien à l'horaire cette semaine.";
    if (compact) {
      return (
        <div className={styles.dayList}>
          {empty && <p className={styles.empty}>{empty}</p>}
          {days.map((day, index) => {
            const ofDay = itemsOf(index)
              .filter((item) => item.kind !== 'preview')
              .sort((a, b) => a.start.localeCompare(b.start));
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
                <div className={styles.dayItems}>{ofDay.map((item) => renderItem(item))}</div>
              </section>
            );
          })}
        </div>
      );
    }
    return (
      <div className={styles.gridWrap}>
        {empty && <p className={styles.emptyOverlay}>{empty}</p>}
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
              {placeItems(itemsOf(index)).map(({ item, depth, visible }) =>
                renderItem(item, {
                  style: {
                    top: `${(minutesFromStart(item.start) / 60) * HOUR_REM}rem`,
                    height: `${((minutesFromStart(item.end) - minutesFromStart(item.start)) / 60) * HOUR_REM}rem`,
                    left: `calc(${depth * STEP_REM}rem + 0.25rem)`,
                    width: `calc(100% - ${depth * STEP_REM}rem - 0.5rem)`,
                    zIndex: depth + 1,
                  },
                  stacked: depth > 0,
                  titleOnly: (visible / 60) * HOUR_REM < DETAIL_MIN_REM,
                })
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const form = adding && (
    <ScheduleForm
      draft={adding}
      onChange={setAdding}
      courses={courses}
      allowSessions
      error={addError}
      busy={addBusy}
      submitLabel={adding.kind === 'task' ? 'Ajouter la tâche' : 'Ajouter la séance'}
      onSubmit={() => void submitAdd()}
      onCancel={closeAdd}
    />
  );
  const sessionCourse = openSession ? byId.get(openSession.courseId) : undefined;

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
          <button type="button" className={styles.button} disabled={offset === 0} onClick={() => goTo(0)}>
            Aujourd'hui
          </button>
          <button
            ref={addButtonRef}
            type="button"
            className={`${styles.button} ${styles.primary}`}
            aria-expanded={compact ? undefined : panelOpen}
            aria-controls={panelOpen ? panelId : undefined}
            onClick={openAdd}
          >
            {addLabel}
          </button>
        </div>
      </header>
      <div className={styles.body}>
        <div className={styles.main}>{renderBody()}</div>
        {panelOpen && (
          <aside id={panelId} ref={panelRef} className={styles.panel} aria-label={addLabel}>
            <h2 className={styles.panelTitle}>{managesCourse ? "Ajouter à l'horaire" : 'Nouvelle tâche'}</h2>
            {form}
          </aside>
        )}
      </div>
      {compact && adding && <AddPopup label={addLabel} onClose={closeAdd}>{form}</AddPopup>}
      {openSession && sessionCourse && (
        <SessionPopup
          session={openSession}
          course={sessionCourse}
          onClose={() => setOpenSession(null)}
          onOpenCourse={() => {
            setOpenSession(null);
            onOpenCourse(sessionCourse.programId, sessionCourse.id);
          }}
        />
      )}
      {openTask && (
        <TaskPopup
          task={openTask}
          courses={courses}
          onClose={() => setOpenTask(null)}
          onSave={(input) => saveTask(openTask.id, input)}
          onDelete={() => removeTask(openTask.id)}
        />
      )}
    </section>
  );
}

/** Mobile : l'ajout dans une fenêtre plutôt qu'un panneau. */
function AddPopup({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const controller = usePopupController();
  return (
    <Popup variant={PopupVariant.Form} label={label} onClose={onClose} controller={controller}>
      <div className={styles.dialog}>
        <Header title={label} onClose={() => controller.requestClose()} />
        {children}
      </div>
    </Popup>
  );
}
