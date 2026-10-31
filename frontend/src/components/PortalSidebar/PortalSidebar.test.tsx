import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PortalSidebar from './PortalSidebar';
import type { Course, Program } from '../../types/domain';

afterEach(cleanup);

const course = (id: number, code: string, title: string) => ({ id, code, title }) as Course;
const programs: Program[] = [
  { id: 1, name: 'Génie logiciel', code: 'GIN', cohort: '', color: '', courses: [course(10, 'IFT101', 'Algo')] },
  { id: 2, name: 'Mathématiques', code: 'MAT', cohort: '', color: '', courses: [] },
];

function renderSidebar(overrides: Partial<Parameters<typeof PortalSidebar>[0]> = {}) {
  const props = {
    programs,
    loading: false,
    loadError: null,
    onReload: vi.fn(),
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
  it('ouvre un cours ; un clic sur un programme ne fait rien', () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: /IFT101/ }));
    expect(props.onOpenCourse).toHaveBeenCalledWith(1, 10);
    fireEvent.click(screen.getByRole('button', { name: /^Mathématiques/ }));
    expect(props.onOpenCourse).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('le clic droit sur un programme ouvre ses actions', () => {
    const onLeaveProgram = vi.fn();
    renderSidebar({ programActions: { onLeaveProgram } });
    const item = screen.getByRole('button', { name: /^Mathématiques/ }).closest('li')!;
    fireEvent.contextMenu(item);
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Quitter le programme' }));
    expect(onLeaveProgram).toHaveBeenCalledWith(2);
  });

  it('un cours présent dans deux programmes n’apparaît qu’une fois', () => {
    renderSidebar({
      programs: [programs[0], { ...programs[1], courses: [course(10, 'IFT101', 'Algo')] }],
    });
    expect(screen.getAllByRole('button', { name: /IFT101/ })).toHaveLength(1);
  });

  it('StrictMode (double rendu) : les cours restent affichés', () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <PortalSidebar
            programs={programs}
            loading={false}
            loadError={null}
            onReload={vi.fn()}
            onOpenCourse={vi.fn()}
            onJoin={vi.fn()}
            userMenu={null}
          />
        </MemoryRouter>
      </StrictMode>
    );
    expect(screen.getByRole('button', { name: /IFT101/ })).toBeTruthy();
  });

  it('les cours d’un programme indisponibles : message', () => {
    renderSidebar({ failedProgramIds: [2] });
    expect(screen.getByText("Cours indisponibles pour l'instant.")).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Mathématiques/ })).toBeTruthy();
  });

  it('erreur de la liste des programmes : réessayer', () => {
    const props = renderSidebar({ loadError: 'panne' });
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer le chargement des programmes' }));
    expect(props.onReload).toHaveBeenCalled();
  });

  it('les pages à venir n’ont pas d’action, « Rejoindre un cours » en a une', () => {
    const props = renderSidebar();
    expect(screen.getByRole('button', { name: 'Horaire' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
    expect(props.onJoin).toHaveBeenCalled();
  });
});
