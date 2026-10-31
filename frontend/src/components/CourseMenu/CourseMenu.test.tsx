import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CourseMenu, { type Course } from './CourseMenu';
import { defaultLabels } from './labels';
import { ThemeContext, type ThemeApi } from '../../context/themeContext';
import { CurrentUserContext, type CurrentUserApi } from '../../context/currentUserContext';
import type { Program } from '../ProgramMenu/ProgramMenu';

// L'éditeur de quiz riche est remplacé par une doublure : on vérifie seulement que le
// crayon de la section quiz l'ouvre avec le bon cours (l'éditeur a ses propres tests).
const quizEditorProps = vi.fn();
vi.mock('../QuizEditor/QuizEditor.tsx', () => ({
  QuizEditor: (props: { courseId: number; onQuizzesChange?: (q: unknown[]) => void }) => {
    quizEditorProps(props);
    return (
      <button type="button" onClick={() => props.onQuizzesChange?.([{ id: 99, title: 'Nouveau' }])}>
        doublure-quiz-editor
      </button>
    );
  },
}));

beforeEach(() => {
  localStorage.clear();
  quizEditorProps.mockClear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const program: Program = { id: 1, name: 'Génie', code: 'GIN', cohort: '', color: '', label: 'Génie logiciel' };

const courses: Course[] = [
  {
    id: 10,
    code: 'IFT101',
    title: 'Programmation',
    forums: [
      { id: 1, title: 'general', fType: 'Discussion' },
      { id: 2, title: 'entraide', fType: 'Thread' },
    ],
    quizzes: [{ id: 1, title: 'Quiz intro' }],
  },
  { id: 20, code: 'MAT200', title: 'Algèbre' },
  { id: 30, name: 'Cours sans code' },
];

function renderMenu(props: Partial<React.ComponentProps<typeof CourseMenu>> = {}) {
  const themeValue: ThemeApi = { theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
  const userValue = { saveSettings: vi.fn() } as unknown as CurrentUserApi;
  return render(
    <ThemeContext.Provider value={themeValue}>
      <CurrentUserContext.Provider value={userValue}>
        <MemoryRouter>
          <CourseMenu activeProgram={program} courses={courses} {...props} />
        </MemoryRouter>
      </CurrentUserContext.Provider>
    </ThemeContext.Provider>
  );
}

/** Sélecteur de cours (bouton à listbox). */
function selector(): HTMLElement {
  const el = document.querySelector<HTMLElement>('nav[aria-label="Cours"] header button');
  if (!el) throw new Error('sélecteur de cours introuvable');
  return el;
}


describe('CourseMenu', () => {
  describe('états de la liste', () => {
    it('aucun cours, programme actif : message propre au programme et nom du programme en en-tête', () => {
      renderMenu({ courses: [] });
      expect(screen.getByText('Aucun cours')).toBeTruthy();
      expect(screen.getByText('Ce programme ne contient encore aucun cours à afficher.')).toBeTruthy();
      expect(screen.getByText('Génie logiciel')).toBeTruthy();
      expect(document.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    });

    it('aucun programme : invite à rejoindre un programme et en-tête « Accueil »', () => {
      renderMenu({ courses: [], activeProgram: null });
      expect(screen.getByText('Rejoins un programme pour voir tes cours, canaux et forums.')).toBeTruthy();
      expect(screen.getByText('Accueil')).toBeTruthy();
    });

    it('chargement : statut de chargement, pas de sélecteur', () => {
      renderMenu({ loading: true });
      expect(screen.getByText('Chargement des cours…')).toBeTruthy();
      expect(document.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    });

    it('erreur : message + « Réessayer » qui appelle onReloadCourses', () => {
      const onReloadCourses = vi.fn();
      renderMenu({ loadError: 'Serveur indisponible', onReloadCourses });
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Chargement impossible');
      expect(alert.textContent).toContain('Serveur indisponible');
      fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
      expect(onReloadCourses).toHaveBeenCalledTimes(1);
    });

    it('erreur sans onReloadCourses : pas de bouton « Réessayer »', () => {
      renderMenu({ loadError: 'Oups' });
      expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull();
    });
  });

  describe('titre du cours', () => {
    it('affiche le code du cours sélectionné, ou du premier cours par défaut', () => {
      renderMenu();
      expect(selector().textContent).toBe('IFT101');
      cleanup();
      renderMenu({ selectedCourseId: 20 });
      expect(selector().textContent).toBe('MAT200');
    });

    it('cours sans code : retombe sur le nom UI', () => {
      renderMenu({ selectedCourseId: 30 });
      expect(selector().textContent).toBe('Cours sans code');
    });

    it('liste les canaux du cours sélectionné, groupés par section', () => {
      renderMenu();
      expect(screen.getByText('general')).toBeTruthy();
      expect(screen.getByText('entraide')).toBeTruthy();
      expect(screen.getByText('Quiz intro')).toBeTruthy();
    });

    it('un clic sur le titre n’ouvre rien', () => {
      renderMenu({ onLeaveCourse: vi.fn() });
      fireEvent.click(selector());
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('menu contextuel du titre', () => {
    it('sans aucune action applicable : le menu natif n’est pas bloqué', () => {
      renderMenu({ isAdmin: false, onEditCourse: vi.fn() });
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      selector().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('non-admin : seul « Quitter le cours », avec l’id du cours sélectionné', () => {
      const onLeaveCourse = vi.fn();
      renderMenu({ selectedCourseId: 20, onLeaveCourse, onEditCourse: vi.fn(), onDeleteCourse: vi.fn() });
      fireEvent.contextMenu(selector());
      const menu = screen.getByRole('menu', { name: defaultLabels.contextMenuAria('MAT200') });
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
        defaultLabels.contextLeaveCourse,
      ]);
      fireEvent.click(within(menu).getByRole('menuitem'));
      expect(onLeaveCourse).toHaveBeenCalledWith(20);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('admin : modifier / feedback / supprimer appellent leur callback avec l’id puis ferment', () => {
      const handlers = {
        onEditCourse: vi.fn(),
        onOpenMcpManagement: vi.fn(),
        onDeleteCourse: vi.fn(),
        onLeaveCourse: vi.fn(),
      };
      renderMenu({ isAdmin: true, ...handlers });
      const cases: [string, keyof typeof handlers][] = [
        [defaultLabels.contextEditCourse, 'onEditCourse'],
        [defaultLabels.contextMcpManagement, 'onOpenMcpManagement'],
        [defaultLabels.contextDeleteCourse, 'onDeleteCourse'],
      ];
      for (const [label, key] of cases) {
        fireEvent.contextMenu(selector());
        fireEvent.click(screen.getByRole('menuitem', { name: label }));
        expect(handlers[key]).toHaveBeenCalledWith(10);
        expect(screen.queryByRole('menu')).toBeNull();
      }
    });

    it('Échap ferme le menu contextuel', () => {
      renderMenu({ onLeaveCourse: vi.fn() });
      fireEvent.contextMenu(selector());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('long-press tactile (500 ms) : ouvre le menu', () => {
      vi.useFakeTimers();
      renderMenu({ onLeaveCourse: vi.fn() });
      const btn = selector();
      fireEvent.touchStart(btn);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.touchEnd(btn);
    });

    it('un glissement avant 500 ms annule le long-press', () => {
      vi.useFakeTimers();
      renderMenu({ onLeaveCourse: vi.fn() });
      const btn = selector();
      fireEvent.touchStart(btn);
      fireEvent.touchMove(btn);
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('long-press sans action applicable : rien ne s’ouvre', () => {
      vi.useFakeTimers();
      renderMenu();
      fireEvent.touchStart(selector());
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('édition des sections', () => {
    it('non-admin : pas de crayon de section', () => {
      renderMenu({ onSectionChange: vi.fn() });
      expect(screen.queryByRole('button', { name: 'Modifier la section CANAUX' })).toBeNull();
    });

    it('admin : le crayon d’une section ouvre l’éditeur, et le changement porte cours + type', async () => {
      const onSectionChange = vi.fn().mockResolvedValue(undefined);
      renderMenu({ isAdmin: true, onSectionChange });
      fireEvent.click(screen.getByRole('button', { name: 'Modifier la section CANAUX' }));
      expect(screen.getByText('Modifier les canaux')).toBeTruthy();
      // Supprime « general » (id 1) via la corbeille de sa ligne puis confirme.
      const li = screen.getAllByText('general').map((el) => el.closest('li')).find((el) =>
        el?.querySelector(':scope > div:last-child > svg')
      ) as HTMLLIElement;
      const svgs = li.querySelectorAll(':scope > div:last-child > svg');
      fireEvent.click(svgs[1]);
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      await vi.waitFor(() =>
        expect(onSectionChange).toHaveBeenCalledWith(10, 'text', { type: 'delete', id: '1' })
      );
    });

    it('admin : le crayon de la section quiz ouvre l’éditeur de quiz du cours', () => {
      const onQuizzesChange = vi.fn();
      renderMenu({ isAdmin: true, onSectionChange: vi.fn(), onQuizzesChange });
      fireEvent.click(screen.getByRole('button', { name: 'Modifier la section QUIZ' }));
      expect(quizEditorProps).toHaveBeenCalledWith(
        expect.objectContaining({ courseId: 10, courseSubtitle: 'IFT101' })
      );
      // Le changement remonté par l'éditeur est rattaché au cours.
      fireEvent.click(screen.getByRole('button', { name: 'doublure-quiz-editor' }));
      expect(onQuizzesChange).toHaveBeenCalledWith(10, [{ id: 99, title: 'Nouveau' }]);
    });
  });

  describe('sélection de canal', () => {
    it('un clic sur un canal appelle onSelectChannel avec son type et son id', () => {
      const onSelectChannel = vi.fn();
      renderMenu({ onSelectChannel });
      fireEvent.click(screen.getByText('entraide'));
      expect(onSelectChannel).toHaveBeenCalledWith(expect.objectContaining({ id: 2, type: 'forum' }));
    });
  });

  describe('redimensionnement', () => {
    it('flèches clavier : ±16 px bornés, persistés dans localStorage', () => {
      renderMenu();
      const handle = screen.getByRole('separator', { name: 'Redimensionner le menu des cours' });
      // jsdom : offsetWidth = 0 → base 0, bornée au minimum (176 px).
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      expect(localStorage.getItem('courseMenu:width')).toBe('176');
      expect(screen.getByRole('navigation', { name: 'Cours' }).style.getPropertyValue('--cm-width')).toBe(
        '176px'
      );
    });

    it('poignée : valeur ARIA du séparateur focusable (largeur et bornes en px)', () => {
      localStorage.removeItem('courseMenu:width');
      const { unmount } = renderMenu();
      const handle = () => screen.getByRole('separator', { name: 'Redimensionner le menu des cours' });
      // Sans largeur choisie : largeur par défaut.
      expect(handle().getAttribute('aria-valuenow')).toBe('224');
      expect(handle().getAttribute('aria-valuemin')).toBe('176');
      expect(handle().getAttribute('aria-valuemax')).toBe('448');
      unmount();
      localStorage.setItem('courseMenu:width', '300');
      renderMenu();
      expect(handle().getAttribute('aria-valuenow')).toBe('300');
    });

    it('une autre touche ne change pas la largeur', () => {
      renderMenu();
      fireEvent.keyDown(screen.getByRole('separator'), { key: 'Enter' });
      expect(localStorage.getItem('courseMenu:width')).toBeNull();
    });

    it('relit une largeur persistée valide et l’efface au double-clic', () => {
      localStorage.setItem('courseMenu:width', '300');
      renderMenu();
      const nav = screen.getByRole('navigation', { name: 'Cours' });
      expect(nav.style.getPropertyValue('--cm-width')).toBe('300px');
      fireEvent.doubleClick(screen.getByRole('separator'));
      expect(localStorage.getItem('courseMenu:width')).toBeNull();
      expect(nav.style.getPropertyValue('--cm-width')).toBe('');
    });

    it('ignore une largeur persistée hors bornes', () => {
      localStorage.setItem('courseMenu:width', '9999');
      renderMenu();
      expect(screen.getByRole('navigation', { name: 'Cours' }).style.getPropertyValue('--cm-width')).toBe('');
    });

    it('glisser la poignée élargit le panneau (borné au maximum)', () => {
      renderMenu();
      const handle = screen.getByRole('separator');
      // jsdom n'implémente pas la capture de pointeur.
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 });
      expect(document.body.style.cursor).toBe('col-resize');
      fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 });
      expect(localStorage.getItem('courseMenu:width')).toBe('448');
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(document.body.style.cursor).toBe('');
      // Après relâchement, un mouvement ne redimensionne plus.
      fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
      expect(localStorage.getItem('courseMenu:width')).toBe('448');
    });
  });

  it('rend le menu du compte en pied de panneau', () => {
    renderMenu({ currentUser: { id: 1, username: 'jdoe', firstName: 'Jean', lastName: 'Doe' } });
    expect(screen.getByRole('button', { name: /^Compte utilisateur/ }).textContent).toContain('Jean Doe');
  });
});

// Navigation au clavier réel (user-event) : listbox du sélecteur (patron WAI-ARIA « Listbox »)
// et ouverture du menu contextuel par la touche Menu / Maj+F10.
describe('CourseMenu — clavier', () => {
  it('Maj+F10 sur le titre ouvre le menu contextuel ; Échap lui rend le focus', async () => {
    const user = userEvent.setup();
    renderMenu({ onLeaveCourse: vi.fn() });
    expect(selector().getAttribute('aria-keyshortcuts')).toBe('Shift+F10');
    selector().focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const menu = screen.getByRole('menu', { name: defaultLabels.contextMenuAria('IFT101') });
    expect(document.activeElement).toBe(menu);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(selector());
  });

  it('sans action de menu contextuel : Maj+F10 n’ouvre rien et le raccourci n’est pas annoncé', async () => {
    const user = userEvent.setup();
    renderMenu();
    expect(selector().hasAttribute('aria-keyshortcuts')).toBe(false);
    selector().focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
