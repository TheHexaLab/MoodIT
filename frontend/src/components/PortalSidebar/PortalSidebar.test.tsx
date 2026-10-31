import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PortalSidebar from './PortalSidebar';
import type { Course, Program } from '../../types/domain';

afterEach(cleanup);

const programs: Program[] = [
  { id: 1, name: 'Génie logiciel', code: 'GIN', cohort: '', color: '' },
  { id: 2, name: 'Mathématiques', code: 'MAT', cohort: '', color: '' },
];
const course = (id: number, code: string, title: string) => ({ id, code, title }) as Course;

function renderSidebar(overrides: Partial<Parameters<typeof PortalSidebar>[0]> = {}) {
  const props = {
    programs,
    loading: false,
    loadError: null,
    onReload: vi.fn(),
    loadCourses: vi.fn().mockResolvedValue([]),
    onOpenProgram: vi.fn(),
    onOpenCourse: vi.fn(),
    onJoin: vi.fn(),
    userMenu: <span>compte</span>,
    ...overrides,
  };
  render(
    <MemoryRouter>
      <PortalSidebar {...props} />
    </MemoryRouter>
  );
  return props;
}

describe('PortalSidebar', () => {
  it('ouvre un cours et un programme', async () => {
    const props = renderSidebar({
      loadCourses: vi.fn(async (id: number) => (id === 1 ? [course(10, 'IFT101', 'Algo')] : [])),
    });
    fireEvent.click(await screen.findByRole('button', { name: /IFT101/ }));
    expect(props.onOpenCourse).toHaveBeenCalledWith(1, 10);
    fireEvent.click(screen.getByRole('button', { name: 'Mathématiques' }));
    expect(props.onOpenProgram).toHaveBeenCalledWith(2);
  });

  it('un cours présent dans deux programmes n’apparaît qu’une fois', async () => {
    renderSidebar({ loadCourses: vi.fn().mockResolvedValue([course(10, 'IFT101', 'Algo')]) });
    await screen.findByRole('button', { name: /IFT101/ });
    expect(screen.getAllByRole('button', { name: /IFT101/ })).toHaveLength(1);
  });

  it('les cours d’un programme indisponibles : message, programme toujours ouvrable', async () => {
    renderSidebar({ loadCourses: vi.fn().mockRejectedValue(new Error('panne')) });
    expect((await screen.findAllByText("Cours indisponibles pour l'instant."))).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Génie logiciel' })).toBeTruthy();
  });

  it('chargement et erreur de la liste des programmes', () => {
    const props = renderSidebar({ loadError: 'panne' });
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(props.onReload).toHaveBeenCalled();
    cleanup();
    renderSidebar({ loading: true });
    expect(screen.getByRole('status').textContent).toContain('Chargement');
  });

  it('les pages à venir n’ont pas d’action, « Rejoindre un cours » en a une', async () => {
    const props = renderSidebar();
    expect(screen.getByRole('button', { name: 'Horaire' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
    expect(props.onJoin).toHaveBeenCalled();
    await screen.findAllByRole('button');
  });
});
