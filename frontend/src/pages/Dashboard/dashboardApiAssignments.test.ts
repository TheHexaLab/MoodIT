import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assignmentsAvailable,
  createAssignment,
  fetchAssignmentSubmissions,
  fetchAssignmentTeams,
  fetchAssignments,
  fetchSubmission,
  createAssignmentTeam,
  gradeSubmission,
  joinAssignmentTeam,
  leaveAssignmentTeam,
  saveAssignmentTeams,
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

    const updated = await submitAssignment(3, assignment.id, ['mon.zip']);
    expect(updated.submission?.fileNames).toEqual(['mon.zip']);
    expect(updated.submission?.late).toBe(false);

    const replaced = await submitAssignment(3, assignment.id, ['corrige.zip']);
    expect(replaced.submission?.fileNames).toEqual(['corrige.zip']);
    expect((await fetchAssignments(3)).find((a) => a.id === assignment.id)?.submission?.fileNames).toEqual(['corrige.zip']);
  });

  it('une remise après la date limite est marquée en retard', async () => {
    const [assignment] = (await fetchAssignments(4)).filter((a) => !a.submission);
    vi.useFakeTimers({ now: new Date(assignment.dueAt!).getTime() + 1000 });

    const updated = await submitAssignment(4, assignment.id, ['tard.zip']);
    expect(updated.submission?.late).toBe(true);
  });

  it('refuse un devoir inconnu', async () => {
    await expect(submitAssignment(5, -1, ['x.zip'])).rejects.toThrow('Devoir introuvable');
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

  it('une note s’enregistre, compte une seule fois, et se retrouve au rechargement', async () => {
    const assignment = (await fetchAssignments(20)).find(
      (a) => !a.teamSize && a.submittedCount > a.gradedCount
    )!;
    const before = assignment.gradedCount;
    const row = (await fetchAssignmentSubmissions(assignment)).find((r) => r.status === 'submitted')!;

    const graded = await gradeSubmission(20, row.id, { score: 16.5, comment: 'Bien' });
    expect(graded).toMatchObject({ status: 'graded', grade: '16.5 / 20', comment: 'Bien' });
    expect(assignment.gradedCount).toBe(before + 1);

    await gradeSubmission(20, row.id, { score: 18, comment: '' });
    expect(assignment.gradedCount).toBe(before + 1);
    const { rows } = await fetchSubmission(20, row.id);
    expect(rows.find((r) => r.id === row.id)?.grade).toBe('18 / 20');
  });

  it('refuse de noter une remise inconnue ou manquante', async () => {
    const assignment = (await fetchAssignments(21)).find(
      (a) => !a.teamSize && a.submittedCount > 0 && a.submittedCount < a.studentCount
    )!;
    const missing = (await fetchAssignmentSubmissions(assignment)).find(
      (r) => r.status === 'missing'
    )!;
    const grade = { score: 1, comment: '' };
    await expect(gradeSubmission(21, missing.id, grade)).rejects.toThrow('Remise introuvable');
    await expect(gradeSubmission(21, 1, grade)).rejects.toThrow('Remise introuvable');
  });

  it('équipes du prof : tout le cours est réparti, et l’étudiant fictif a la sienne', async () => {
    const assignment = (await fetchAssignments(22)).find((a) => a.teamFormation === 'teacher')!;
    const { teams, unassigned } = await fetchAssignmentTeams(22, assignment.id);
    expect(unassigned).toEqual([]);
    expect(assignment.studentCount).toBe(teams.length);
    expect(assignment.team?.members).toContain('Camille Lavoie');

    const rows = await fetchAssignmentSubmissions(assignment);
    expect(rows.map((r) => r.studentName)).toEqual(teams.map((t) => t.name));
    expect(rows[0].members).toEqual(teams[0].members);
  });

  it('équipes des étudiants : rejoindre, quitter, créer ; une équipe vide disparaît', async () => {
    const assignment = (await fetchAssignments(23)).find((a) => a.teamFormation === 'students')!;
    expect(assignment.team).toBeUndefined();
    const { teams, unassigned } = await fetchAssignmentTeams(23, assignment.id);
    expect(unassigned).toContain('Camille Lavoie');
    const open = teams.find((t) => t.members.length < assignment.teamSize!)!;
    const full = teams.find((t) => t.members.length >= assignment.teamSize!)!;

    await expect(joinAssignmentTeam(23, assignment.id, full.id)).rejects.toThrow('Équipe complète');
    await joinAssignmentTeam(23, assignment.id, open.id);
    expect(assignment.team?.id).toBe(open.id);

    await leaveAssignmentTeam(23, assignment.id);
    expect(assignment.team).toBeUndefined();

    const created = await createAssignmentTeam(23, assignment.id);
    expect(created.team?.members).toEqual(['Camille Lavoie']);
    const createdId = created.team!.id;
    await leaveAssignmentTeam(23, assignment.id);
    const after = await fetchAssignmentTeams(23, assignment.id);
    expect(after.teams.map((t) => t.id)).not.toContain(createdId);
  });

  it('le prof enregistre les équipes : les nouvelles reçoivent un id, le suivi suit', async () => {
    const assignment = (await fetchAssignments(24)).find((a) => a.teamFormation === 'students')!;
    const { teams } = await fetchAssignmentTeams(24, assignment.id);
    await saveAssignmentTeams(24, assignment.id, [
      ...teams,
      { id: -1, name: 'Équipe neuve', members: ['Camille Lavoie'] },
    ]);

    const saved = (await fetchAssignmentTeams(24, assignment.id)).teams;
    const added = saved.find((t) => t.name === 'Équipe neuve')!;
    expect(added.id).toBeGreaterThan(0);
    expect(assignment.team?.id).toBe(added.id);
    expect(assignment.studentCount).toBe(saved.length);
    const rows = await fetchAssignmentSubmissions(assignment);
    expect(rows.find((r) => r.id === added.id)?.status).toBe('missing');
  });

  it('un devoir individuel n’a pas d’équipes', async () => {
    const individual = (await fetchAssignments(25)).find((a) => !a.teamSize)!;
    await expect(fetchAssignmentTeams(25, individual.id)).rejects.toThrow(
      'Devoir en équipe introuvable'
    );
  });

  it('passer entre individuel et équipe remet le suivi à zéro', async () => {
    const individual = (await fetchAssignments(26)).find((a) => !a.teamSize)!;
    await fetchAssignmentSubmissions(individual);

    await updateAssignment(26, individual.id, {
      ...DRAFT,
      isPublished: true,
      teamSize: 3,
      teamFormation: 'students',
    });
    expect(individual.studentCount).toBe(0);
    expect(await fetchAssignmentSubmissions(individual)).toEqual([]);

    await updateAssignment(26, individual.id, { ...DRAFT, isPublished: true, teamSize: undefined });
    expect(individual.studentCount).toBe(32);
    expect(await fetchAssignmentSubmissions(individual)).toHaveLength(32);
  });

  it('une remise d’équipe note qui l’a déposée', async () => {
    const assignment = (await fetchAssignments(27)).find((a) => a.teamFormation === 'teacher')!;
    const updated = await submitAssignment(27, assignment.id, ['a.zip']);
    expect(updated.submission?.submittedBy).toBe('Vous');
  });

  it('un devoir en équipe créé ne compte aucune équipe', async () => {
    const created = await createAssignment(28, {
      ...DRAFT,
      teamSize: 4,
      teamFormation: 'teacher',
    });
    expect(created.studentCount).toBe(0);
    expect((await fetchAssignmentTeams(28, created.id)).teams).toEqual([]);
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
