import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignmentsAvailable,
  createAssignment,
  fetchAssignmentSubmissions,
  fetchAssignments,
  submitAssignment,
  updateAssignment,
} from './dashboardApi.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const DRAFT = {
  title: 'Brouillon',
  instructions: '',
  expectedFormats: [],
  files: [],
  isPublished: false,
};

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
    await expect(updateAssignment(5, -1, DRAFT)).rejects.toThrow('Devoir introuvable');
  });

  it('un brouillon reste caché aux étudiants, et visible pour le prof', async () => {
    const student = await fetchAssignments(6);
    const teacher = await fetchAssignments(6, true);
    expect(student.every((a) => a.isPublished)).toBe(true);
    expect(teacher.some((a) => !a.isPublished)).toBe(true);
  });

  it('crée un devoir en tête, avec un nouvel id, puis l’enregistre', async () => {
    const before = await fetchAssignments(7, true);
    const created = await createAssignment(7, DRAFT);
    expect(before.map((a) => a.id)).not.toContain(created.id);
    expect((await fetchAssignments(7, true))[0].id).toBe(created.id);
    expect((await fetchAssignments(7)).map((a) => a.id)).not.toContain(created.id);

    const published = await updateAssignment(7, created.id, { ...DRAFT, isPublished: true });
    expect(published.isPublished).toBe(true);
    expect((await fetchAssignments(7)).map((a) => a.id)).toContain(created.id);
  });

  it('le suivi suit les compteurs du devoir, sans deux fois le même nom', async () => {
    const assignments = await fetchAssignments(8, true);
    for (const assignment of assignments) {
      const rows = await fetchAssignmentSubmissions(assignment);
      expect(rows).toHaveLength(assignment.studentCount);
      expect(new Set(rows.map((r) => r.studentName)).size).toBe(rows.length);
      expect(rows.filter((r) => r.status === 'missing')).toHaveLength(
        assignment.studentCount - assignment.submittedCount
      );
      expect(rows.filter((r) => r.grade)).toHaveLength(assignment.gradedCount);
    }
  });

  it('une remise n’est en retard que si la date limite est passée', async () => {
    const assignments = await fetchAssignments(9);
    const open = assignments.find((a) => new Date(a.dueAt!) > new Date() && a.submittedCount > 0)!;
    const over = assignments.find(
      (a) => new Date(a.dueAt!) < new Date() && a.gradedCount < a.submittedCount
    )!;
    expect((await fetchAssignmentSubmissions(open)).some((r) => r.status === 'late')).toBe(false);
    expect((await fetchAssignmentSubmissions(over)).some((r) => r.status === 'late')).toBe(true);
  });
});
