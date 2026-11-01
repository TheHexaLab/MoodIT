import { describe, expect, it } from 'vitest';
import {
  byDueDate,
  daysUntil,
  dueBadge,
  formatDateTime,
  formatExtensions,
  formatHint,
  isAcceptedFile,
  submissionBadge,
} from './assignmentFormat';
import type { Assignment } from '../../../types/domain';

const NOW = new Date(2026, 9, 30, 12, 0);

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: 1,
    courseId: 1,
    title: 'Devoir',
    instructions: '',
    expectedFormats: [],
    files: [],
    isPublished: true,
    submittedCount: 0,
    gradedCount: 0,
    studentCount: 0,
    ...overrides,
  };
}

const inDays = (days: number) => new Date(2026, 9, 30 + days, 23, 59).toISOString();

describe('formats de fichier', () => {
  it('traduit un format connu en ses extensions, et garde un autre format tel quel', () => {
    expect(formatExtensions(['Word', 'PDF', '.PY'])).toEqual(['.doc', '.docx', '.pdf', '.py']);
  });

  it('accepte tout sans format attendu', () => {
    expect(isAcceptedFile('photo.heic', [])).toBe(true);
  });

  it('vérifie l’extension sans tenir compte de la casse', () => {
    expect(isAcceptedFile('RAPPORT.PDF', ['PDF'])).toBe(true);
    expect(isAcceptedFile('rapport.docx', ['PDF', 'ZIP'])).toBe(false);
  });

  it('rédige la consigne selon le nombre de formats', () => {
    expect(formatHint([])).toBe('Tous les formats, 25 Mo au maximum');
    expect(formatHint(['PDF'])).toBe('.pdf, 25 Mo au maximum');
    expect(formatHint(['PDF', 'ZIP'])).toBe('.pdf ou .zip, 25 Mo au maximum');
    expect(formatHint(['Word', 'PDF'])).toBe('.doc, .docx ou .pdf, 25 Mo au maximum');
  });
});

describe('dates', () => {
  it('écrit la date et l’heure à la québécoise', () => {
    expect(formatDateTime(new Date(2026, 10, 3, 23, 59).toISOString())).toBe('3 novembre, 23 h 59');
    expect(formatDateTime(new Date(2026, 10, 3, 8, 5).toISOString())).toBe('3 novembre, 8 h 05');
  });

  it('compte les jours de calendrier, pas les tranches de 24 h', () => {
    expect(daysUntil(new Date(2026, 9, 31, 1, 0).toISOString(), NOW)).toBe(1);
    expect(daysUntil(new Date(2026, 9, 29, 23, 0).toISOString(), NOW)).toBe(-1);
  });

  it('classe d’abord la date la plus proche, et les devoirs sans date à la fin', () => {
    const sorted = [
      assignment({ id: 1 }),
      assignment({ id: 2, dueAt: inDays(9) }),
      assignment({ id: 3, dueAt: inDays(2) }),
    ].sort(byDueDate);
    expect(sorted.map((a) => a.id)).toEqual([3, 2, 1]);
  });
});

describe('pastilles', () => {
  it.each([
    [undefined, 'Sans date limite', 'neutral'],
    [new Date(2026, 9, 30, 8, 0).toISOString(), 'En retard', 'danger'],
    [inDays(0), "Aujourd'hui", 'warn'],
    [inDays(1), 'Demain', 'warn'],
    [inDays(7), 'Dans 7 jours', 'warn'],
    [inDays(8), 'Dans 8 jours', 'neutral'],
  ])('à remettre le %s : %s', (dueAt, label, tone) => {
    expect(dueBadge(assignment({ dueAt }), NOW)).toEqual({ label, tone });
  });

  it('une remise corrigée prime sur le retard', () => {
    const submission = { fileName: 'a.pdf', submittedAt: inDays(0), late: true };
    expect(submissionBadge(assignment({ submission: { ...submission, grade: '17 / 20' } })).label).toBe(
      'Corrigé'
    );
    expect(submissionBadge(assignment({ submission })).label).toBe('En retard');
    expect(submissionBadge(assignment({ submission: { ...submission, late: false } })).label).toBe(
      'Remis'
    );
  });
});
