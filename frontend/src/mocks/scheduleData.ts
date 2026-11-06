import type {
  ScheduleColor,
  ScheduleCourse,
  ScheduleSession,
  ScheduleSessionInput,
  ScheduleSessionScope,
  ScheduleTask,
  ScheduleTaskInput,
} from '../types/domain.ts';

/** Créneaux de la semaine fictive : jour (0 = lundi), début et fin en minutes depuis minuit ; la semaine commence le dimanche. */
const SLOTS: { day: number; start: number; end: number }[] = [
  { day: 0, start: 8 * 60 + 30, end: 10 * 60 + 15 },
  { day: 2, start: 13 * 60 + 30, end: 15 * 60 + 15 },
  { day: 1, start: 9 * 60 + 30, end: 11 * 60 + 15 },
  { day: 3, start: 10 * 60 + 30, end: 12 * 60 + 15 },
  { day: 0, start: 10 * 60 + 30, end: 12 * 60 + 15 },
  { day: 4, start: 13 * 60 + 30, end: 15 * 60 + 15 },
  { day: 2, start: 8 * 60 + 30, end: 10 * 60 + 15 },
  { day: 4, start: 10 * 60 + 30, end: 12 * 60 + 15 },
  { day: 1, start: 13 * 60 + 30, end: 16 * 60 + 15 },
  { day: 3, start: 14 * 60 + 30, end: 16 * 60 + 15 },
  { day: 0, start: 13 * 60 + 30, end: 15 * 60 + 15 },
  { day: 2, start: 10 * 60 + 30, end: 12 * 60 + 15 },
];

const KINDS = ['Cours', 'Travaux dirigés', 'Laboratoire', 'Atelier'];
const ROOMS = ['C1-3125', 'C1-4016', 'D7-2021', 'A5-1120'];

/**
 * Horaire fictif d'une semaine (#206) : deux séances par cours, aux mêmes créneaux chaque semaine.
 * Contenu d'exemple, jamais affiché en production.
 */
export function demoSchedule(weekStart: Date, courses: ScheduleCourse[]): ScheduleSession[] {
  const ids = new Set(courses.map((course) => course.id));
  const added = addedSessions.filter((s) => ids.has(s.courseId) && inWeek(s.start, weekStart));
  // Un id par semaine : chaque occurrence se modifie à part ; la série garde l'id de son créneau.
  const week = Math.round(weekStart.getTime() / (7 * DAY_MS));
  return courses
    .flatMap((course, index) =>
      [0, 1].flatMap((half): ScheduleSession[] => {
        const seriesId = course.id * 10 + half;
        const id = week * 100_000 + seriesId;
        const change = seriesEdits.get(seriesId);
        if (change === null || detached.has(id)) return [];
        const slot = SLOTS[(index * 2 + half) % SLOTS.length];
        const at = (minutes: number, shift: number) => {
          const date = new Date(weekStart);
          date.setDate(date.getDate() + 1 + slot.day);
          date.setHours(0, minutes, 0, 0);
          return new Date(date.getTime() + shift).toISOString();
        };
        return [
          {
            id,
            seriesId,
            courseId: change?.courseId ?? course.id,
            kind: change?.kind ?? (half === 0 ? 'Cours' : KINDS[(index + 1) % KINDS.length]),
            room: change?.room ?? ROOMS[(index + half) % ROOMS.length],
            start: at(slot.start, change?.startShift ?? 0),
            end: at(slot.end, change?.endShift ?? 0),
          },
        ];
      })
    )
    .filter((session) => ids.has(session.courseId))
    .concat(added);
}

// ── Agenda fictif : tâches et séances ajoutées, gardées en mémoire le temps de la session ──

const DAY_MS = 86_400_000;

function inWeek(iso: string, weekStart: Date): boolean {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 7);
  const date = new Date(iso);
  return date >= weekStart && date < end;
}

/** `minutes` après minuit, `day` jours après le lundi de la semaine courante. */
function thisWeekAt(day: number, minutes: number): string {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  // Lundi de la semaine courante, qui commence le dimanche.
  monday.setDate(monday.getDate() - monday.getDay() + 1 + day);
  monday.setMinutes(minutes);
  return monday.toISOString();
}

function seedTasks(): ScheduleTask[] {
  const task = (
    id: number,
    title: string,
    day: number,
    start: number,
    end: number,
    color: ScheduleTask['color'],
    notes = ''
  ) => ({
    id,
    title,
    start: thisWeekAt(day, start),
    end: thisWeekAt(day, end),
    courseId: null,
    reminder: null,
    notes,
    color,
    done: false,
    allDay: false,
    deadline: false,
  });
  return [
    task(1, 'Tutorat', 2, 14 * 60, 15 * 60, 'rose'),
    task(
      2,
      "Rencontre d'équipe",
      2,
      14 * 60 + 30,
      16 * 60 + 30,
      'gray',
      'Préparer la démo du projet et répartir les tâches du prochain sprint.'
    ),
    task(3, 'Appel de stage', 4, 14 * 60, 15 * 60, 'green'),
    { ...task(4, 'Remise du TP2', 3, 0, 0, 'orange'), allDay: true },
  ];
}

let tasks: ScheduleTask[] = seedTasks();
let addedSessions: ScheduleSession[] = [];
let nextId = 1000;
/** Séries ajoutées : numérotées loin des créneaux fictifs. */
let nextSeries = 10_000_000;

/** Série fictive modifiée (décalage de ses heures, en ms) ou supprimée (null). */
interface SeriesEdit {
  courseId: number;
  kind: string;
  room: string;
  startShift: number;
  endShift: number;
}
let seriesEdits = new Map<number, SeriesEdit | null>();
/** Occurrences fictives retirées de leur série : supprimées, ou modifiées (alors dans addedSessions). */
let detached = new Set<number>();
let courseColors: Record<number, ScheduleColor> = {};

/** Remet l'agenda fictif à son état de départ (tests). */
export function resetDemoAgenda(): void {
  tasks = seedTasks();
  addedSessions = [];
  nextId = 1000;
  nextSeries = 10_000_000;
  seriesEdits = new Map();
  detached = new Set();
  courseColors = {};
}

/** Couleurs choisies pour les cours ; un cours absent garde sa couleur par défaut. */
export function demoCourseColors(): Record<number, ScheduleColor> {
  return { ...courseColors };
}

export function setDemoCourseColor(courseId: number, color: ScheduleColor): void {
  courseColors = { ...courseColors, [courseId]: color };
}

/** Tâches de la semaine qui commence à `weekStart`. */
export function demoTasks(weekStart: Date): ScheduleTask[] {
  return tasks.filter((task) => inWeek(task.start, weekStart));
}

export function addDemoTask(input: ScheduleTaskInput): ScheduleTask {
  const task = { ...input, id: nextId++ };
  tasks = [...tasks, task];
  return task;
}

export function updateDemoTask(id: number, input: ScheduleTaskInput): ScheduleTask {
  const task = { ...input, id };
  tasks = tasks.map((known) => (known.id === id ? task : known));
  return task;
}

export function deleteDemoTask(id: number): void {
  tasks = tasks.filter((task) => task.id !== id);
}

/** Ajoute une séance, ou une par semaine jusqu'à `until` (même heure de mur, d'un changement d'heure à l'autre). */
export function addDemoSessions(input: ScheduleSessionInput): ScheduleSession[] {
  const first = new Date(input.start);
  const length = new Date(input.end).getTime() - first.getTime();
  const last = input.until ? new Date(input.until).getTime() + DAY_MS : first.getTime() + 1;
  const created: ScheduleSession[] = [];
  const seriesId = input.until ? nextSeries++ : undefined;
  for (let start = new Date(first); start.getTime() < last; start.setDate(start.getDate() + 7)) {
    created.push({
      ...input,
      id: nextId++,
      seriesId,
      start: start.toISOString(),
      end: new Date(start.getTime() + length).toISOString(),
    });
  }
  addedSessions = [...addedSessions, ...created];
  return created;
}

/**
 * Modifie une séance, ou toute sa série : les autres occurrences reçoivent le même cours, type et
 * local, et le même décalage d'heure et de jour.
 */
export function updateDemoSessions(
  session: ScheduleSession,
  input: ScheduleSessionInput,
  scope: ScheduleSessionScope
): void {
  const isAdded = addedSessions.some((known) => known.id === session.id);
  const startShift = new Date(input.start).getTime() - new Date(session.start).getTime();
  const endShift = new Date(input.end).getTime() - new Date(session.end).getTime();
  const fields = { courseId: input.courseId, kind: input.kind, room: input.room };
  if (scope === 'one' || session.seriesId == null) {
    // Une seule : elle quitte sa série (une séance fictive passe dans les séances ajoutées).
    const edited: ScheduleSession = {
      ...fields,
      id: session.id,
      start: input.start,
      end: input.end,
    };
    if (isAdded) {
      addedSessions = addedSessions.map((known) => (known.id === session.id ? edited : known));
    } else {
      detached.add(session.id);
      addedSessions = [...addedSessions, edited];
    }
    return;
  }
  const shift = (iso: string, by: number) => new Date(new Date(iso).getTime() + by).toISOString();
  if (isAdded) {
    addedSessions = addedSessions.map((known) =>
      known.seriesId === session.seriesId
        ? {
            ...known,
            ...fields,
            start: shift(known.start, startShift),
            end: shift(known.end, endShift),
            until: known.until ? shift(known.until, startShift) : known.until,
          }
        : known
    );
    return;
  }
  const previous = seriesEdits.get(session.seriesId);
  seriesEdits.set(session.seriesId, {
    ...fields,
    startShift: (previous?.startShift ?? 0) + startShift,
    endShift: (previous?.endShift ?? 0) + endShift,
  });
}

/** Supprime une séance, ou toute sa série. */
export function deleteDemoSessions(session: ScheduleSession, scope: ScheduleSessionScope): void {
  const isAdded = addedSessions.some((known) => known.id === session.id);
  if (scope === 'one' || session.seriesId == null) {
    if (isAdded) addedSessions = addedSessions.filter((known) => known.id !== session.id);
    else detached.add(session.id);
  } else if (isAdded) {
    addedSessions = addedSessions.filter((known) => known.seriesId !== session.seriesId);
  } else {
    seriesEdits.set(session.seriesId, null);
  }
}
