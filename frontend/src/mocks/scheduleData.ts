import type { ScheduleCourse, ScheduleSession } from '../types/domain.ts';

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
  );
}
