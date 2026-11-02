import type { ScheduleSession } from '../../types/domain.ts';

/** Heures affichées dans la grille : de 8 h à 18 h. */
export const FIRST_HOUR = 8;
export const LAST_HOUR = 18;

const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'];

/** Lundi 0 h de la semaine de `date` ; un samedi ou un dimanche donne le lundi qui précède. */
export function startOfWeek(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

/** Les cinq jours de cours de la semaine qui commence à `monday`. */
export function weekDays(monday: Date): Date[] {
  return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
}

/** « Lun 26 ». */
export function shortDay(date: Date, index: number): string {
  const name = DAY_NAMES[index];
  return `${name.charAt(0).toUpperCase()}${name.slice(1, 3)} ${date.getDate()}`;
}

/** « lundi 26 octobre » : pour les lecteurs d'écran et l'affichage mobile. */
export function longDay(date: Date): string {
  return new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long' }).format(
    date
  );
}

/** « Lundi 26 octobre » : un titre commence par une majuscule. */
export function dayTitle(date: Date): string {
  const label = longDay(date);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

const month = (date: Date) => new Intl.DateTimeFormat('fr-CA', { month: 'long' }).format(date);

/** « Semaine du 26 au 30 octobre 2026 », ou « du 30 novembre au 4 décembre 2026 » d'un mois à l'autre. */
export function weekLabel(monday: Date): string {
  const friday = addDays(monday, 4);
  const end = `${friday.getDate()} ${month(friday)} ${friday.getFullYear()}`;
  if (monday.getMonth() === friday.getMonth()) return `Semaine du ${monday.getDate()} au ${end}`;
  const sameYear = monday.getFullYear() === friday.getFullYear();
  return `Semaine du ${monday.getDate()} ${month(monday)}${sameYear ? '' : ` ${monday.getFullYear()}`} au ${end}`;
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

/** Indice du jour (0 = lundi) ; -1 en fin de semaine. */
export function dayIndex(iso: string): number {
  const day = new Date(iso).getDay();
  return day === 0 || day === 6 ? -1 : day - 1;
}

export interface PlacedSession {
  session: ScheduleSession;
  /** Couloir de la séance et nombre de couloirs de son groupe : deux séances qui se chevauchent
   *  se partagent la largeur de la colonne. */
  lane: number;
  lanes: number;
}

/** Place les séances d'une journée en couloirs, pour qu'aucune ne cache l'autre. */
export function placeSessions(sessions: ScheduleSession[]): PlacedSession[] {
  const sorted = [...sessions].sort((a, b) => a.start.localeCompare(b.start));
  const placed: PlacedSession[] = [];
  let group: PlacedSession[] = [];
  let groupEnd = '';
  const closeGroup = () => {
    const lanes = Math.max(1, ...group.map((p) => p.lane + 1));
    for (const p of group) p.lanes = lanes;
    group = [];
  };
  for (const session of sorted) {
    if (group.length > 0 && session.start >= groupEnd) closeGroup();
    const busy = new Set(group.filter((p) => p.session.end > session.start).map((p) => p.lane));
    let lane = 0;
    while (busy.has(lane)) lane += 1;
    const entry = { session, lane, lanes: 1 };
    group.push(entry);
    placed.push(entry);
    // Une séance plus tardive que tout le groupe repousse sa fin ; au départ, groupEnd vaut ''.
    if (session.end > groupEnd) groupEnd = session.end;
  }
  closeGroup();
  return placed;
}
