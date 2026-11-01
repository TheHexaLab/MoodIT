import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignmentsAvailable, fetchAssignments, submitAssignment } from './dashboardApi.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('devoirs : données fictives', () => {
  it('n’existent qu’en développement, jamais en production', () => {
    expect(assignmentsAvailable()).toBe(true);
    vi.stubEnv('DEV', false);
    expect(assignmentsAvailable()).toBe(false);
  });

  it('chaque cours a ses devoirs, et les mêmes d’un appel à l’autre', async () => {
    const first = await fetchAssignments(1);
    const again = await fetchAssignments(1);
    const other = await fetchAssignments(2);

    expect(first.length).toBeGreaterThan(0);
    expect(first.every((a) => a.courseId === 1)).toBe(true);
    expect(again).toEqual(first);
    expect(other.map((a) => a.id)).not.toEqual(first.map((a) => a.id));
  });

  it('une remise s’ajoute au devoir et le remplace au besoin', async () => {
    const [assignment] = (await fetchAssignments(3)).filter((a) => !a.submission);

    const updated = await submitAssignment(3, assignment.id, 'mon.zip');
    expect(updated.submission?.fileName).toBe('mon.zip');
    expect(updated.submission?.late).toBe(false);

    const replaced = await submitAssignment(3, assignment.id, 'corrige.zip');
    expect(replaced.submission?.fileName).toBe('corrige.zip');
    expect((await fetchAssignments(3)).find((a) => a.id === assignment.id)?.submission?.fileName).toBe(
      'corrige.zip'
    );
  });

  it('une remise après la date limite est marquée en retard', async () => {
    const [assignment] = (await fetchAssignments(4)).filter((a) => !a.submission);
    vi.useFakeTimers({ now: new Date(assignment.dueAt!).getTime() + 1000 });

    const updated = await submitAssignment(4, assignment.id, 'tard.zip');
    expect(updated.submission?.late).toBe(true);
  });

  it('refuse un devoir inconnu', async () => {
    await expect(submitAssignment(5, -1, 'x.zip')).rejects.toThrow('Devoir introuvable');
  });
});
