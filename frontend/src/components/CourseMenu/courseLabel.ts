import { type Course } from './CourseMenu';

/** Libelle d'affichage d'un cours (nom formate, sinon code · titre). */
export function getCourseDisplayLabel(course: Course): string {
  if (course.name?.trim()) return course.name.trim();

  const title = course.title?.trim() ?? '';
  const code = course.code?.trim() ?? '';

  if (code && title) return `${code} · ${title}`;
  return title || code || 'Cours';
}
