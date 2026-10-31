import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { render as rtlRender, screen, fireEvent, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProgramMenu, { type Program } from './ProgramMenu';
import { ROLE } from '../../helpers/roles';

afterEach(cleanup);

/** Le logo du rail est un lien vers l'Accueil : il lui faut un routeur. */
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

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
  const li = screen.getByRole('button', { name: new RegExp(`^${label} — `) }).closest('li');
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
    expect(screen.getByRole('button', { name: 'Génie logiciel — GIN' }).textContent).toBe('GIN');
    // Plusieurs mots → première lettre de chacun (2 max).
    expect(screen.getByRole('button', { name: 'Génie informatique — GI' }).textContent).toBe('GI');
    // Mot unique → deux premières lettres.
    expect(screen.getByRole('button', { name: 'math — MA' }).textContent).toBe('MA');
  });

  it('le nom accessible contient la pastille visible (WCAG 2.5.3)', () => {
    render(<ProgramMenu programs={programs} />);
    const pill = screen.getByRole('button', { name: 'Génie logiciel — GIN' });
    expect(pill.getAttribute('title')).toBe('Génie logiciel');
    // Icône de l'application : lien nommé vers l'Accueil.
    expect(screen.getByRole('link', { name: "Retour à l'Accueil" }).getAttribute('href')).toBe('/home');
  });

  it('le libellé UI (label) a priorité sur le nom', () => {
    render(<ProgramMenu programs={[program({ id: 9, name: 'Nom', label: 'Libellé' })]} />);
    expect(screen.getByRole('button', { name: 'Libellé — LI' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Nom/ })).toBeNull();
  });

  it('marque le programme actif avec aria-current', () => {
    render(<ProgramMenu programs={programs} activeProgramId={2} />);
    expect(screen.getByRole('button', { name: 'Génie informatique — GI' }).getAttribute('aria-current')).toBe(
      'page'
    );
    expect(screen.getByRole('button', { name: 'Génie logiciel — GIN' }).getAttribute('aria-current')).toBeNull();
  });

  it('un clic sur un programme appelle onSelectProgram avec son id', () => {
    const onSelectProgram = vi.fn();
    render(<ProgramMenu programs={programs} onSelectProgram={onSelectProgram} />);
    fireEvent.click(screen.getByRole('button', { name: 'math — MA' }));
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
    expect(screen.queryByRole('button', { name: 'math — MA' })).toBeNull();
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

// Ouverture au clavier (touche Menu / Maj+F10, sur tous les moteurs) et flèches, au clavier réel.
describe('ProgramMenu — menu contextuel au clavier', () => {
  const pill = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label} — `) });

  it('annonce le raccourci d’ouverture sur chaque pastille', () => {
    render(<ProgramMenu programs={programs} />);
    expect(pill('math').getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
  });

  it('Maj+F10 ouvre le menu (focus sur le menu), ↓ mène au premier élément, ↑ au dernier', async () => {
    const user = userEvent.setup();
    render(<ProgramMenu programs={programs} onJoinCourses={vi.fn()} />);
    pill('Génie logiciel').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu');
    expect(document.activeElement).toBe(menu);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rejoindre des cours' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Quitter le programme' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Rejoindre des cours' }));
  });

  it('la touche Menu ouvre aussi le menu ; Entrée active l’élément', async () => {
    const user = userEvent.setup();
    const onLeaveProgram = vi.fn();
    render(<ProgramMenu programs={programs} onLeaveProgram={onLeaveProgram} />);
    pill('math').focus();
    await user.keyboard('{ContextMenu}{ArrowUp}{Enter}');
    expect(onLeaveProgram).toHaveBeenCalledWith(3);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Échap dans le menu le ferme et rend le focus à la pastille', async () => {
    const user = userEvent.setup();
    render(<ProgramMenu programs={programs} />);
    pill('math').focus();
    await user.keyboard('{Shift>}{F10}{/Shift}{ArrowDown}{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(pill('math'));
  });

  it('F10 seule ou une autre touche n’ouvre pas le menu', async () => {
    const user = userEvent.setup();
    render(<ProgramMenu programs={programs} />);
    pill('math').focus();
    await user.keyboard('{F10}a');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
