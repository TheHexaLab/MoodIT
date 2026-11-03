import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createScheduleSessions,
  createScheduleTask,
  deleteScheduleTask,
  fetchSchedule,
  fetchScheduleTasks,
  scheduleAvailable,
  updateScheduleTask,
} from './dashboardApi.ts';
import { resetDemoAgenda } from '../../mocks/scheduleData.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  resetDemoAgenda();
});

/** Lundi 0 h de la semaine courante, comme les tâches d'exemple. */
function thisMonday(): Date {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

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

describe('agenda : tâches et séances fictives', () => {
  const task = (start: Date, title = 'Lire') => ({
    title,
    start: start.toISOString(),
    end: new Date(start.getTime() + 3_600_000).toISOString(),
    courseId: null,
    reminder: null,
    notes: '',
    color: 'teal' as const,
    done: false,
  });

  it('trois tâches d’exemple dans la semaine courante, aucune la suivante', async () => {
    const monday = thisMonday();
    expect((await fetchScheduleTasks(monday)).map((t) => t.title)).toEqual(['Tutorat', "Rencontre d'équipe", 'Appel de stage']);
    const next = new Date(monday);
    next.setDate(next.getDate() + 7);
    expect(await fetchScheduleTasks(next)).toEqual([]);
  });

  it('ajoute, modifie et supprime une tâche', async () => {
    const monday = thisMonday();
    const start = new Date(monday);
    start.setHours(9);
    const created = await createScheduleTask(task(start));
    expect((await fetchScheduleTasks(monday)).at(-1)).toEqual(created);

    const updated = await updateScheduleTask(created.id, task(start, 'Relire'));
    expect(updated).toEqual({ ...created, title: 'Relire' });
    expect((await fetchScheduleTasks(monday)).filter((t) => t.id === created.id)).toEqual([updated]);

    await deleteScheduleTask(created.id);
    expect((await fetchScheduleTasks(monday)).some((t) => t.id === created.id)).toBe(false);
  });

  it('une séance ajoutée revient chaque semaine jusqu’à sa date de fin, pour son cours seulement', async () => {
    const courses = [{ id: 10, code: 'INF201', programId: 1 }];
    const monday = new Date(2026, 9, 26);
    const at = (days: number, hour: number) => new Date(2026, 9, 26 + days, hour).toISOString();
    const created = await createScheduleSessions({
      courseId: 10,
      kind: 'Atelier',
      room: 'C1-4016',
      start: at(4, 16),
      end: at(4, 17),
      until: new Date(2026, 10, 13).toISOString(),
    });
    // 30 octobre, 6 et 13 novembre, à 16 h malgré le changement d'heure.
    expect(created.map((s) => new Date(s.start).getDate())).toEqual([30, 6, 13]);
    expect(created.every((s) => new Date(s.start).getHours() === 16 && new Date(s.end).getHours() === 17)).toBe(true);
    expect((await fetchSchedule(monday, courses)).filter((s) => s.kind === 'Atelier')).toHaveLength(1);
    expect(await fetchSchedule(monday, [{ id: 11, code: 'MAT265', programId: 1 }])).not.toContainEqual(created[0]);

    const once = await createScheduleSessions({ courseId: 10, kind: 'Cours', room: 'A', start: at(0, 8), end: at(0, 9), until: null });
    expect(once).toHaveLength(1);
  });
});
