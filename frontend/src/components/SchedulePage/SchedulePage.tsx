import React, { useEffect, useId, useRef, useState } from 'react';
import styles from './SchedulePage.module.css';
import { Spinner } from '../Spinner/Spinner.tsx';
import { Popup } from '../Popup/Popup.tsx';
import { PopupVariant } from '../Popup/popupVariant.ts';
import { usePopupController } from '../Popup/popupController.ts';
import ScheduleForm from './ScheduleForm.tsx';
import { DeadlinePopup, Header, SessionPopup, TaskPopup } from './SchedulePopups.tsx';
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
  formatShortTime,
  isSameDay,
  kindTag,
  longDay,
  minutesFromStart,
  placeItems,
  SESSION_KINDS,
  shiftTimes,
  shortDate,
  shortDay,
  startOfWeek,
  toDateInput,
  toTimeInput,
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
/** Tâches sans heure montrées par jour avant « +N de plus ». */
const MAX_ALL_DAY = 2;
/** Durée de la sortie d'une tâche cochée de la liste, en ms (comme l'animation CSS). */
const LEAVE_MS = 450;
/** Durée de l'avis « Annuler » après avoir coché une tâche, en ms. */
const UNDO_MS = 3000;
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
  /** Remises de la semaine : les dates de remise des devoirs des cours (#258). */
  fetchDeadlines: (weekStart: Date, courses: ScheduleCourse[]) => Promise<ScheduleTask[]>;
}

interface SchedulePageProps {
  /** Cours de l'utilisateur, tous programmes confondus. */
  courses: ScheduleCourse[];
  api: ScheduleApi;
  /** Ouvre le cours d'une séance. */
  onOpenCourse: (programId: number, courseId: number) => void;
  /** « Voir le devoir » d'une remise : ouvre le devoir dans le canal Devoirs du cours. */
  onOpenAssignment?: (programId: number, courseId: number, assignmentId: number) => void;
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
  /** `t<id>` pour une tâche, `preview` pour l'aperçu de l'ajout. */
  key: string;
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
 * personnel) et les tâches personnelles de l'utilisateur, du dimanche au samedi. L'enseignant ou le
 * responsable d'un cours y ajoute aussi des séances.
 */
export default function SchedulePage({
  courses,
  api,
  onOpenCourse,
  onOpenAssignment,
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
  /** Jour dont toutes les tâches sans heure sont affichées (plus de deux). */
  const [openAllDay, setOpenAllDay] = useState<number | null>(null);
  /** Types de séance de la liste, que l'enseignant ajoute ou supprime (pour la session). */
  const [sessionKinds, setSessionKinds] = useState<string[]>(SESSION_KINDS);
  /** Tâches cochées qui sortent de la liste en s'effaçant. */
  const [leaving, setLeaving] = useState<number[]>([]);
  /** Tâches cochées dont la ligne propose « Annuler » pendant UNDO_MS, à leur place dans la liste. */
  const [undoIds, setUndoIds] = useState<number[]>([]);
  const undoTimers = useRef(new Map<number, number>());
  useEffect(() => {
    const timers = undoTimers.current;
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);
  /** Heure courante pour la ligne bleue du jour ; avance chaque minute. */
  const [clock, setClock] = useState(now);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
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
  const weekStart = addDays(new Date(thisWeek), offset * 7);
  const weekStartTime = weekStart.getTime();
  const courseKey = courses.map((course) => course.id).join(',');
  const managesCourse = courses.some((course) => course.canManage);
  const addLabel = managesCourse ? "Ajouter à l'horaire" : 'Ajouter une tâche';
  const panelOpen = adding != null && !compact;

  useEffect(() => {
    let cancelled = false;
    const weekStart = new Date(weekStartTime);
    Promise.all([
      api.fetchSessions(weekStart, courses),
      api.fetchTasks(weekStart),
      api.fetchCourseColors(),
      api.fetchDeadlines(weekStart, courses),
    ])
      .then(([sessions, tasks, courseColors, deadlines]) => {
        // Les remises des devoirs rejoignent les tâches : même barre, même liste.
        if (!cancelled)
          setLoad({ status: 'ready', sessions, tasks: [...tasks, ...deadlines], courseColors });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `courses` est suivi par ses ids (courseKey) : un nouveau tableau aux mêmes cours ne recharge pas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartTime, courseKey, api, attempt]);

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

  // Le panneau d'ajout prend le focus à l'ouverture ; à la fermeture, le bouton revenu le reprend.
  const wasPanelOpen = useRef(false);
  useEffect(() => {
    if (panelOpen) panelRef.current?.querySelector<HTMLElement>('input, select')?.focus();
    else if (wasPanelOpen.current) addButtonRef.current?.focus();
    wasPanelOpen.current = panelOpen;
  }, [panelOpen]);

  function goTo(nextOffset: number) {
    setLoad({ status: 'loading' });
    setOffset(nextOffset);
    setOpenAllDay(null);
  }

  const days = weekDays(weekStart);
  const byId = new Map(courses.map((course) => [course.id, course]));
  const sessions = load.status === 'ready' ? load.sessions : [];
  // L'enseignant n'a pas de tâches personnelles : il voit les séances et les remises de ses cours.
  const tasks =
    load.status === 'ready'
      ? managesCourse
        ? load.tasks.filter((task) => task.courseDeadline)
        : load.tasks
      : [];
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
    dayIndex(iso) !== -1 && startOfWeek(new Date(iso)).getTime() === weekStartTime;

  function openAdd() {
    const today = days.find((day) => isSameDay(day, now));
    // Qui gère un cours ajoute ce que ses étudiants verront (séance ou remise) ; l'étudiant, ses tâches.
    const managedCourse = courses.find((course) => course.canManage);
    setAdding({
      ...emptyDraft(
        managedCourse ? 'session' : 'task',
        today ?? weekStart,
        now.getHours() + 1,
        managedCourse?.id ?? null
      ),
      // Le premier type de la liste, qui a pu changer.
      sessionKind: sessionKinds[0] ?? '',
    });
    setAddError(null);
  }

  function closeAdd() {
    setAdding(null);
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
   * Glisser une tâche, ou l'aperçu de l'ajout, dans la grille : la déplacer (heure, jour) ou
   * l'allonger par sa poignée du bas. Le bloc suit le pointeur librement, sans quitter la grille ;
   * une ombre de sa couleur montre où il tombera, au quart d'heure, et le bloc affiche l'heure
   * d'arrivée. Près du haut ou du bas, la grille défile avec lui. `onDrop` reçoit les nouvelles heures.
   */
  function startDrag(
    event: React.PointerEvent,
    key: string,
    task: { start: string; end: string },
    mode: DragMode,
    onDrop: (times: { start: string; end: string }) => void
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const scroller = scrollRef.current;
    const blockRect = (event.currentTarget as HTMLElement)
      .closest('[data-draggable]')!
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
      setDrag({ key, mode, ...current, dx: freeDx, dy: freeDy });
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
      if (current.start !== task.start || current.end !== task.end) onDrop(current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    frame = window.requestAnimationFrame(tick);
  }

  /** Couleur de ce qui est glissé : la tâche, ou l'aperçu de l'ajout (tâche ou séance). */
  function dragColor(key: string): ScheduleColor | undefined {
    if (key === 'preview') {
      if (!adding) return undefined;
      return adding.kind === 'task' ? adding.color : colorOf(adding.courseId ?? 0);
    }
    return tasks.find((t) => `t${t.id}` === key)?.color;
  }

  /** Durée de ce qui est glissé, en rem de grille. */
  const durationRem = (times: { start: string; end: string }) =>
    ((minutesFromStart(times.end) - minutesFromStart(times.start)) / 60) * HOUR_REM;

  /** Style du bloc glissé : il suit le pointeur, déplacé ou allongé par le bas. */
  function dragStyleOf(dragged: DragState | null): React.CSSProperties {
    if (!dragged) return {};
    return dragged.mode === 'move'
      ? { transform: `translate(${dragged.dx}px, ${dragged.dy}px)` }
      : { height: `${durationRem(dragged)}rem` };
  }

  /** Ombre où tombera ce qui est glissé, dans la colonne de son jour d'arrivée. */
  function renderDropSpot(index: number): React.ReactNode {
    // Allonger : le bloc montre déjà sa hauteur d'arrivée ; l'ombre ne sert qu'à déplacer.
    // Une remise n'a pas de durée : pas d'ombre, l'aperçu lui-même suit le pointeur.
    const color =
      drag && drag.mode === 'move' && drag.start !== drag.end && dayIndex(drag.start) === index
        ? dragColor(drag.key)
        : undefined;
    if (!drag || !color) return null;
    return (
      <div
        className={styles.dropSpot}
        aria-hidden="true"
        style={{
          ...hueStyle(color),
          top: `${(minutesFromStart(drag.start) / 60) * HOUR_REM}rem`,
          height: `${((minutesFromStart(drag.end) - minutesFromStart(drag.start)) / 60) * HOUR_REM}rem`,
        }}
      ></div>
    );
  }

  /**
   * Cocher une tâche : elle est terminée tout de suite (pâlie dans la grille) et quitte la liste en
   * s'effaçant. La décocher pendant sa sortie la garde. On la rouvre depuis la grille.
   */
  function toggleDone(task: ScheduleTask) {
    if (task.done) {
      setLeaving((ids) => ids.filter((id) => id !== task.id));
      void patchTask(task, { done: false });
      return;
    }
    void patchTask(task, { done: true });
    // La ligne devient « terminée · Annuler » ; après UNDO_MS, elle se replie et quitte la liste.
    setUndoIds((ids) => [...ids, task.id]);
    undoTimers.current.set(
      task.id,
      window.setTimeout(() => {
        undoTimers.current.delete(task.id);
        setUndoIds((ids) => ids.filter((id) => id !== task.id));
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        setLeaving((ids) => [...ids, task.id]);
        window.setTimeout(() => setLeaving((ids) => ids.filter((id) => id !== task.id)), LEAVE_MS);
      }, UNDO_MS)
    );
    // Le clavier reste sur la ligne : le focus passe à « Annuler ».
    window.requestAnimationFrame(() =>
      document.getElementById(`${panelId}-undo-${task.id}`)?.focus()
    );
  }

  /** « Annuler » : la tâche cochée redevient à faire et reprend sa ligne. */
  function undoDone(task: ScheduleTask) {
    const timer = undoTimers.current.get(task.id);
    if (timer != null) window.clearTimeout(timer);
    undoTimers.current.delete(task.id);
    setUndoIds((ids) => ids.filter((id) => id !== task.id));
    void patchTask(task, { done: false });
  }

  /** Remises du jour `index` : une barre rouge à l'heure de l'échéance, son étiquette au-dessus. */
  function renderDeadlines(index: number): React.ReactNode {
    const top = (iso: string) => `${(minutesFromStart(iso) / 60) * HOUR_REM}rem`;
    // Plusieurs remises à la même heure : leurs étiquettes s'empilent au-dessus de la barre.
    const label = (iso: string, title: string, stack = 0) => (
      <span
        className={styles.deadlineLabel}
        style={stack ? { bottom: `calc(100% + 0.25rem + ${stack * 1.5}rem)` } : undefined}
      >
        <span className={styles.deadlineTime}>{formatShortTime(iso)}</span>
        <span className={styles.deadlineTitle}>Remise : {title}</span>
      </span>
    );
    // Aperçu de la remise en cours d'ajout : la même barre, en pointillé.
    const savedStart =
      adding?.kind === 'task' && adding.deadline && adding.date
        ? toIso(adding.date, adding.start)
        : null;
    // Pendant qu'on la glisse, l'aperçu suit l'heure d'arrivée, au quart d'heure.
    const draftStart = savedStart && drag?.key === 'preview' ? drag.start : savedStart;
    // Seul l'aperçu se glisse : une remise enregistrée reste à son heure.
    const dragDraft = (event: React.PointerEvent) =>
      savedStart &&
      startDrag(event, 'preview', { start: savedStart, end: savedStart }, 'move', (times) =>
        setAdding(
          (previous) =>
            previous && {
              ...previous,
              date: toDateInput(new Date(times.start)),
              start: toTimeInput(times.start),
            }
        )
      );
    return (
      <>
        {tasks
          .filter((task) => task.deadline && dayIndex(task.start) === index)
          .map((task, i, ofDay) => (
            <button
              key={task.id}
              type="button"
              className={`${styles.deadline} ${task.done ? styles.done : ''}`}
              style={{ top: top(task.start) }}
              onClick={() => setOpenTask(task)}
            >
              {label(
                task.start,
                task.title,
                ofDay.slice(0, i).filter((other) => other.start === task.start).length
              )}
              {/* Détails au survol, sous la barre ; la fenêtre de la tâche les donne au clavier. */}
              <span
                className={`${styles.deadlineTip} ${index >= 5 ? styles.deadlineTipEnd : ''}`}
                aria-hidden="true"
              >
                <strong>{task.title}</strong>
                <span>
                  {dayTitle(new Date(task.start))} · {formatShortTime(task.start)}
                </span>
                {task.courseId != null && byId.get(task.courseId) && (
                  <span>
                    {byId.get(task.courseId)!.code}
                    {byId.get(task.courseId)!.title ? ` · ${byId.get(task.courseId)!.title}` : ''}
                  </span>
                )}
                {task.notes && <span className={styles.deadlineTipNotes}>{task.notes}</span>}
              </span>
              <span className={styles.visuallyHidden}>
                , remise, {longDay(new Date(task.start))}
                {task.done ? ', terminée' : ''}
              </span>
            </button>
          ))}
        {draftStart && inShownWeek(draftStart) && dayIndex(draftStart) === index && (
          <div
            className={`${styles.deadline} ${styles.deadlinePreview} ${drag?.key === 'preview' ? styles.dragging : ''}`}
            style={{ top: top(draftStart) }}
            aria-hidden="true"
            data-draggable
            onPointerDown={dragDraft}
          >
            {label(draftStart, adding?.title.trim() || 'Nouvelle remise')}
          </div>
        )}
      </>
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

  /** Tâches sans heure du jour `index`, qui flottent en haut de sa colonne. */
  const allDayOf = (index: number) =>
    tasks.filter((task) => task.allDay && dayIndex(task.start) === index);
  const allDayDraft =
    adding?.kind === 'task' && adding.allDay && adding.date && inShownWeek(toIso(adding.date))
      ? adding
      : null;
  const hasAllDay = tasks.some((task) => task.allDay) || allDayDraft != null;

  /**
   * Séances, tâches et aperçu de l'ajout, pour le jour `index` (0 = dimanche). `withAllDay` : la
   * liste mobile met aussi les tâches sans heure et les remises dans leur jour.
   */
  function itemsOf(index: number, withAllDay = false): GridItem[] {
    const items: GridItem[] = [];
    for (const session of sessions) {
      const course = byId.get(session.courseId);
      if (course && dayIndex(session.start) === index)
        items.push({ kind: 'session', session, course, start: session.start, end: session.end });
    }
    for (const task of tasks) {
      // Remises et tâches sans heure ont leur propre affichage dans la grille.
      if (dayIndex(task.start) === index && (withAllDay || (!task.allDay && !task.deadline)))
        items.push({ kind: 'task', task, start: task.start, end: task.end });
    }
    // L'aperçu d'une remise est une barre (renderDeadlines), pas un bloc.
    const deadlineDraft = adding?.kind === 'task' && adding.deadline;
    if (adding && !allDayDraft && !deadlineDraft && adding.date && adding.end > adding.start) {
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
    // Glissé : la taille d'arrivée, pour voir le bloc tel qu'il sera une fois lâché.
    const held =
      drag && drag.key === (item.kind === 'task' ? `t${item.task.id}` : item.kind) ? drag : null;
    const heightRem = held ? durationRem(held) : layout?.heightRem;
    const size =
      heightRem != null && heightRem < TINY_REM
        ? styles.tiny
        : heightRem != null && heightRem < SHORT_REM
          ? styles.short
          : '';
    const extra = `${layout?.stacked ? styles.stacked : ''} ${layout?.titleOnly ? styles.titleOnly : ''} ${size}`;
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
          {/* Sigle et type (en pastille), puis le local, puis l'heure. */}
          <span className={styles.titleRow}>
            <span className={styles.blockTitle}>{course.code}</span>
            <span className={styles.kindTag}>{kindTag(session.kind)}</span>
          </span>
          <span className={styles.blockDetail}>{session.room}</span>
          <span className={styles.blockDetail}>{formatRange(item.start, item.end)}</span>
          {/* Le nom accessible reprend le texte visible (WCAG 2.5.3), suivi du jour. */}
          {day}
        </button>
      );
    }
    if (item.kind === 'task') {
      const { task } = item;
      const linked = task.courseId != null ? byId.get(task.courseId)?.code : undefined;
      const dragged = drag?.key === `t${task.id}` ? drag : null;
      const dropTask = (times: { start: string; end: string }) => void patchTask(task, times);
      // Description sous les détails, sur les lignes que la hauteur visible laisse libres.
      // Glissée, la tâche montre les lignes qu'elle aura à sa hauteur d'arrivée.
      const roomRem = dragged ? durationRem(dragged) : layout?.visibleRem;
      const descriptionLines =
        layout && roomRem != null && (dragged || !layout.titleOnly) && task.notes
          ? Math.floor((roomRem - BLOCK_LINES_REM) / DESCRIPTION_LINE_REM)
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
          style={{ ...style, ...dragStyleOf(dragged), ...hueStyle(task.color) }}
          data-draggable
          onPointerDown={
            layout ? (event) => startDrag(event, `t${task.id}`, task, 'move', dropTask) : undefined
          }
          onClick={() => {
            if (!suppressClick.current) setOpenTask(task);
          }}
        >
          <span className={styles.blockTitle}>{task.title}</span>
          <span className={styles.blockDetail}>
            {task.allDay
              ? 'Toute la journée'
              : task.deadline
                ? `Remise à ${formatShortTime(task.start)}`
                : formatRange(dragged?.start ?? item.start, dragged?.end ?? item.end)}
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
              onPointerDown={(event) => startDrag(event, `t${task.id}`, task, 'resize', dropTask)}
            />
          )}
        </button>
      );
    }
    const { draft } = item;
    const isTask = draft.kind === 'task';
    const course = draft.courseId != null ? byId.get(draft.courseId) : undefined;
    const dragged = drag?.key === 'preview' ? drag : null;
    // Glisser l'aperçu change le jour et les heures du formulaire.
    const dropPreview = (times: { start: string; end: string }) =>
      setAdding(
        (previous) =>
          previous && {
            ...previous,
            date: toDateInput(new Date(times.start)),
            start: toTimeInput(times.start),
            end: toTimeInput(times.end),
          }
      );
    return (
      <div
        key="preview"
        className={[
          styles.block,
          isTask ? styles.task : styles.session,
          styles.preview,
          extra,
          dragged ? styles.dragging : '',
        ].join(' ')}
        style={{
          ...style,
          ...dragStyleOf(dragged),
          ...hueStyle(isTask ? draft.color : colorOf(draft.courseId ?? 0)),
        }}
        aria-hidden="true"
        data-draggable
        onPointerDown={
          layout ? (event) => startDrag(event, 'preview', item, 'move', dropPreview) : undefined
        }
      >
        {isTask ? (
          <span className={styles.blockTitle}>{draft.title.trim() || 'Nouvelle tâche'}</span>
        ) : (
          <span className={styles.titleRow}>
            <span className={styles.blockTitle}>{course?.code}</span>
            <span className={styles.kindTag}>{kindTag(draft.sessionKind)}</span>
          </span>
        )}
        <span className={styles.blockDetail}>
          {formatRange(dragged?.start ?? item.start, dragged?.end ?? item.end)}
        </span>
        {layout && (
          <span
            className={styles.resizeHandle}
            onPointerDown={(event) => startDrag(event, 'preview', item, 'resize', dropPreview)}
          />
        )}
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
          <div className={styles.grid} role="group" aria-label={weekLabel(weekStart)}>
            <div className={styles.corner} aria-hidden="true" />
            {days.map((day, index) => (
              <div
                key={day.getTime()}
                className={`${styles.dayHead} ${isSameDay(day, now) ? styles.today : ''} ${index === 0 || index === 6 ? styles.weekend : ''}`}
                aria-current={isSameDay(day, now) ? 'date' : undefined}
              >
                {shortDay(day, index)}
              </div>
            ))}
            {/* Rangée « Journée » : par-dessus le haut de la grille, sans la pousser vers le bas. */}
            {hasAllDay && (
              <>
                <div className={styles.allDayLabel} aria-hidden="true" />
                {days.map((day, index) => (
                  <div
                    key={day.getTime()}
                    className={`${styles.allDayCell} ${index === 0 || index === 6 ? styles.weekend : ''}`}
                  >
                    {(openAllDay === index
                      ? allDayOf(index)
                      : allDayOf(index).slice(0, MAX_ALL_DAY)
                    ).map((task) => (
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
                    {/* Au-delà de deux, « +N de plus » déplie la liste du jour. */}
                    {allDayOf(index).length > MAX_ALL_DAY && (
                      <button
                        type="button"
                        className={styles.allDayMore}
                        aria-expanded={openAllDay === index}
                        onClick={() => setOpenAllDay(openAllDay === index ? null : index)}
                      >
                        {openAllDay === index
                          ? 'Voir moins'
                          : `+${allDayOf(index).length - MAX_ALL_DAY} de plus`}
                      </button>
                    )}
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
                className={`${styles.dayColumn} ${isSameDay(day, now) ? styles.today : ''} ${index === 0 || index === 6 ? styles.weekend : ''}`}
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
                {renderDeadlines(index)}
                {/* Ligne bleue de l'heure courante, dans la colonne d'aujourd'hui. */}
                {isSameDay(day, clock) && (
                  <div
                    className={styles.nowLine}
                    style={{ top: `${(minutesFromStart(clock.toISOString()) / 60) * HOUR_REM}rem` }}
                    aria-hidden="true"
                  />
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
      kinds={sessionKinds}
      onAddKind={(kind) => setSessionKinds((kinds) => [...kinds, kind])}
      onDeleteKind={(kind) => setSessionKinds((kinds) => kinds.filter((known) => known !== kind))}
      error={addError}
      busy={addBusy}
      submitLabel={
        adding.kind === 'session'
          ? 'Ajouter la séance'
          : adding.deadline
            ? 'Ajouter la remise'
            : 'Ajouter la tâche'
      }
      onSubmit={() => void submitAdd()}
      onCancel={closeAdd}
    />
  );
  const listed = [...tasks]
    .filter((task) => !task.done || leaving.includes(task.id) || undoIds.includes(task.id))
    .sort((a, b) => a.start.localeCompare(b.start));
  const sessionCourse = openSession ? byId.get(openSession.courseId) : undefined;

  /** Colonne de droite : l'ajout en cours ; « Mes tâches » pour l'étudiant seulement. */
  const hasSidebar = panelOpen || !managesCourse;
  // Panneau ouvert : le bouton disparaît ; « Annuler » du panneau le referme.
  const addButton = !panelOpen && (
    <button
      ref={addButtonRef}
      type="button"
      className={`${styles.button} ${styles.primary}`}
      onClick={openAdd}
    >
      {addLabel}
    </button>
  );

  return (
    <section className={styles.page} aria-label="Contenu principal">
      {/* En-tête aux mêmes colonnes que le corps : la navigation s'aligne sur le bord droit de la
          grille, le bouton d'ajout sur la colonne de droite (quand elle existe). */}
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <div className={styles.headerText}>
            <h1 className={styles.title}>Horaire</h1>
            <p className={styles.subtitle}>{weekLabel(weekStart)}</p>
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
            {!hasSidebar && addButton}
          </div>
        </div>
        {hasSidebar && <div className={styles.headerSide}>{addButton}</div>}
      </header>
      <div className={styles.body}>
        <div className={styles.main}>{renderBody()}</div>
        {/* Colonne de droite : l'ajout en cours ; « Mes tâches » pour l'étudiant seulement. */}
        {hasSidebar && (
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
            {!panelOpen && !managesCourse && load.status === 'ready' && (
              <section
                className={`${styles.panel} ${styles.taskList}`}
                aria-labelledby={`${panelId}-tasks`}
              >
                <h2 id={`${panelId}-tasks`} className={styles.panelTitle}>
                  Mes tâches de la semaine
                </h2>
                {tasks.length === 0 ? (
                  <p className={styles.taskListEmpty}>Aucune tâche cette semaine.</p>
                ) : listed.length === 0 ? (
                  <p className={styles.taskListEmpty}>Tout est fait pour cette semaine.</p>
                ) : (
                  <ul>
                    {listed.map((task) =>
                      undoIds.includes(task.id) ? (
                        <li key={task.id} className={styles.undoRow}>
                          <span role="status">« {task.title} » terminée</span>
                          <button
                            id={`${panelId}-undo-${task.id}`}
                            type="button"
                            aria-label={`Annuler : remettre « ${task.title} » à faire`}
                            onClick={() => undoDone(task)}
                          >
                            Annuler
                          </button>
                        </li>
                      ) : (
                        <li
                          key={task.id}
                          className={`${leaving.includes(task.id) ? styles.leaving : ''} ${task.deadline ? styles.deadlineItem : ''}`}
                          style={hueStyle(task.color)}
                        >
                          {/* Remise d'un devoir : faite quand le devoir est remis, pas cochée ici. */}
                          {task.courseDeadline ? (
                            <span className={styles.checkSpacer} aria-hidden="true" />
                          ) : (
                            <input
                              type="checkbox"
                              checked={task.done}
                              aria-label={`${task.title} : terminée`}
                              onChange={() => toggleDone(task)}
                            />
                          )}
                          <button
                            type="button"
                            className={styles.taskOpen}
                            onClick={() => setOpenTask(task)}
                          >
                            <span className={styles.taskTitle}>{task.title}</span>
                            <span className={styles.taskWhen}>
                              {shortDate(task.start)} ·{' '}
                              {task.allDay ? (
                                'toute la journée'
                              ) : task.deadline ? (
                                <>
                                  {/* Le cours d'une remise : deux cours peuvent avoir un devoir du même nom. */}
                                  {task.courseId != null &&
                                    byId.get(task.courseId) &&
                                    `${byId.get(task.courseId)!.code} · `}
                                  <strong className={styles.deadlineBadge}>
                                    Remise à {formatShortTime(task.start)}
                                  </strong>
                                </>
                              ) : (
                                formatRange(task.start, task.end)
                              )}
                            </span>
                          </button>
                          {/* Visible au survol de la ligne, ou au focus du clavier. Un devoir ne se supprime pas ici. */}
                          {!task.courseDeadline && (
                            <button
                              type="button"
                              className={styles.taskDelete}
                              aria-label={`Supprimer « ${task.title} »`}
                              onClick={() => void removeTask(task.id).catch(() => undefined)}
                            >
                              <Trash />
                            </button>
                          )}
                        </li>
                      )
                    )}
                  </ul>
                )}
              </section>
            )}
          </div>
        )}
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
      {/* Une remise vient d'un devoir du cours : elle se lit ici, elle se modifie dans Devoirs. */}
      {openTask && openTask.courseDeadline && (
        <DeadlinePopup
          task={openTask}
          course={openTask.courseId != null ? byId.get(openTask.courseId) : undefined}
          onClose={() => setOpenTask(null)}
          onOpenAssignment={(() => {
            const course = openTask.courseId != null ? byId.get(openTask.courseId) : undefined;
            const assignmentId = openTask.assignmentId;
            return course && assignmentId != null && onOpenAssignment
              ? () => {
                  setOpenTask(null);
                  onOpenAssignment(course.programId, course.id, assignmentId);
                }
              : undefined;
          })()}
        />
      )}
      {openTask && !openTask.courseDeadline && (
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
