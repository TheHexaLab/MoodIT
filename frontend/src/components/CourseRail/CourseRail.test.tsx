import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CourseRail, { type RailCourse } from './CourseRail';
import type { Course } from '../../types/domain';

afterEach(cleanup);

const courses: RailCourse[] = [
  { programId: 1, course: { id: 10, code: 'MAT115', title: 'Maths' } as Course },
  { programId: 2, course: { id: 11, code: '', title: 'Sans code' } as Course },
];

function renderRail(overrides: Partial<Parameters<typeof CourseRail>[0]> = {}) {
  const onSelectCourse = vi.fn();
  render(
    <MemoryRouter>
      <CourseRail courses={courses} onSelectCourse={onSelectCourse} {...overrides} />
    </MemoryRouter>
  );
  return { onSelectCourse };
}

describe('CourseRail', () => {
  it('la flèche ramène à l’Accueil', () => {
    renderRail();
    expect(screen.getByRole('link', { name: "Retour à l'Accueil" }).getAttribute('href')).toBe('/home');
  });

  it('affiche le code de chaque cours, ou son titre sans code', () => {
    renderRail();
    expect(screen.getByRole('button', { name: 'MAT115' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sans code' })).toBeTruthy();
  });

  it('un clic ouvre le cours par son programme ; le cours ouvert est marqué', () => {
    const { onSelectCourse } = renderRail({ selectedCourseId: 10 });
    expect(screen.getByRole('button', { name: 'MAT115' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Sans code' }));
    expect(onSelectCourse).toHaveBeenCalledWith(2, 11);
  });

  it('chargement : statut à la place de la liste', () => {
    renderRail({ loading: true });
    expect(screen.getByRole('status', { name: 'Chargement des cours' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'MAT115' })).toBeNull();
  });

  it('erreur : bouton pour réessayer', () => {
    const onReload = vi.fn();
    renderRail({ loadError: 'panne', onReload });
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer le chargement des cours' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
