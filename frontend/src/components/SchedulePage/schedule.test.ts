import { describe, expect, it } from 'vitest';
import {
  dayIndex,
  dayTitle,
  formatTime,
  isSameDay,
  minutesFromStart,
  placeSessions,
  shortDay,
  startOfWeek,
  weekDays,
  weekLabel,
} from './schedule';
import type { ScheduleSession } from '../../types/domain';

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 9, 26 + day, hour, minute).toISOString();

function session(id: number, day: number, start: [number, number], end: [number, number]): ScheduleSession {
  return { id, courseId: 1, kind: 'Cours', room: 'A', start: at(day, ...start), end: at(day, ...end) };
}

describe('semaine', () => {
  it('ramène n’importe quel jour à son lundi, fin de semaine comprise', () => {
    const monday = new Date(2026, 9, 26);
    for (const day of [26, 28, 30, 31, 1]) {
      const date = new Date(2026, day === 1 ? 10 : 9, day, 15, 0);
      expect(startOfWeek(date).getTime()).toBe(monday.getTime());
    }
  });

  it('donne les cinq jours de cours et leurs étiquettes', () => {
    const days = weekDays(new Date(2026, 9, 26));
    expect(days.map((day, index) => shortDay(day, index))).toEqual([
      'Lun 26',
      'Mar 27',
      'Mer 28',
      'Jeu 29',
      'Ven 30',
    ]);
    expect(dayTitle(days[0])).toBe('Lundi 26 octobre');
  });

  it('écrit la semaine, dans un mois, d’un mois à l’autre et d’une année à l’autre', () => {
    expect(weekLabel(new Date(2026, 9, 26))).toBe('Semaine du 26 au 30 octobre 2026');
    expect(weekLabel(new Date(2026, 10, 30))).toBe('Semaine du 30 novembre au 4 décembre 2026');
    expect(weekLabel(new Date(2026, 11, 28))).toBe('Semaine du 28 décembre 2026 au 1 janvier 2027');
  });

  it('compare des jours, pas des heures', () => {
    expect(isSameDay(new Date(2026, 9, 26, 8), new Date(2026, 9, 26, 23))).toBe(true);
    expect(isSameDay(new Date(2026, 9, 26), new Date(2026, 9, 27))).toBe(false);
  });
});

describe('séances', () => {
  it('écrit l’heure, la position dans la grille et le jour', () => {
    expect(formatTime(at(0, 8, 5))).toBe('8 h 05');
    expect(minutesFromStart(at(0, 10, 30))).toBe(150);
    expect(dayIndex(at(0, 9))).toBe(0);
    expect(dayIndex(at(4, 9))).toBe(4);
    expect(dayIndex(at(5, 9))).toBe(-1);
    expect(dayIndex(at(6, 9))).toBe(-1);
  });

  it('une séance seule prend toute la largeur', () => {
    expect(placeSessions([session(1, 0, [8, 30], [10, 0])])).toEqual([
      expect.objectContaining({ lane: 0, lanes: 1 }),
    ]);
  });

  it('deux séances qui se chevauchent se partagent la colonne ; la suivante la reprend toute', () => {
    const placed = placeSessions([
      session(3, 0, [13, 0], [14, 0]),
      session(2, 0, [9, 0], [11, 0]),
      session(1, 0, [8, 30], [10, 0]),
    ]);
    const byId = Object.fromEntries(placed.map((p) => [p.session.id, p]));
    expect(byId[1]).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId[2]).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId[3]).toMatchObject({ lane: 0, lanes: 1 });
  });

  it('un couloir libéré se réutilise dans le même groupe', () => {
    const placed = placeSessions([
      session(1, 0, [8, 0], [12, 0]),
      session(2, 0, [8, 30], [9, 30]),
      session(3, 0, [10, 0], [11, 0]),
    ]);
    const byId = Object.fromEntries(placed.map((p) => [p.session.id, p]));
    expect(byId[3]).toMatchObject({ lane: 1, lanes: 2 });
  });
});
