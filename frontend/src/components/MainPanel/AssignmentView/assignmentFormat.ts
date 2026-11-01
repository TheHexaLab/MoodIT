import type { Assignment } from '../../../types/domain.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Taille maximale d'une remise. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Formats proposés au prof, avec leurs extensions. Un autre format est son extension elle-même. */
export const FILE_FORMATS: Record<string, string[]> = {
  PDF: ['.pdf'],
  ZIP: ['.zip'],
  Word: ['.doc', '.docx'],
  Image: ['.png', '.jpg', '.jpeg'],
};

export function formatExtensions(formats: string[]): string[] {
  return formats.flatMap((format) => FILE_FORMATS[format] ?? [format.toLowerCase()]);
}

/** Le fichier respecte-t-il les formats attendus ? Sans format attendu, tout est accepté. */
export function isAcceptedFile(fileName: string, formats: string[]): boolean {
  if (formats.length === 0) return true;
  const name = fileName.toLowerCase();
  return formatExtensions(formats).some((extension) => name.endsWith(extension));
}

/** « .zip ou .pdf, 25 Mo au maximum » : la consigne affichée sous la zone de dépôt. */
export function formatHint(formats: string[]): string {
  const limit = '25 Mo au maximum';
  if (formats.length === 0) return `Tous les formats, ${limit}`;
  const extensions = formatExtensions(formats);
  const head = extensions.slice(0, -1).join(', ');
  return `${head ? `${head} ou ` : ''}${extensions[extensions.length - 1]}, ${limit}`;
}

/** « 3 novembre, 23 h 59 ». */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long' }).format(date);
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}, ${date.getHours()} h ${minutes}`;
}

/** Jours de calendrier entre `now` et la date (négatif si elle est passée). */
export function daysUntil(iso: string, now: Date): number {
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY_MS);
}

export type Tone = 'success' | 'info' | 'warn' | 'danger' | 'neutral';

export interface Badge {
  label: string;
  tone: Tone;
}

/** Pastille d'un devoir à remettre : ce qui presse (7 jours ou moins) ressort. */
export function dueBadge(assignment: Assignment, now: Date): Badge {
  if (!assignment.dueAt) return { label: 'Sans date limite', tone: 'neutral' };
  if (new Date(assignment.dueAt) < now) return { label: 'En retard', tone: 'danger' };
  const days = daysUntil(assignment.dueAt, now);
  if (days === 0) return { label: "Aujourd'hui", tone: 'warn' };
  if (days === 1) return { label: 'Demain', tone: 'warn' };
  return { label: `Dans ${days} jours`, tone: days <= 7 ? 'warn' : 'neutral' };
}

/** Pastille d'un devoir remis. */
export function submissionBadge(assignment: Assignment): Badge {
  if (assignment.submission?.grade) return { label: 'Corrigé', tone: 'success' };
  if (assignment.submission?.late) return { label: 'En retard', tone: 'danger' };
  return { label: 'Remis', tone: 'neutral' };
}

/** Plus proche date limite d'abord ; un devoir sans date passe à la fin. */
export function byDueDate(a: Assignment, b: Assignment): number {
  return (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999');
}
