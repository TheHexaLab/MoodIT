import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSchedule, scheduleAvailable } from './dashboardApi.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('horaire : données fictives', () => {
  it('n’existe qu’en développement, jamais en production', () => {
    expect(scheduleAvailable()).toBe(true);
    vi.stubEnv('DEV', false);
    expect(scheduleAvailable()).toBe(false);
  });

  it('deux séances par cours, dans la semaine demandée, du lundi au vendredi', async () => {
    const monday = new Date(2026, 9, 26);
    const courses = [
      { id: 10, code: 'INF201', programId: 1 },
      { id: 11, code: 'MAT265', programId: 1 },
    ];
    const sessions = await fetchSchedule(monday, courses);

    expect(sessions).toHaveLength(4);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(4);
    for (const s of sessions) {
      const start = new Date(s.start);
      expect(start >= monday && start < new Date(2026, 9, 31)).toBe(true);
      expect(s.end > s.start).toBe(true);
      expect(start.getHours()).toBeGreaterThanOrEqual(8);
      expect(new Date(s.end).getHours()).toBeLessThanOrEqual(18);
    }
    expect(sessions.filter((s) => s.courseId === 10)).toHaveLength(2);
  });

  it('les mêmes créneaux d’une semaine à l’autre', async () => {
    const courses = [{ id: 10, code: 'INF201', programId: 1 }];
    const a = await fetchSchedule(new Date(2026, 9, 26), courses);
    const b = await fetchSchedule(new Date(2026, 10, 2), courses);
    expect(b.map((s) => new Date(s.start).getDay())).toEqual(a.map((s) => new Date(s.start).getDay()));
    // En jours de calendrier : le changement d'heure du 1er novembre ajoute une heure à l'écart.
    const days = (new Date(b[0].start).getTime() - new Date(a[0].start).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });
});
