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
  OPENING_HOUR,
  type Draft,
  type DragMode,
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
  shiftTimes,
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
/** Déplacement du pointeur, en px, au-delà duquel un clic devient un glisser. */
const DRAG_THRESHOLD = 4;
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
  <svg
    className={styles.editIcon}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <path
      d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
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
  /** Tâche glissée : ses heures provisoires, affichées pendant le geste. */
  const [drag, setDrag] = useState<{ taskId: number; start: string; end: string } | null>(null);
  /** Colonnes des jours, pour savoir sur quel jour le pointeur dépose la tâche. */
  const columnsRef = useRef<(HTMLDivElement | null)[]>([]);
  /** Zone qui défile : la grille fait 24 h. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Le clic qui suit un glisser n'ouvre pas la tâche. */
  const suppressClick = useRef(false);
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

  // À chaque semaine chargée, la grille s'ouvre sur 8 h, ou sur le premier événement s'il est plus tôt.
  const firstHour =
    load.status === 'ready'
      ? Math.min(
          OPENING_HOUR,
          ...[...load.sessions, ...load.tasks].map((event) => new Date(event.start).getHours())
        )
      : OPENING_HOUR;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    scroller.scrollTop = (firstHour - FIRST_HOUR) * HOUR_REM * rem;
  }, [load.status, mondayTime, firstHour]);

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
  const inShownWeek = (iso: string) =>
    dayIndex(iso) !== -1 && startOfWeek(new Date(iso)).getTime() === mondayTime;

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
          previous.status === 'ready' && inShownWeek(task.start)
            ? { ...previous, tasks: [...previous.tasks, task] }
            : previous
        );
      } else {
        const created = (await api.createSessions(draftToSession(adding))).filter((s) =>
          inShownWeek(s.start)
        );
        setLoad((previous) =>
          previous.status === 'ready'
            ? { ...previous, sessions: [...previous.sessions, ...created] }
            : previous
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
            tasks: previous.tasks
              .filter((known) => known.id !== id)
              .concat(inShownWeek(task.start) ? [task] : []),
          }
        : previous
    );
  }

  /** Remplace une tâche tout de suite, puis l'enregistre ; la remet comme avant si l'enregistrement échoue. */
  async function patchTask(task: ScheduleTask, changes: Partial<ScheduleTaskInput>) {
    const next = { ...task, ...changes };
    const put = (value: ScheduleTask) =>
      setLoad((previous) =>
        previous.status === 'ready'
          ? {
              ...previous,
              tasks: previous.tasks.map((known) => (known.id === task.id ? value : known)),
            }
          : previous
      );
    put(next);
    try {
      const { id, ...input } = next;
      await api.updateTask(id, input);
    } catch {
      put(task);
    }
  }

  /** Glisser une tâche dans la grille : la déplacer (heure, jour) ou l'allonger par sa poignée du bas. */
  function startDrag(event: React.PointerEvent, task: ScheduleTask, mode: DragMode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const origin = { x: event.clientX, y: event.clientY, day: dayIndex(task.start) };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const pxPerMinute = (HOUR_REM * rem) / 60;
    let current: { start: string; end: string } | null = null;
    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - origin.x;
      const dy = move.clientY - origin.y;
      if (!current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      const column = columnsRef.current.findIndex((el) => {
        const rect = el?.getBoundingClientRect();
        return rect != null && move.clientX >= rect.left && move.clientX < rect.right;
      });
      const delta = Math.round(dy / pxPerMinute / 15) * 15;
      current = shiftTimes(task, mode, delta, column === -1 ? 0 : column - origin.day);
      setDrag({ taskId: task.id, ...current });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDrag(null);
      if (!current) return;
      suppressClick.current = true;
      // Le clic, s'il vient, suit le pointerup dans la même tâche du navigateur.
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (current.start !== task.start || current.end !== task.end) void patchTask(task, current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  async function removeTask(id: number) {
    await api.deleteTask(id);
    setLoad((previous) =>
      previous.status === 'ready'
        ? { ...previous, tasks: previous.tasks.filter((known) => known.id !== id) }
        : previous
    );
  }

  /** Séances, tâches et aperçu de l'ajout, pour le jour `index` (0 = lundi). */
  function itemsOf(index: number): GridItem[] {
    const items: GridItem[] = [];
    for (const session of sessions) {
      const course = byId.get(session.courseId);
      if (course && dayIndex(session.start) === index)
        items.push({ kind: 'session', session, course, start: session.start, end: session.end });
    }
    for (const task of tasks) {
      const times = drag?.taskId === task.id ? drag : task;
      if (dayIndex(times.start) === index)
        items.push({ kind: 'task', task, start: times.start, end: times.end });
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
  function renderItem(
    item: GridItem,
    layout?: { style: React.CSSProperties; stacked: boolean; titleOnly: boolean }
  ): React.ReactNode {
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
          className={[
            styles.block,
            styles.task,
            extra,
            task.done ? styles.done : '',
            drag?.taskId === task.id ? styles.dragging : '',
          ].join(' ')}
          style={{ ...style, ...hueStyle(task.color) }}
          onPointerDown={layout ? (event) => startDrag(event, task, 'move') : undefined}
          onClick={() => {
            if (!suppressClick.current) setOpenTask(task);
          }}
        >
          <span className={styles.blockTitle}>{task.title}</span>
          <span className={styles.blockDetail}>{linked ?? 'Tâche personnelle'}</span>
          <span className={styles.blockDetail}>{time}</span>
          {day}
          {task.done && <span className={styles.visuallyHidden}>, terminée</span>}
          <Pencil />
          {/* Allonger à la souris ; au clavier, la fenêtre de modification change la fin. */}
          {layout && (
            <span
              className={styles.resizeHandle}
              aria-hidden="true"
              onPointerDown={(event) => startDrag(event, task, 'resize')}
            />
          )}
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
        <span className={styles.blockTitle}>
          {isTask ? draft.title.trim() || 'Nouvelle tâche' : course?.code}
        </span>
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
        <div ref={scrollRef} className={styles.gridScroll}>
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
                ref={(el) => {
                  columnsRef.current[index] = el;
                }}
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
          <button
            type="button"
            className={styles.button}
            disabled={offset === 0}
            onClick={() => goTo(0)}
          >
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
        <div className={styles.sidebar}>
          {panelOpen && (
            <aside id={panelId} ref={panelRef} className={styles.panel} aria-label={addLabel}>
              <h2 className={styles.panelTitle}>
                {managesCourse ? "Ajouter à l'horaire" : 'Nouvelle tâche'}
              </h2>
              {form}
            </aside>
          )}
          {load.status === 'ready' && (
            <section
              className={`${styles.panel} ${styles.taskList}`}
              aria-labelledby={`${panelId}-tasks`}
            >
              <h2 id={`${panelId}-tasks`} className={styles.panelTitle}>
                Mes tâches de la semaine
              </h2>
              {tasks.length === 0 ? (
                <p className={styles.taskListEmpty}>Aucune tâche cette semaine.</p>
              ) : (
                <ul>
                  {[...tasks]
                    .sort((a, b) => a.start.localeCompare(b.start))
                    .map((task) => (
                      <li
                        key={task.id}
                        className={task.done ? styles.done : ''}
                        style={hueStyle(task.color)}
                      >
                        <input
                          type="checkbox"
                          checked={task.done}
                          aria-label={`${task.title} : terminée`}
                          onChange={() => void patchTask(task, { done: !task.done })}
                        />
                        <button type="button" onClick={() => setOpenTask(task)}>
                          <span className={styles.blockTitle}>{task.title}</span>
                          <span className={styles.taskWhen}>
                            {dayTitle(new Date(task.start))}, {formatTime(task.start)} à{' '}
                            {formatTime(task.end)}
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
      {compact && adding && (
        <AddPopup label={addLabel} onClose={closeAdd}>
          {form}
        </AddPopup>
      )}
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
function AddPopup({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
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
