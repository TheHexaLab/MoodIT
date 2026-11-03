import type {
  ScheduleCourse,
  ScheduleSession,
  ScheduleSessionInput,
  ScheduleTask,
  ScheduleTaskInput,
} from '../types/domain.ts';

/** Créneaux de la semaine fictive : jour (0 = lundi), début et fin en minutes depuis minuit. */
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
  return courses.flatMap((course, index) =>
    [0, 1].map((half) => {
      const slot = SLOTS[(index * 2 + half) % SLOTS.length];
      const at = (minutes: number) => {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + slot.day);
        date.setHours(0, minutes, 0, 0);
        return date.toISOString();
      };
      return {
        id: course.id * 10 + half,
        courseId: course.id,
        kind: half === 0 ? 'Cours' : KINDS[(index + 1) % KINDS.length],
        room: ROOMS[(index + half) % ROOMS.length],
        start: at(slot.start),
        end: at(slot.end),
      };
    })
  ).concat(added);
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
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + day);
  monday.setMinutes(minutes);
  return monday.toISOString();
}

function seedTasks(): ScheduleTask[] {
  const task = (id: number, title: string, day: number, start: number, end: number, color: ScheduleTask['color']) => ({
    id,
    title,
    start: thisWeekAt(day, start),
    end: thisWeekAt(day, end),
    courseId: null,
    reminder: null,
    notes: '',
    color,
  });
  return [
    task(1, 'Tutorat', 2, 14 * 60, 15 * 60, 'rose'),
    task(2, "Rencontre d'équipe", 2, 14 * 60 + 30, 15 * 60 + 30, 'gray'),
    task(3, 'Appel de stage', 4, 14 * 60, 15 * 60, 'green'),
  ];
}

let tasks: ScheduleTask[] = seedTasks();
let addedSessions: ScheduleSession[] = [];
let nextId = 1000;

/** Remet l'agenda fictif à son état de départ (tests). */
export function resetDemoAgenda(): void {
  tasks = seedTasks();
  addedSessions = [];
  nextId = 1000;
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
  for (let start = new Date(first); start.getTime() < last; start.setDate(start.getDate() + 7)) {
    created.push({
      ...input,
      id: nextId++,
      start: start.toISOString(),
      end: new Date(start.getTime() + length).toISOString(),
    });
  }
  addedSessions = [...addedSessions, ...created];
  return created;
}
