import type {
  ScheduleColor,
  ScheduleSession,
  ScheduleSessionInput,
  ScheduleTask,
  ScheduleTaskInput,
} from '../../types/domain.ts';

/** Heures de la grille : toute la journée ; elle défile, ouverte sur le matin. */
export const FIRST_HOUR = 0;
export const LAST_HOUR = 24;
/** Fin au plus tard d'un événement : 23 h 45, pour rester dans sa journée. */
export const DAY_END = LAST_HOUR * 60 - 15;
/** Heure où la grille s'ouvre, sauf événement plus tôt dans la semaine. */
export const OPENING_HOUR = 8;

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Dimanche 0 h de la semaine de `date` : la semaine va du dimanche au samedi. */
export function startOfWeek(date: Date): Date {
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return sunday;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Les sept jours de la semaine qui commence au dimanche `weekStart`, jusqu'au samedi. */
export function weekDays(weekStart: Date): Date[] {
  return [0, 1, 2, 3, 4, 5, 6].map((offset) => addDays(weekStart, offset));
}

/** « Lun 26 ». */
export function shortDay(date: Date, index: number): string {
  const name = DAY_NAMES[index];
  return `${name.charAt(0).toUpperCase()}${name.slice(1, 3)} ${date.getDate()}`;
}

/** « lundi 26 octobre » : pour les lecteurs d'écran et l'affichage mobile. */
export function longDay(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
}

/** « Lundi 26 octobre » : un titre commence par une majuscule. */
export function dayTitle(date: Date): string {
  const label = longDay(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const month = (date: Date) => new Intl.DateTimeFormat('fr-CA', { month: 'long' }).format(date);

/** « Semaine du 1 au 7 novembre 2026 », ou « du 29 novembre au 5 décembre 2026 » d'un mois à l'autre. */
export function weekLabel(weekStart: Date): string {
  const saturday = addDays(weekStart, 6);
  const end = `${saturday.getDate()} ${month(saturday)} ${saturday.getFullYear()}`;
  if (weekStart.getMonth() === saturday.getMonth())
    return `Semaine du ${weekStart.getDate()} au ${end}`;
  const sameYear = weekStart.getFullYear() === saturday.getFullYear();
  return `Semaine du ${weekStart.getDate()} ${month(weekStart)}${sameYear ? '' : ` ${weekStart.getFullYear()}`} au ${end}`;
}

/** « 14 h », ou « 14 h 30 ». */
export function formatShortTime(iso: string): string {
  const date = new Date(iso);
  const minutes = date.getMinutes();
  return minutes
    ? `${date.getHours()} h ${String(minutes).padStart(2, '0')}`
    : `${date.getHours()} h`;
}

/** « 14 h – 15 h 30 ». */
export function formatRange(start: string, end: string): string {
  return `${formatShortTime(start)} – ${formatShortTime(end)}`;
}

/** « Mer. 4 nov. ». */
export function shortDate(iso: string): string {
  const label = new Intl.DateTimeFormat('fr-CA', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** « 8 h 30 ». */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${date.getHours()} h ${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Minutes depuis 8 h : la position verticale d'une séance dans la grille. */
export function minutesFromStart(iso: string): number {
  const date = new Date(iso);
  return (date.getHours() - FIRST_HOUR) * 60 + date.getMinutes();
}

/** Indice du jour : 0 = dimanche, 6 = samedi. */
export function dayIndex(iso: string): number {
  return new Date(iso).getDay();
}

/** Événement de la grille : une séance ou une tâche, réduit à ses heures. */
interface Timed {
  start: string;
  end: string;
}

export type DragMode = 'move' | 'resize';

/** Minutes depuis minuit, en heure locale. */
const minutesOfDay = (iso: string) => {
  const date = new Date(iso);
  return date.getHours() * 60 + date.getMinutes();
};

/**
 * Tâche glissée de `delta` minutes : déplacée (et changée de jour de `dayShift`) ou allongée par
 * le bas. Elle reste dans la grille et dure au moins un quart d'heure.
 */
export function shiftTimes(times: Timed, mode: DragMode, delta: number, dayShift: number): Timed {
  const start = minutesOfDay(times.start);
  const end = minutesOfDay(times.end);
  const at = (minutes: number) => {
    const date = new Date(times.start);
    date.setDate(date.getDate() + (mode === 'move' ? dayShift : 0));
    date.setHours(0, minutes, 0, 0);
    return date.toISOString();
  };
  if (mode === 'resize') {
    return { start: times.start, end: at(Math.min(Math.max(end + delta, start + 15), DAY_END)) };
  }
  const length = end - start;
  const moved = Math.min(Math.max(start + delta, FIRST_HOUR * 60), DAY_END - length);
  return { start: at(moved), end: at(moved + length) };
}

export interface Placed<T extends Timed> {
  item: T;
  /** Profondeur dans la cascade : un événement qui en chevauche un autre se décale d'un cran
   *  vers la droite, par-dessus, pour que le début de chacun reste lisible. */
  depth: number;
  /** Minutes visibles avant qu'un événement plus tardif ne le recouvre ; sa durée s'il n'y en a pas. */
  visible: number;
}

/** Place les événements d'une journée en cascade, du plus tôt au plus tard. */
export function placeItems<T extends Timed>(items: T[]): Placed<T>[] {
  // À début égal, le plus long passe dessous : le plus court reste entier par-dessus.
  const sorted = [...items].sort(
    (a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end)
  );
  const placed: Placed<T>[] = [];
  const minutes = (from: string, to: string) =>
    (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
  for (const item of sorted) {
    const covered = placed.filter((p) => p.item.end > item.start);
    for (const p of covered) p.visible = Math.min(p.visible, minutes(p.item.start, item.start));
    placed.push({
      item,
      depth: covered.length === 0 ? 0 : Math.max(...covered.map((p) => p.depth)) + 1,
      visible: minutes(item.start, item.end),
    });
  }
  return placed;
}

// ── Couleurs : une teinte par cours ou par tâche, que le thème éclaircit ou fonce ──

/** Teinte et saturation HSL ; la luminosité vient du thème (--badge-hue-lightness). */
export const COLORS: Record<ScheduleColor, { label: string; hue: number; saturation: number }> = {
  teal: { label: 'Sarcelle', hue: 174, saturation: 62 },
  blue: { label: 'Bleu', hue: 220, saturation: 62 },
  purple: { label: 'Violet', hue: 258, saturation: 52 },
  rose: { label: 'Rose', hue: 345, saturation: 62 },
  orange: { label: 'Orange', hue: 18, saturation: 92 },
  green: { label: 'Vert', hue: 142, saturation: 58 },
  gray: { label: 'Gris', hue: 240, saturation: 10 },
};

export const COLOR_KEYS = Object.keys(COLORS) as ScheduleColor[];

/** Couleur des séances d'un cours, stable d'une semaine à l'autre. */
const COURSE_COLORS: ScheduleColor[] = ['teal', 'gray', 'orange', 'blue', 'purple'];

export function courseColor(courseId: number): ScheduleColor {
  return COURSE_COLORS[courseId % COURSE_COLORS.length];
}

// ── Formulaire : brouillon d'une tâche ou d'une séance ──

export type DraftKind = 'task' | 'session';

/** Champs du formulaire, en texte comme les contrôles : dates « 2026-11-05 », heures « 13:30 ». */
export interface Draft {
  kind: DraftKind;
  title: string;
  date: string;
  start: string;
  end: string;
  courseId: number | null;
  reminder: number | null;
  notes: string;
  color: ScheduleColor;
  done: boolean;
  /** Tâche : toute la journée, sans heure. */
  allDay: boolean;
  /** Tâche : une remise, à une seule heure (`start`). */
  deadline: boolean;
  /** Séance : type, local et répétition. */
  sessionKind: string;
  room: string;
  weekly: boolean;
  until: string;
}

export const SESSION_KINDS = ['Cours', 'Travaux dirigés', 'Laboratoire', 'Atelier', 'Tutorat'];

const KIND_TAGS: Record<string, string> = { 'Travaux dirigés': 'TD', Laboratoire: 'Labo' };

/** Étiquette courte du type d'une séance, pour la pastille du bloc : « Labo », « TD », « Cours »… */
export function kindTag(kind: string): string {
  return KIND_TAGS[kind] ?? kind;
}

export const REMINDERS: { value: number | null; label: string }[] = [
  { value: null, label: 'Aucun rappel' },
  { value: 10, label: '10 minutes avant' },
  { value: 30, label: '30 minutes avant' },
  { value: 60, label: '1 heure avant' },
  { value: 1440, label: '1 jour avant' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** « 2026-11-05 », en heure locale. */
export function toDateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** « 13:30 », en heure locale. */
export function toTimeInput(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Date ISO du jour `date` à l'heure `time` (heure locale). */
export function toIso(date: string, time = '00:00'): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes).toISOString();
}

/** Heures proposées : de 0 h à 23 h 45, au quart d'heure. */
export const TIME_OPTIONS = Array.from({ length: (DAY_END - FIRST_HOUR * 60) / 15 + 1 }, (_, i) => {
  const minutes = FIRST_HOUR * 60 + i * 15;
  return {
    value: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
    label: `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`,
  };
});

/** Échéance d'une remise : les mêmes heures, plus 23 h 59. */
export const DEADLINE_OPTIONS = [...TIME_OPTIONS, { value: '23:59', label: '23 h 59' }];

/** Brouillon vide : le jour donné, l'heure qui suit, d'une heure. */
export function emptyDraft(
  kind: DraftKind,
  day: Date,
  hour: number,
  courseId: number | null
): Draft {
  const start = Math.min(Math.max(hour, FIRST_HOUR), LAST_HOUR - 2);
  return {
    kind,
    title: '',
    date: toDateInput(day),
    start: `${pad(start)}:00`,
    end: `${pad(start + 1)}:00`,
    courseId,
    reminder: null,
    notes: '',
    color: 'teal',
    done: false,
    allDay: false,
    deadline: false,
    sessionKind: SESSION_KINDS[0],
    room: '',
    weekly: false,
    until: '',
  };
}

export function taskDraft(task: ScheduleTask): Draft {
  const base = emptyDraft('task', new Date(task.start), 9, task.courseId);
  return {
    ...base,
    title: task.title,
    // Sans heure : les heures proposées si l'utilisateur décoche « Toute la journée ».
    start: task.allDay ? base.start : toTimeInput(task.start),
    end: task.allDay ? base.end : toTimeInput(task.end),
    reminder: task.reminder,
    notes: task.notes,
    color: task.color,
    done: task.done,
    allDay: task.allDay,
    deadline: task.deadline,
  };
}

/** Brouillon d'une séance à modifier ; sa répétition ne change pas ici. */
export function sessionDraft(session: ScheduleSession): Draft {
  return {
    ...emptyDraft('session', new Date(session.start), 9, session.courseId),
    start: toTimeInput(session.start),
    end: toTimeInput(session.end),
    sessionKind: session.kind,
    room: session.room,
  };
}

/** Ce qui empêche d'enregistrer le brouillon, ou null. */
export function draftError(draft: Draft): string | null {
  if (draft.kind === 'task' && !draft.title.trim()) return 'Donnez un titre à la tâche.';
  if (draft.kind === 'session' && draft.courseId == null) return 'Choisissez un cours.';
  if (!draft.date) return 'Choisissez une date.';
  const timed = !(draft.kind === 'task' && (draft.allDay || draft.deadline));
  if (timed && draft.end <= draft.start) return 'La fin doit suivre le début.';
  if (draft.kind === 'session' && !draft.sessionKind.trim()) return 'Choisissez un type de séance.';
  if (draft.kind === 'session' && !draft.room.trim()) return 'Indiquez le local.';
  if (draft.kind === 'session' && draft.weekly && (!draft.until || draft.until < draft.date)) {
    return 'La répétition doit finir après la première séance.';
  }
  return null;
}

export function draftToTask(draft: Draft): ScheduleTaskInput {
  return {
    title: draft.title.trim(),
    start: toIso(draft.date, draft.allDay ? '00:00' : draft.start),
    // Une remise n'a qu'une heure : la fin vaut l'échéance.
    end: toIso(draft.date, draft.allDay ? '00:00' : draft.deadline ? draft.start : draft.end),
    courseId: draft.courseId,
    reminder: draft.reminder,
    notes: draft.notes.trim(),
    color: draft.color,
    done: draft.done,
    allDay: draft.allDay && !draft.deadline,
    deadline: draft.deadline,
  };
}

export function draftToSession(draft: Draft): ScheduleSessionInput {
  return {
    courseId: draft.courseId as number,
    kind: draft.sessionKind.trim(),
    room: draft.room.trim(),
    start: toIso(draft.date, draft.start),
    end: toIso(draft.date, draft.end),
    until: draft.weekly ? toIso(draft.until) : null,
  };
}
