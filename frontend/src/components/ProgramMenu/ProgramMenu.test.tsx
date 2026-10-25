import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import ProgramMenu, { type Program } from './ProgramMenu';
import { ROLE } from '../../helpers/roles';

afterEach(cleanup);

function program(overrides: Partial<Program> & { id: number }): Program {
  return { name: `Programme ${overrides.id}`, code: '', cohort: '', color: '', ...overrides };
}

const programs: Program[] = [
  program({ id: 1, name: 'Génie logiciel', code: 'gin', color: '#0d9488' }),
  program({ id: 2, name: 'Génie informatique', roleName: ROLE.TEACHER }),
  program({ id: 3, name: 'math', roleName: ROLE.ADMIN }),
];

/** Ouvre le menu contextuel (clic droit) sur la pastille du programme de libellé donné. */
function openContextMenu(label: string): HTMLElement {
  const li = screen.getByRole('button', { name: label }).closest('li');
  if (!li) throw new Error('élément de liste introuvable');
  fireEvent.contextMenu(li);
  return screen.getByRole('menu');
}

function menuItems(menu: HTMLElement): string[] {
  return within(menu)
    .getAllByRole('menuitem')
    .map((el) => el.textContent?.trim() ?? '');
}

describe('ProgramMenu', () => {
  it('affiche une pastille par programme : code (3 lettres max, majuscules) ou initiales', () => {
    render(<ProgramMenu programs={programs} />);
    expect(screen.getByRole('button', { name: 'Génie logiciel' }).textContent).toBe('GIN');
    // Plusieurs mots → première lettre de chacun (2 max).
    expect(screen.getByRole('button', { name: 'Génie informatique' }).textContent).toBe('GI');
    // Mot unique → deux premières lettres.
    expect(screen.getByRole('button', { name: 'math' }).textContent).toBe('MA');
  });

  it('le libellé UI (label) a priorité sur le nom', () => {
    render(<ProgramMenu programs={[program({ id: 9, name: 'Nom', label: 'Libellé' })]} />);
    expect(screen.getByRole('button', { name: 'Libellé' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nom' })).toBeNull();
  });

  it('marque le programme actif avec aria-current', () => {
    render(<ProgramMenu programs={programs} activeProgramId={2} />);
    expect(screen.getByRole('button', { name: 'Génie informatique' }).getAttribute('aria-current')).toBe(
      'page'
    );
    expect(screen.getByRole('button', { name: 'Génie logiciel' }).getAttribute('aria-current')).toBeNull();
  });

  it('un clic sur un programme appelle onSelectProgram avec son id', () => {
    const onSelectProgram = vi.fn();
    render(<ProgramMenu programs={programs} onSelectProgram={onSelectProgram} />);
    fireEvent.click(screen.getByRole('button', { name: 'math' }));
    expect(onSelectProgram).toHaveBeenCalledWith(3);
  });

  it('le bouton « Ajouter un programme » appelle onAddProgram', () => {
    const onAddProgram = vi.fn();
    render(<ProgramMenu programs={[]} onAddProgram={onAddProgram} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter un programme' }));
    expect(onAddProgram).toHaveBeenCalledTimes(1);
  });

  it('liste vide : aucune pastille de programme', () => {
    render(<ProgramMenu programs={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('chargement : spinner à la place de la liste', () => {
    render(<ProgramMenu programs={programs} loading />);
    expect(screen.getByRole('status', { name: 'Chargement des programmes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'math' })).toBeNull();
  });

  it('erreur : bouton « Réessayer » (titre = message) qui appelle onReload', () => {
    const onReload = vi.fn();
    render(<ProgramMenu programs={programs} loadError="Panne" onReload={onReload} loading />);
    const retry = screen.getByRole('button', { name: 'Réessayer le chargement des programmes' });
    expect(retry.getAttribute('title')).toBe('Panne');
    // L'erreur prime sur le chargement.
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(retry);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  describe('menu contextuel', () => {
    it('sans rôle : seuls « Rejoindre des cours » et « Quitter le programme »', () => {
      render(<ProgramMenu programs={programs} onJoinCourses={vi.fn()} onDeleteProgram={vi.fn()} />);
      const menu = openContextMenu('Génie logiciel');
      expect(menuItems(menu)).toEqual(['Rejoindre des cours', 'Quitter le programme']);
    });

    it('sans onJoinCourses : « Rejoindre des cours » est masqué', () => {
      render(<ProgramMenu programs={programs} />);
      expect(menuItems(openContextMenu('Génie logiciel'))).toEqual(['Quitter le programme']);
    });

    it('enseignant : peut ajouter un cours mais ni modifier ni gérer les rôles', () => {
      render(<ProgramMenu programs={programs} onJoinCourses={vi.fn()} onDeleteProgram={vi.fn()} />);
      expect(menuItems(openContextMenu('Génie informatique'))).toEqual([
        'Ajouter un cours',
        'Rejoindre des cours',
        'Quitter le programme',
      ]);
    });

    it('administrateur du programme : tout sauf supprimer', () => {
      render(<ProgramMenu programs={programs} onDeleteProgram={vi.fn()} />);
      expect(menuItems(openContextMenu('math'))).toEqual([
        'Ajouter un cours',
        'Modifier le programme',
        'Gérer les rôles',
        'Quitter le programme',
      ]);
    });

    it('administrateur global : « Supprimer le programme » en plus (si onDeleteProgram)', () => {
      render(<ProgramMenu programs={programs} isGlobalAdmin onDeleteProgram={vi.fn()} />);
      expect(menuItems(openContextMenu('Génie logiciel'))).toContain('Supprimer le programme');
    });

    it('administrateur global sans onDeleteProgram : pas d’item de suppression', () => {
      render(<ProgramMenu programs={programs} isGlobalAdmin />);
      expect(menuItems(openContextMenu('Génie logiciel'))).not.toContain('Supprimer le programme');
    });

    it('chaque action reçoit l’id du programme ciblé puis referme le menu', () => {
      const handlers = {
        onAddCourseToProgram: vi.fn(),
        onEditProgram: vi.fn(),
        onManageRoles: vi.fn(),
        onDeleteProgram: vi.fn(),
        onJoinCourses: vi.fn(),
        onLeaveProgram: vi.fn(),
      };
      render(<ProgramMenu programs={programs} isGlobalAdmin {...handlers} />);
      const cases: [string, keyof typeof handlers][] = [
        ['Ajouter un cours', 'onAddCourseToProgram'],
        ['Modifier le programme', 'onEditProgram'],
        ['Gérer les rôles', 'onManageRoles'],
        ['Supprimer le programme', 'onDeleteProgram'],
        ['Rejoindre des cours', 'onJoinCourses'],
        ['Quitter le programme', 'onLeaveProgram'],
      ];
      for (const [label, handler] of cases) {
        const menu = openContextMenu('math');
        fireEvent.click(within(menu).getByRole('menuitem', { name: label }));
        expect(handlers[handler]).toHaveBeenCalledWith(3);
        expect(screen.queryByRole('menu')).toBeNull();
      }
    });

    it('le clic droit ne sélectionne pas le programme', () => {
      const onSelectProgram = vi.fn();
      render(<ProgramMenu programs={programs} onSelectProgram={onSelectProgram} />);
      openContextMenu('math');
      expect(onSelectProgram).not.toHaveBeenCalled();
    });

    it('se ferme sur Échap', () => {
      render(<ProgramMenu programs={programs} />);
      openContextMenu('math');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('une autre touche ne le ferme pas', () => {
      render(<ProgramMenu programs={programs} />);
      openContextMenu('math');
      fireEvent.keyDown(window, { key: 'a' });
      expect(screen.queryByRole('menu')).not.toBeNull();
    });

    it('se ferme sur un clic extérieur, mais pas sur un clic dans le menu', () => {
      render(<ProgramMenu programs={programs} />);
      const menu = openContextMenu('math');
      // Clic sur le fond du menu (pas un item) : propagation stoppée → reste ouvert.
      fireEvent.click(menu);
      expect(screen.queryByRole('menu')).not.toBeNull();
      fireEvent.click(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('se ferme au redimensionnement de la fenêtre', () => {
      render(<ProgramMenu programs={programs} />);
      openContextMenu('math');
      fireEvent(window, new Event('resize'));
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
