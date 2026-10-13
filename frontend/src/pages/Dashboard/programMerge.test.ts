import { describe, expect, it } from 'vitest';
import { type DemoProgram } from './dashboardApi.ts';
import { mergeProgramsKeepingCourses } from './programMerge.ts';
import { type Course } from '../../components/CourseMenu/CourseMenu';

const program = (id: number, courses: Course[] = [], name = `P${id}`): DemoProgram => ({
  id,
  name,
  code: `C${id}`,
  cohort: '2026',
  color: '#000',
  courses,
});
const course = { id: 1, title: 'MAT115' } as unknown as Course;

describe('mergeProgramsKeepingCourses', () => {
  it('garde les cours déjà chargés quand la liste des programmes revient APRÈS eux', () => {
    const current = [program(1, [course])];
    const fresh = [program(1, [], 'Génie informatique (renommé)')];
    const merged = mergeProgramsKeepingCourses(current, fresh);
    expect(merged[0].courses).toEqual([course]);
    expect(merged[0].name).toBe('Génie informatique (renommé)'); // métadonnées à jour
  });

  it('ajoute les nouveaux programmes et retire ceux qui ont disparu', () => {
    const merged = mergeProgramsKeepingCourses([program(1, [course]), program(2)], [program(1), program(3)]);
    expect(merged.map((p) => p.id)).toEqual([1, 3]);
    expect(merged[1].courses).toEqual([]);
  });
});
