import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PortalSidebar from './PortalSidebar';
import { ROLE } from '../../helpers/roles';
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
    onJoinProgram: vi.fn(),
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
            onJoinProgram={vi.fn()}
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

  it('pastille d’une page : à côté du libellé, et dans le nom lu', () => {
    renderSidebar({ pageBadges: { factures: 'À payer' } });
    const factures = screen.getByRole('link', { name: 'Factures À payer' });
    expect(factures.querySelector('[class*="pageBadge"]')?.textContent).toBe('À payer');
    // Les autres pages n'en ont pas.
    expect(screen.getByRole('link', { name: 'Horaire' }).querySelector('[class*="pageBadge"]')).toBeNull();
  });

  describe('version réduite', () => {
    it('la pastille devient un point ; son texte passe dans le nom et l’infobulle', () => {
      renderSidebar({ collapsed: true, pageBadges: { factures: 'À payer' } });
      const factures = screen.getByRole('link', { name: 'Factures (à payer)' });
      expect(factures.getAttribute('title')).toBe('Factures (à payer)');
      expect(screen.getByRole('link', { name: 'Bulletin' }).getAttribute('title')).toBe('Bulletin');
    });

    it('les pages et les cours gardent un nom accessible et une infobulle', () => {
      renderSidebar({ collapsed: true });
      expect(screen.getByRole('link', { name: 'Accueil' }).getAttribute('title')).toBe('Accueil');
      expect(screen.getByRole('link', { name: 'Horaire' }).getAttribute('title')).toBe('Horaire');
      expect(screen.getByRole('button', { name: 'IFT101 · Algo' }).getAttribute('title')).toBe('IFT101 · Algo');
    });

    it('un clic sur une tuile ouvre le cours ; le cours ouvert est marqué, pas l’Accueil', () => {
      const props = renderSidebar({ collapsed: true, activeProgramId: 1, selectedCourseId: 10 });
      const tile = screen.getByRole('button', { name: 'IFT101 · Algo' });
      expect(tile.getAttribute('aria-current')).toBe('page');
      expect(screen.getByRole('link', { name: 'Accueil' }).getAttribute('aria-current')).toBeNull();
      fireEvent.click(tile);
      expect(props.onOpenCourse).toHaveBeenCalledWith(1, 10);
    });

    it('un cours sans sigle : les lettres de son titre', () => {
      renderSidebar({
        collapsed: true,
        programs: [{ ...programs[0], courses: [{ id: 11, code: '', title: 'Maths' } as Course] }],
      });
      expect(screen.getByRole('button', { name: 'Maths' }).textContent).toContain('MAT');
    });

    it('un cours de deux programmes s’ouvre par le programme actif', () => {
      const props = renderSidebar({
        collapsed: true,
        activeProgramId: 2,
        programs: [programs[0], { ...programs[1], courses: [course(10, 'IFT101', 'Algo')] }],
      });
      fireEvent.click(screen.getByRole('button', { name: 'IFT101 · Algo' }));
      expect(props.onOpenCourse).toHaveBeenCalledWith(2, 10);
    });

    it('le « + » vise le programme ouvert', () => {
      const onJoinCourses = vi.fn();
      renderSidebar({ collapsed: true, activeProgramId: 2, programActions: { onJoinCourses } });
      fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
      expect(onJoinCourses).toHaveBeenCalledWith(2);
    });

    it('le « + » vise le seul programme, sur l’Accueil', () => {
      const onJoinCourses = vi.fn();
      renderSidebar({ collapsed: true, programs: [programs[0]], programActions: { onJoinCourses } });
      fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
      expect(onJoinCourses).toHaveBeenCalledWith(1);
    });

    it('le « + » déplie la barre s’il y a plusieurs programmes, sans programme ouvert', () => {
      const onToggleCollapsed = vi.fn();
      renderSidebar({ collapsed: true, onToggleCollapsed });
      fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    });

    it('le « + » sans programme rejoint un programme', () => {
      const props = renderSidebar({ collapsed: true, programs: [] });
      fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours' }));
      expect(props.onJoinProgram).toHaveBeenCalled();
    });

    it('chargement et erreur de la liste', () => {
      renderSidebar({ collapsed: true, loading: true });
      expect(screen.getByRole('status', { name: 'Chargement des programmes' })).toBeTruthy();
      cleanup();
      const props = renderSidebar({ collapsed: true, loadError: 'panne' });
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer le chargement des programmes' }));
      expect(props.onReload).toHaveBeenCalled();
    });

    it('le bouton réduire / déplier n’existe que si la barre peut changer (pas sur mobile)', () => {
      const onToggleCollapsed = vi.fn();
      renderSidebar({ onToggleCollapsed });
      fireEvent.click(screen.getByRole('button', { name: 'Réduire le menu' }));
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
      cleanup();
      renderSidebar();
      expect(screen.queryByRole('button', { name: 'Réduire le menu' })).toBeNull();
    });
  });

  it('les pages du portail sont des liens, dans l’ordre, avec Bulletin entre Horaire et Factures', () => {
    renderSidebar();
    const links = within(screen.getByRole('navigation', { name: 'Portail' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Accueil',
      'Horaire',
      'Bulletin',
      'Factures',
      "Centre d'aide",
    ]);
    expect(links[2].getAttribute('href')).toBe('/home/bulletin');
    expect(links[0].getAttribute('aria-current')).toBe('page');
  });

  it('les cours de chaque programme forment un groupe nommé', () => {
    renderSidebar();
    const group = screen.getByRole('group', { name: 'Cours de Génie logiciel' });
    expect(within(group).getByRole('button', { name: /IFT101/ })).toBeTruthy();
  });

  it('la poignée n’existe que sur la barre complète, et si la largeur peut changer', () => {
    renderSidebar();
    expect(screen.queryByRole('separator')).toBeNull();
    cleanup();
    renderSidebar({ onWidthChange: vi.fn() });
    expect(screen.getByRole('separator', { name: 'Redimensionner le menu' })).toBeTruthy();
    cleanup();
    renderSidebar({ onWidthChange: vi.fn(), collapsed: true });
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('la couche de glissement n’existe que le temps de réduire ou déplier la barre', () => {
    vi.useFakeTimers();
    try {
      const sidebar = (collapsed: boolean) => (
        <MemoryRouter>
          <PortalSidebar
            programs={programs}
            loading={false}
            loadError={null}
            onReload={vi.fn()}
            onOpenCourse={vi.fn()}
            onJoinProgram={vi.fn()}
            userMenu={<span>compte</span>}
            collapsed={collapsed}
          />
        </MemoryRouter>
      );
      const { container, rerender } = render(sidebar(false));
      const root = container.firstElementChild!;
      expect(root.className).not.toMatch(/sidebarSliding/);
      rerender(sidebar(true));
      expect(root.className).toMatch(/sidebarSliding/);
      act(() => vi.advanceTimersByTime(300));
      expect(root.className).not.toMatch(/sidebarSliding/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('le « + » de la version réduite est le bouton « Rejoindre un cours » du dernier programme', () => {
    const sidebar = (collapsed: boolean) => (
      <MemoryRouter>
        <PortalSidebar
          programs={programs}
          loading={false}
          loadError={null}
          onReload={vi.fn()}
          onOpenCourse={vi.fn()}
          onJoinProgram={vi.fn()}
          userMenu={<span>compte</span>}
          collapsed={collapsed}
        />
      </MemoryRouter>
    );
    const { rerender } = render(sidebar(false));
    const button = screen.getByRole('button', { name: 'Rejoindre un cours : Mathématiques' });
    rerender(sidebar(true));
    expect(screen.getByRole('button', { name: 'Rejoindre un cours' })).toBe(button);
  });

  it('« Rejoindre un cours » vise son programme, même sans cours', () => {
    const onJoinCourses = vi.fn();
    renderSidebar({ programActions: { onJoinCourses } });
    fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un cours : Mathématiques' }));
    expect(onJoinCourses).toHaveBeenCalledWith(2);
  });

  it('« Ajouter un cours » : seulement si l’utilisateur gère le programme', () => {
    const onAddCourseToProgram = vi.fn();
    renderSidebar({
      programs: [programs[0], { ...programs[1], roleName: ROLE.TEACHER }],
      programActions: { onAddCourseToProgram },
    });
    expect(screen.queryByRole('button', { name: 'Ajouter un cours : Génie logiciel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un cours : Mathématiques' }));
    expect(onAddCourseToProgram).toHaveBeenCalledWith(2);
  });

  it('sur mobile : « Ajouter un programme » ouvre le menu complet', () => {
    const onAddProgram = vi.fn();
    renderSidebar({ onAddProgram });
    expect(screen.queryByRole('button', { name: 'Rejoindre un programme' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un programme' }));
    expect(onAddProgram).toHaveBeenCalledTimes(1);
  });

  it('sans programme : « Rejoindre un programme »', () => {
    const props = renderSidebar({ programs: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Rejoindre un programme' }));
    expect(props.onJoinProgram).toHaveBeenCalled();
  });
});
