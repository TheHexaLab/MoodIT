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
  formatRange,
  formatTime,
  isSameDay,
  longDay,
  minutesFromStart,
  placeItems,
  shiftTimes,
  shortDate,
  shortDay,
  startOfWeek,
  toDateInput,
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
/** Distance au bord de la grille, en px, où le glisser la fait défiler. */
const SCROLL_EDGE = 48;
/** Défilement automatique le plus rapide, en px par image. */
const MAX_SCROLL_STEP = 8;
/** Sous ces hauteurs (rem), un bloc ne garde que son titre, puis son titre et une ligne. */
const TINY_REM = 2.5;
const SHORT_REM = 3.6;
/** Hauteur, en rem, des lignes fixes d'un bloc (titre, deux détails, marges) ; et d'une ligne de description. */
const BLOCK_LINES_REM = 3.25;
const DESCRIPTION_LINE_REM = 0.9375;
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
  /** Couleurs choisies par l'utilisateur pour ses cours (les autres gardent la leur). */
  fetchCourseColors: () => Promise<Record<number, ScheduleColor>>;
  setCourseColor: (courseId: number, color: ScheduleColor) => Promise<void>;
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
  | {
      status: 'ready';
      sessions: ScheduleSession[];
      tasks: ScheduleTask[];
      courseColors: Record<number, ScheduleColor>;
    };

/** Tâche glissée : heures où elle tombera (au quart d'heure) et décalage libre du bloc, en px. */
interface DragState {
  taskId: number;
  mode: DragMode;
  start: string;
  end: string;
  dx: number;
  dy: number;
}

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

const Trash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
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
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Colonnes des jours, pour savoir sur quel jour le pointeur dépose la tâche. */
  const columnsRef = useRef<(HTMLDivElement | null)[]>([]);
  /** Zone qui défile : la grille fait 24 h. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** Défilement gardé d'une semaine à l'autre : les heures restent alignées. */
  const savedScroll = useRef<number | null>(null);
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
    Promise.all([
      api.fetchSessions(weekStart, courses),
      api.fetchTasks(weekStart),
      api.fetchCourseColors(),
    ])
      .then(([sessions, tasks, courseColors]) => {
        if (!cancelled) setLoad({ status: 'ready', sessions, tasks, courseColors });
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

  // La grille s'ouvre sur 8 h, ou sur le premier événement s'il est plus tôt ; d'une semaine à
  // l'autre, elle reprend où l'utilisateur l'avait laissée.
  const firstHour =
    load.status === 'ready'
      ? Math.min(
          OPENING_HOUR,
          ...[...load.sessions, ...load.tasks.filter((task) => !task.allDay)].map((event) =>
            new Date(event.start).getHours()
          )
        )
      : OPENING_HOUR;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    scroller.scrollTop = savedScroll.current ?? (firstHour - FIRST_HOUR) * HOUR_REM * rem;
  }, [load.status, firstHour]);

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
  const colorOf = (courseId: number) =>
    (load.status === 'ready' ? load.courseColors[courseId] : undefined) ?? courseColor(courseId);

  /** Change la couleur d'un cours tout de suite ; la remet si l'enregistrement échoue. */
  async function changeCourseColor(courseId: number, color: ScheduleColor) {
    const previousColor = load.status === 'ready' ? load.courseColors[courseId] : undefined;
    const put = (value: ScheduleColor | undefined) =>
      setLoad((previous) => {
        if (previous.status !== 'ready') return previous;
        const courseColors = { ...previous.courseColors };
        if (value) courseColors[courseId] = value;
        else delete courseColors[courseId];
        return { ...previous, courseColors };
      });
    put(color);
    try {
      await api.setCourseColor(courseId, color);
    } catch {
      put(previousColor);
    }
  }
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

  /**
   * Glisser une tâche dans la grille : la déplacer (heure, jour) ou l'allonger par sa poignée du
   * bas. Le bloc suit le pointeur librement, sans quitter la grille ; un emplacement de sa couleur
   * montre où il tombera, au quart d'heure. Près du haut ou du bas, la grille défile avec lui.
   */
  function startDrag(event: React.PointerEvent, task: ScheduleTask, mode: DragMode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const scroller = scrollRef.current;
    const blockRect = (event.currentTarget as HTMLElement)
      .closest('button')!
      .getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const pxPerMinute = (HOUR_REM * rem) / 60;
    const columns = columnsRef.current.filter((el): el is HTMLDivElement => el != null);
    const gridLeft = columns[0].getBoundingClientRect().left;
    const gridRight = columns[columns.length - 1].getBoundingClientRect().right;
    const top = minutesFromStart(task.start) * pxPerMinute;
    const bottom = minutesFromStart(task.end) * pxPerMinute;
    const columnHeight = HOURS.length * HOUR_REM * rem;
    const origin = {
      x: event.clientX,
      y: event.clientY,
      scroll: scroller?.scrollTop ?? 0,
      day: dayIndex(task.start),
    };
    const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
    let pointer = { x: origin.x, y: origin.y };
    let current: { start: string; end: string } | null = null;
    let frame = 0;

    const update = () => {
      const dx = pointer.x - origin.x;
      const dy = pointer.y - origin.y + (scroller?.scrollTop ?? 0) - origin.scroll;
      if (!current && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      const freeDy =
        mode === 'move'
          ? clamp(dy, -top, columnHeight - bottom)
          : clamp(dy, 15 * pxPerMinute - (bottom - top), columnHeight - bottom);
      const freeDx =
        mode === 'move' ? clamp(dx, gridLeft - blockRect.left, gridRight - blockRect.right) : 0;
      const x = clamp(pointer.x, gridLeft, gridRight - 1);
      const column = columns.findIndex((el) => {
        const rect = el.getBoundingClientRect();
        return x >= rect.left && x < rect.right;
      });
      const delta = Math.round(freeDy / pxPerMinute / 15) * 15;
      current = shiftTimes(task, mode, delta, column === -1 ? 0 : column - origin.day);
      setDrag({ taskId: task.id, mode, ...current, dx: freeDx, dy: freeDy });
    };
    // Défilement automatique, tant que le pointeur reste près d'un bord de la grille.
    const tick = () => {
      const rect = scroller?.getBoundingClientRect();
      if (scroller && rect && rect.height > 0 && current) {
        const above = rect.top + SCROLL_EDGE - pointer.y;
        const below = pointer.y - (rect.bottom - SCROLL_EDGE);
        // Plus le pointeur s'approche du bord, plus la grille défile vite, jusqu'à MAX_SCROLL_STEP.
        const depth =
          above > 0 ? -Math.min(above, SCROLL_EDGE) : below > 0 ? Math.min(below, SCROLL_EDGE) : 0;
        if (depth !== 0) {
          scroller.scrollTop += (depth / SCROLL_EDGE) * MAX_SCROLL_STEP;
          update();
        }
      }
      frame = window.requestAnimationFrame(tick);
    };
    const onMove = (move: PointerEvent) => {
      pointer = { x: move.clientX, y: move.clientY };
      update();
    };
    const onUp = () => {
      window.cancelAnimationFrame(frame);
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
    frame = window.requestAnimationFrame(tick);
  }

  /** Emplacement où tombera la tâche glissée, dans la colonne de son jour d'arrivée. */
  function renderDropSpot(index: number): React.ReactNode {
    const task =
      drag && dayIndex(drag.start) === index ? tasks.find((t) => t.id === drag.taskId) : undefined;
    if (!drag || !task) return null;
    return (
      <div
        className={styles.dropSpot}
        aria-hidden="true"
        style={{
          ...hueStyle(task.color),
          top: `${(minutesFromStart(drag.start) / 60) * HOUR_REM}rem`,
          height: `${((minutesFromStart(drag.end) - minutesFromStart(drag.start)) / 60) * HOUR_REM}rem`,
        }}
      >
        {formatTime(drag.start)} à {formatTime(drag.end)}
      </div>
    );
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
  /** Tâches sans heure du jour `index`, qui vont dans la rangée « Journée ». */
  const allDayOf = (index: number) =>
    tasks.filter((task) => task.allDay && dayIndex(task.start) === index);
  const allDayDraft =
    adding?.kind === 'task' && adding.allDay && adding.date && inShownWeek(toIso(adding.date))
      ? adding
      : null;
  const hasAllDay = tasks.some((task) => task.allDay) || allDayDraft != null;

  /** `withAllDay` : la liste mobile met aussi les tâches sans heure, en tête de leur jour. */
  function itemsOf(index: number, withAllDay = false): GridItem[] {
    const items: GridItem[] = [];
    for (const session of sessions) {
      const course = byId.get(session.courseId);
      if (course && dayIndex(session.start) === index)
        items.push({ kind: 'session', session, course, start: session.start, end: session.end });
    }
    for (const task of tasks) {
      if (dayIndex(task.start) === index && (withAllDay || !task.allDay))
        items.push({ kind: 'task', task, start: task.start, end: task.end });
    }
    if (adding && !allDayDraft && adding.date && adding.end > adding.start) {
      const start = toIso(adding.date, adding.start);
      if (inShownWeek(start) && dayIndex(start) === index) {
        items.push({ kind: 'preview', draft: adding, start, end: toIso(adding.date, adding.end) });
      }
    }
    return items;
  }

  /**
   * `layout` : position dans la grille ; `titleOnly` quand un autre événement le recouvre tôt ;
   * `visibleRem`, la hauteur visible, qui dit combien de lignes de description y tiennent.
   */
  function renderItem(
    item: GridItem,
    layout?: {
      style: React.CSSProperties;
      stacked: boolean;
      titleOnly: boolean;
      visibleRem: number;
      heightRem: number;
    }
  ): React.ReactNode {
    const style = layout?.style;
    // Petit bloc : le titre reste toujours lisible ; les lignes qui n'y tiennent pas sont retirées.
    const size =
      layout && layout.heightRem < TINY_REM
        ? styles.tiny
        : layout && layout.heightRem < SHORT_REM
          ? styles.short
          : '';
    const extra = `${layout?.stacked ? styles.stacked : ''} ${layout?.titleOnly ? styles.titleOnly : ''} ${size}`;
    const time = `${formatTime(item.start)} à ${formatTime(item.end)}`;
    const day = <span className={styles.visuallyHidden}>, {longDay(new Date(item.start))}</span>;
    if (item.kind === 'session') {
      const { session, course } = item;
      return (
        <button
          key={`s${session.id}`}
          type="button"
          className={`${styles.block} ${styles.session} ${extra}`}
          style={{ ...style, ...hueStyle(colorOf(course.id)) }}
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
      const dragged = drag?.taskId === task.id ? drag : null;
      // Le bloc glissé suit le pointeur : déplacé, ou allongé par le bas.
      const dragStyle: React.CSSProperties = !dragged
        ? {}
        : dragged.mode === 'move'
          ? { transform: `translate(${dragged.dx}px, ${dragged.dy}px)` }
          : { height: `calc(${style?.height} + ${dragged.dy}px)` };
      // Description sous les détails, sur les lignes que la hauteur visible laisse libres.
      const descriptionLines =
        layout && !layout.titleOnly && task.notes
          ? Math.floor((layout.visibleRem - BLOCK_LINES_REM) / DESCRIPTION_LINE_REM)
          : 0;
      return (
        <button
          key={`t${task.id}`}
          type="button"
          className={[
            styles.block,
            styles.task,
            extra,
            task.done ? styles.done : '',
            dragged ? styles.dragging : '',
          ].join(' ')}
          style={{ ...style, ...dragStyle, ...hueStyle(task.color) }}
          onPointerDown={layout ? (event) => startDrag(event, task, 'move') : undefined}
          onClick={() => {
            if (!suppressClick.current) setOpenTask(task);
          }}
        >
          <span className={styles.blockTitle}>{task.title}</span>
          <span className={styles.blockDetail}>
            {task.allDay ? 'Toute la journée' : formatRange(item.start, item.end)}
            {linked && ` · ${linked}`}
          </span>
          {descriptionLines > 0 && (
            // Hors du nom accessible : la fenêtre de la tâche la donne en entier.
            <span
              className={styles.blockDescription}
              style={{ WebkitLineClamp: descriptionLines }}
              aria-hidden="true"
            >
              {task.notes}
            </span>
          )}
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
        style={{ ...style, ...hueStyle(isTask ? draft.color : colorOf(draft.courseId ?? 0)) }}
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
            const ofDay = itemsOf(index, true)
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
        <div
          ref={scrollRef}
          className={styles.gridScroll}
          onScroll={(event) => {
            savedScroll.current = event.currentTarget.scrollTop;
          }}
        >
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
            {hasAllDay && (
              <>
                <div className={styles.allDayLabel} aria-hidden="true">
                  Journée
                </div>
                {days.map((day, index) => (
                  <div key={day.getTime()} className={styles.allDayCell}>
                    {allDayOf(index).map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className={`${styles.allDayChip} ${task.done ? styles.done : ''}`}
                        style={hueStyle(task.color)}
                        onClick={() => setOpenTask(task)}
                      >
                        <span className={styles.blockTitle}>{task.title}</span>
                        <span className={styles.visuallyHidden}>
                          , {longDay(day)}, toute la journée{task.done ? ', terminée' : ''}
                        </span>
                      </button>
                    ))}
                    {allDayDraft && toIso(allDayDraft.date) === toIso(toDateInput(day)) && (
                      <div
                        className={`${styles.allDayChip} ${styles.preview}`}
                        style={hueStyle(allDayDraft.color)}
                        aria-hidden="true"
                      >
                        {allDayDraft.title.trim() || 'Nouvelle tâche'}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
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
                    visibleRem: (visible / 60) * HOUR_REM,
                    heightRem:
                      ((minutesFromStart(item.end) - minutesFromStart(item.start)) / 60) * HOUR_REM,
                  })
                )}
                {renderDropSpot(index)}
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
          {/* Pendant l'ajout, le formulaire prend toute la colonne ; la liste revient après. */}
          {panelOpen && (
            <aside
              id={panelId}
              ref={panelRef}
              className={`${styles.panel} ${styles.panelFill}`}
              aria-label={addLabel}
            >
              <h2 className={styles.panelTitle}>
                {managesCourse ? "Ajouter à l'horaire" : 'Nouvelle tâche'}
              </h2>
              {form}
            </aside>
          )}
          {!panelOpen && load.status === 'ready' && (
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
                        <button
                          type="button"
                          className={styles.taskOpen}
                          onClick={() => setOpenTask(task)}
                        >
                          <span className={styles.taskTitle}>{task.title}</span>
                          <span className={styles.taskWhen}>
                            {shortDate(task.start)} ·{' '}
                            {task.allDay ? 'toute la journée' : formatRange(task.start, task.end)}
                          </span>
                        </button>
                        {/* Visible au survol de la ligne, ou au focus du clavier. */}
                        <button
                          type="button"
                          className={styles.taskDelete}
                          aria-label={`Supprimer « ${task.title} »`}
                          onClick={() => void removeTask(task.id).catch(() => undefined)}
                        >
                          <Trash />
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
          color={colorOf(sessionCourse.id)}
          onColorChange={(color) => void changeCourseColor(sessionCourse.id, color)}
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
