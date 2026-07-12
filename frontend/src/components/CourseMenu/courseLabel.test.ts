import { describe, it, expect } from 'vitest';
import { getCourseDisplayLabel } from './courseLabel.ts';
import { type Course } from '../../types/domain.ts';

describe('getCourseDisplayLabel', () => {
  it('privilégie name (rogné) quand il est renseigné', () => {
    const course: Course = { id: 1, name: 'Mon Cours', code: 'GIF456', title: 'Génie' };
    expect(getCourseDisplayLabel(course)).toBe('Mon Cours');
  });

  it('rogne les espaces autour de name', () => {
    const course: Course = { id: 1, name: '   Espacé   ' };
    expect(getCourseDisplayLabel(course)).toBe('Espacé');
  });

  it('ignore un name uniquement composé d\'espaces et retombe sur code · title', () => {
    const course: Course = { id: 1, name: '   ', code: 'GIF456', title: 'Génie' };
    expect(getCourseDisplayLabel(course)).toBe('GIF456 · Génie');
  });

  it('combine code et title quand les deux sont présents (sans name)', () => {
    const course: Course = { id: 1, code: 'GIF456', title: 'Génie logiciel' };
    expect(getCourseDisplayLabel(course)).toBe('GIF456 · Génie logiciel');
  });

  it('rogne code et title dans la combinaison', () => {
    const course: Course = { id: 1, code: '  GIF456  ', title: '  Génie  ' };
    expect(getCourseDisplayLabel(course)).toBe('GIF456 · Génie');
  });

  it('retourne le title seul si code est absent', () => {
    const course: Course = { id: 1, title: 'Génie logiciel' };
    expect(getCourseDisplayLabel(course)).toBe('Génie logiciel');
  });

  it('retourne le title seul si code est vide/espaces', () => {
    const course: Course = { id: 1, title: 'Génie', code: '   ' };
    expect(getCourseDisplayLabel(course)).toBe('Génie');
  });

  it('retourne le code seul si title est absent', () => {
    const course: Course = { id: 1, code: 'GIF456' };
    expect(getCourseDisplayLabel(course)).toBe('GIF456');
  });

  it('retourne le code seul si title est vide/espaces', () => {
    const course: Course = { id: 1, code: 'GIF456', title: '   ' };
    expect(getCourseDisplayLabel(course)).toBe('GIF456');
  });

  it('retombe sur "Cours" quand aucune donnée n\'est fournie', () => {
    const course: Course = { id: 1 };
    expect(getCourseDisplayLabel(course)).toBe('Cours');
  });

  it('retombe sur "Cours" quand tous les champs sont vides ou espaces', () => {
    const course: Course = { id: 1, name: '  ', title: '  ', code: '  ' };
    expect(getCourseDisplayLabel(course)).toBe('Cours');
  });
});
