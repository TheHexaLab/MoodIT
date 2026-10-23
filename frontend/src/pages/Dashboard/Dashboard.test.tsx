import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DemoProgram } from './dashboardApi';
import type { Course, Role, User } from '../../types/domain';
import type { UserSettings } from '../../helpers/userSettings';
import { ThemeContext, type ThemeApi } from '../../context/themeContext';
import { CurrentUserContext, type CurrentUserApi } from '../../context/currentUserContext';
import { ROLE } from '../../helpers/roles';
import { defaultLabels as noProgramLabels } from '../../components/MainPanel/states/NoProgramState/labels';
import { defaultLabels as noCourseLabels } from '../../components/MainPanel/states/NoCourseState/labels';
import { defaultLabels as emptyCourseLabels } from '../../components/MainPanel/states/EmptyCourseState/labels';
import { defaultLabels as noActiveLabels } from '../../components/MainPanel/states/NoActiveChannelState/labels';
import { defaultLabels as errorLabels } from '../../components/ErrorPopup/labels';
import { defaultLabels as courseLabels } from '../../components/CourseMenu/labels';
import { defaultLabels as profileLabels } from '../../components/EditProfilePopup/labels';
import { defaultLabels as joinCoursesLabels } from '../../components/JoinCoursesPopup/labels';
import { defaultLabels as auditLabels } from '../../components/AuditLogsPopup/labels';

// ── Couche API : chaque export fonction devient un vi.fn (implémentations posées par test). ──
vi.mock('./dashboardApi.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value])
  );
});
import * as api from './dashboardApi';

// ── WebSocket : façade factice qui capture les abonnements pour simuler des évènements. ──
interface CapturedHandlers {
  programs?: Record<string, (...args: never[]) => void>;
  courses?: Record<string, (...args: never[]) => void>;
  programsUserId?: number;
  coursesProgramId?: number;
}
const ws = vi.hoisted(() => ({
  captured: {} as CapturedHandlers,
  open: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../services/appSocket.ts', () => ({
  createAppSocket: () => {
    const noopSub = () => () => {};
    return {
      open: ws.open,
      close: ws.close,
      channels: { subscribe: noopSub },
      forums: { subscribe: noopSub },
      mcp: { subscribe: noopSub },
      establishments: { subscribe: noopSub },
      adminRoles: { subscribe: noopSub },
      programs: {
        subscribe: (userId: number, handlers: CapturedHandlers['programs']) => {
          ws.captured.programsUserId = userId;
          ws.captured.programs = handlers;
          return () => {};
        },
      },
      courses: {
        subscribe: (programId: number, handlers: CapturedHandlers['courses']) => {
          ws.captured.coursesProgramId = programId;
          ws.captured.courses = handlers;
          return () => {};
        },
      },
    };
  },
}));

// ── Vues de contenu : doublures (testées ailleurs) ; on vérifie seulement laquelle s'affiche. ──
vi.mock('../../components/MainPanel/ChannelView/ChannelView.tsx', () => ({
  default: (props: { channel: { name: string } }) => (
    <div data-testid="channel-view">{props.channel.name}</div>
  ),
}));
vi.mock('../../components/MainPanel/ForumView/ForumView.tsx', () => ({
  default: (props: { channel: { name: string } }) => (
    <div data-testid="forum-view">{props.channel.name}</div>
  ),
}));
vi.mock('../../components/MainPanel/QuizView/QuizView.tsx', () => ({
  default: (props: { channel: { name: string } }) => (
    <div data-testid="quiz-view">{props.channel.name}</div>
  ),
}));

import Dashboard from './Dashboard';

// ── Données ──────────────────────────────────────────────────────────────────────────────
function makePrograms(): DemoProgram[] {
  return [
    { id: 1, name: 'Génie logiciel', code: 'GLO', cohort: '', color: '', courses: [] },
    { id: 2, name: 'Génie info', code: 'GIF', cohort: '', color: '', roleName: ROLE.TEACHER, courses: [] },
    { id: 3, name: 'Mathématiques', code: 'MAT', cohort: '', color: '', courses: [] },
  ];
}

const coursesByProgram: Record<number, Course[]> = {
  1: [
    {
      id: 10,
      code: 'IFT101',
      title: 'Programmation',
      forums: [
        { id: 5, title: 'general', fType: 'Discussion' },
        { id: 6, title: 'entraide', fType: 'Thread' },
      ],
      quizzes: [{ id: 7, title: 'Quiz intro' }],
    },
    { id: 11, code: 'IFT102', title: 'Structures' },
  ],
  2: [{ id: 20, code: 'GIF200', title: 'Circuits' }],
  3: [],
};

const me: User = { id: 4, username: 'jdoe', firstName: 'Jean', lastName: 'Doe', avatarColor: '#123456' };

interface Setup {
  isAdmin?: boolean;
  isGuardian?: boolean;
  settings?: UserSettings;
  profileLoading?: boolean;
}

function renderDashboard({ isAdmin = false, isGuardian = false, settings = {}, profileLoading = false }: Setup = {}) {
  const saveSettings = vi.fn();
  const applyGlobalRoles = vi.fn();
  const userValue: CurrentUserApi = {
    status: 'authed',
    currentUser: me,
    profileLoading,
    isAdmin,
    isGuardian,
    saveProfile: vi.fn().mockResolvedValue(undefined),
    settings,
    saveSettings,
    applyGlobalRoles,
  };
  const themeValue: ThemeApi = { theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() };
  const utils = render(
    <ThemeContext.Provider value={themeValue}>
      <CurrentUserContext.Provider value={userValue}>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </CurrentUserContext.Provider>
    </ThemeContext.Provider>
  );
  return { saveSettings, applyGlobalRoles, ...utils };
}

/** Pastille d'un programme dans le rail. */
function programButton(name: string) {
  return screen.getByRole('button', { name });
}

async function selectProgram(name: string) {
  await waitFor(() => expect(programButton(name)).toBeTruthy());
  fireEvent.click(programButton(name));
}

/** Sélecteur de cours du CourseMenu (bouton à listbox). */
function courseSelector(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-haspopup="listbox"]');
}

async function waitForCourseSelector(code: string) {
  await waitFor(() => expect(courseSelector()?.textContent).toBe(code));
}

function openProgramContextMenu(name: string) {
  const li = programButton(name).closest('li') as HTMLElement;
  fireEvent.contextMenu(li);
  return screen.getByRole('menu');
}

function errorPopup() {
  return screen.getByRole('heading', { name: errorLabels.title });
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'light');
  ws.captured = {};
  ws.open.mockClear();
  ws.close.mockClear();
  // Animations réduites : les popups se ferment / confirment de façon synchrone sous jsdom.
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
  for (const fn of Object.values(api)) {
    if (vi.isMockFunction(fn)) fn.mockReset();
  }
  vi.mocked(api.fetchPrograms).mockImplementation(async () => makePrograms());
  vi.mocked(api.fetchCourses).mockImplementation(async (id: number) =>
    structuredClone(coursesByProgram[id] ?? [])
  );
  vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
});

describe('Dashboard', () => {
  describe('chargement initial', () => {
    it('ouvre la connexion WS, charge les programmes et invite à en choisir un', async () => {
      renderDashboard();
      expect(ws.open).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      expect(api.fetchPrograms).toHaveBeenCalledTimes(1);
      // Aucun programme actif : pas de chargement de cours, état « aucun programme ».
      expect(api.fetchCourses).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: noProgramLabels.title })).toBeTruthy();
    });

    it('s’abonne au WS programmes sur la room de l’utilisateur courant', async () => {
      renderDashboard();
      await waitFor(() => expect(ws.captured.programsUserId).toBe(me.id));
    });

    it('profil pas encore chargé (id -1) : aucun abonnement WS programmes', async () => {
      const userValue = { ...me, id: -1 };
      // Rendu direct avec un utilisateur « en chargement ».
      render(
        <ThemeContext.Provider value={{ theme: 'light', setTheme: vi.fn(), toggleTheme: vi.fn() }}>
          <CurrentUserContext.Provider
            value={{
              status: 'checking',
              currentUser: userValue,
              profileLoading: true,
              isAdmin: false,
              isGuardian: false,
              saveProfile: vi.fn(),
              settings: {},
              saveSettings: vi.fn(),
              applyGlobalRoles: vi.fn(),
            }}
          >
            <MemoryRouter>
              <Dashboard />
            </MemoryRouter>
          </CurrentUserContext.Provider>
        </ThemeContext.Provider>
      );
      await waitFor(() => expect(api.fetchPrograms).toHaveBeenCalled());
      expect(ws.captured.programs).toBeUndefined();
    });

    it('échec du chargement des programmes : bouton « Réessayer » qui relance le fetch', async () => {
      vi.mocked(api.fetchPrograms).mockRejectedValueOnce(new Error('panne'));
      renderDashboard();
      const retry = await screen.findByRole('button', { name: 'Réessayer le chargement des programmes' });
      fireEvent.click(retry);
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      expect(api.fetchPrograms).toHaveBeenCalledTimes(2);
    });

    it('démonter ferme la connexion WS', async () => {
      const { unmount } = renderDashboard();
      await waitFor(() => expect(api.fetchPrograms).toHaveBeenCalled());
      unmount();
      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe('navigation programme → cours → canal', () => {
    it('choisir un programme charge ses cours et sélectionne le premier', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      expect(api.fetchCourses).toHaveBeenCalledWith(1);
      // Cours avec contenu mais rien de sélectionné.
      expect(screen.getByRole('heading', { name: noActiveLabels.title })).toBeTruthy();
      expect(ws.captured.coursesProgramId).toBe(1);
    });

    it('cliquer un canal l’affiche dans le panneau principal', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('general'));
      expect(screen.getByTestId('channel-view').textContent).toBe('general');
      fireEvent.click(screen.getByText('entraide'));
      expect(screen.getByTestId('forum-view').textContent).toBe('entraide');
      fireEvent.click(screen.getByText('Quiz intro'));
      expect(screen.getByTestId('quiz-view').textContent).toBe('Quiz intro');
    });

    it('changer de cours via le sélecteur réinitialise le canal', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('general'));
      fireEvent.click(courseSelector()!);
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /IFT102/ }));
      expect(courseSelector()!.textContent).toBe('IFT102');
      expect(screen.queryByTestId('channel-view')).toBeNull();
      expect(screen.getByRole('heading', { name: emptyCourseLabels.title })).toBeTruthy();
    });

    it('programme sans cours : état « aucun cours » et « Rejoindre un cours » ouvre le popup', async () => {
      vi.mocked(api.fetchProgramCourses).mockResolvedValue([]);
      vi.mocked(api.fetchJoinedCourseIds).mockResolvedValue([]);
      renderDashboard();
      await selectProgram('Mathématiques');
      const join = await screen.findByText(noCourseLabels.joinCourse);
      fireEvent.click(join);
      expect(await screen.findByText(joinCoursesLabels.title)).toBeTruthy();
      await waitFor(() => expect(api.fetchProgramCourses).toHaveBeenCalledWith(3));
    });

    it('échec du chargement des cours : message d’erreur et « Réessayer »', async () => {
      vi.mocked(api.fetchCourses).mockRejectedValueOnce(new Error('panne'));
      renderDashboard();
      await selectProgram('Génie logiciel');
      const alert = await screen.findByRole('alert');
      fireEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }));
      await waitForCourseSelector('IFT101');
      expect(api.fetchCourses).toHaveBeenCalledTimes(2);
    });

    it('sauvegarde la localisation après chaque déplacement', async () => {
      const { saveSettings } = renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('general'));
      await waitFor(() =>
        expect(saveSettings).toHaveBeenLastCalledWith({
          location: { programId: 1, courseId: 10, channel: { id: 5, type: 'text' } },
        })
      );
    });
  });

  describe('restauration du dernier emplacement', () => {
    // La restauration du cours/canal attend une transition coursesLoading true → false
    // RENDUE. Un vrai appel réseau prend toujours au moins une tâche : on simule cette
    // latence (sinon voir le test it.fails plus bas).
    beforeEach(() => {
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return structuredClone(coursesByProgram[id] ?? []);
      });
    });

    // BOGUE : si les cours du programme restauré répondent avant que React n'ait rendu
    // l'état « chargement » (cache, réponse instantanée), la transition true → false
    // n'est jamais observée (coursesLoadedForRef reste null) : le cours et le canal
    // sauvegardés ne sont pas restaurés ET restoreDoneRef reste false, ce qui bloque
    // toute sauvegarde ultérieure de la localisation pour la session.
    it.fails('restaure le cours même quand les cours répondent instantanément', async () => {
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) =>
        structuredClone(coursesByProgram[id] ?? [])
      );
      renderDashboard({ settings: { location: { programId: 1, courseId: 11 } } });
      await waitForCourseSelector('IFT102');
    });

    it('replace l’utilisateur sur le programme, le cours et le canal sauvegardés', async () => {
      renderDashboard({
        settings: { location: { programId: 1, courseId: 11, channel: { type: 'text', id: 5 } } },
      });
      await waitForCourseSelector('IFT102');
      expect(api.fetchCourses).toHaveBeenCalledWith(1);
      expect(programButton('Génie logiciel').getAttribute('aria-current')).toBe('page');
    });

    it('restaure le canal quand il existe encore', async () => {
      renderDashboard({
        settings: { location: { programId: 1, courseId: 10, channel: { type: 'forum', id: 6 } } },
      });
      expect((await screen.findByTestId('forum-view')).textContent).toBe('entraide');
    });

    it('cours disparu : garde le programme et retombe sur le premier cours', async () => {
      renderDashboard({ settings: { location: { programId: 1, courseId: 999 } } });
      await waitForCourseSelector('IFT101');
    });

    it('programme disparu : rien n’est sélectionné ni sauvegardé', async () => {
      const { saveSettings } = renderDashboard({ settings: { location: { programId: 42 } } });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      expect(api.fetchCourses).not.toHaveBeenCalled();
      expect(saveSettings).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: noProgramLabels.title })).toBeTruthy();
    });

    it('ne sauvegarde rien pendant la restauration, puis la position restaurée', async () => {
      const { saveSettings } = renderDashboard({
        settings: { location: { programId: 1, courseId: 11 } },
      });
      // Programme posé mais cours pas encore chargés : aucune sauvegarde (sinon le
      // premier cours par défaut écraserait la localisation sauvegardée).
      await waitFor(() => expect(api.fetchCourses).toHaveBeenCalledWith(1));
      expect(saveSettings).not.toHaveBeenCalled();
      await waitForCourseSelector('IFT102');
      // saveSettings est debouncé côté provider : seule la dernière valeur est persistée.
      // (Un appel transitoire avec le cours par défaut a lieu dans le même commit que la
      // restauration ; il est écrasé par le suivant.)
      await waitFor(() =>
        expect(saveSettings).toHaveBeenLastCalledWith({
          location: { programId: 1, courseId: 11, channel: undefined },
        })
      );
      for (const [arg] of saveSettings.mock.calls) expect(arg.location.programId).toBe(1);
    });
  });

  describe('menu contextuel des programmes', () => {
    it('quitter un programme : confirmation puis api.leaveProgram et retrait de la liste', async () => {
      vi.mocked(api.leaveProgram).mockResolvedValue(undefined);
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      const menu = openProgramContextMenu('Génie logiciel');
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Quitter le programme' }));
      expect(screen.getByText('Quitter le programme ?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Quitter' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Génie logiciel' })).toBeNull());
      expect(api.leaveProgram).toHaveBeenCalledWith(1);
      // Le programme actif a disparu : bascule sur un autre programme.
      await waitFor(() => expect(programButton('Génie info').getAttribute('aria-current')).toBe('page'));
    });

    it('échec de la sortie : ErrorPopup et programme conservé', async () => {
      vi.mocked(api.leaveProgram).mockRejectedValue(new Error('refus'));
      renderDashboard();
      await waitFor(() => expect(programButton('Mathématiques')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Quitter le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Quitter' }));
      expect(await screen.findByText('Impossible de quitter le programme. Réessaie.')).toBeTruthy();
      expect(errorPopup()).toBeTruthy();
      expect(programButton('Mathématiques')).toBeTruthy();
    });

    it('admin global : supprimer un programme appelle api.deleteProgram', async () => {
      vi.mocked(api.deleteProgram).mockResolvedValue(undefined);
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Mathématiques')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Supprimer le programme' })
      );
      expect(screen.getByText('Supprimer le programme ?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Mathématiques' })).toBeNull());
      expect(api.deleteProgram).toHaveBeenCalledWith(3);
    });

    it('échec de la suppression d’un programme : ErrorPopup dédié', async () => {
      vi.mocked(api.deleteProgram).mockRejectedValue(new Error('refus'));
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Mathématiques')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Supprimer le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      expect(await screen.findByText('Impossible de supprimer le programme. Réessaie.')).toBeTruthy();
    });

    it('gérer les rôles : échec du chargement → ErrorPopup', async () => {
      vi.mocked(api.fetchProgramRoles).mockRejectedValue(new Error('refus'));
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Gérer les rôles' })
      );
      expect(await screen.findByText('Impossible de charger les membres du programme. Réessaie.')).toBeTruthy();
      expect(api.fetchProgramRoles).toHaveBeenCalledWith(1);
    });

    it('gérer les rôles : succès → popup des rôles', async () => {
      const roles: Role[] = [{ id: 1, name: ROLE.TEACHER }];
      vi.mocked(api.fetchProgramRoles).mockResolvedValue({ roles, users: [] });
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Gérer les rôles' })
      );
      expect(await screen.findByText('Gestion des rôles')).toBeTruthy();
    });

    it('modifier le programme ouvre le popup pré-rempli', async () => {
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Modifier le programme' })
      );
      expect(await screen.findByText('Modifier le programme')).toBeTruthy();
      expect(screen.getByDisplayValue('Génie logiciel')).toBeTruthy();
    });

    it('enseignant : « Ajouter un cours » ouvre le popup d’ajout de cours', async () => {
      vi.mocked(api.fetchEstablishments).mockResolvedValue([]);
      renderDashboard();
      await waitFor(() => expect(programButton('Génie info')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie info')).getByRole('menuitem', { name: 'Ajouter un cours' })
      );
      expect(await screen.findByText('Ajoute ce cours à un ou plusieurs programmes')).toBeTruthy();
    });
  });

  describe('menu contextuel des cours', () => {
    it('quitter un cours : api.leaveCourse puis retrait et repli sur le cours suivant', async () => {
      vi.mocked(api.leaveCourse).mockResolvedValue(undefined);
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextLeaveCourse }));
      expect(screen.getByText('Quitter le cours ?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Quitter' }));
      await waitForCourseSelector('IFT102');
      expect(api.leaveCourse).toHaveBeenCalledWith(10);
    });

    it('échec de la sortie d’un cours : ErrorPopup, cours conservé', async () => {
      vi.mocked(api.leaveCourse).mockRejectedValue(new Error('refus'));
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextLeaveCourse }));
      fireEvent.click(screen.getByRole('button', { name: 'Quitter' }));
      expect(await screen.findByText('Impossible de quitter le cours. Réessaie.')).toBeTruthy();
      // Fermer l'ErrorPopup le retire.
      fireEvent.click(screen.getByRole('button', { name: errorLabels.close }));
      await waitFor(() => expect(screen.queryByText('Impossible de quitter le cours. Réessaie.')).toBeNull());
      expect(courseSelector()!.textContent).toBe('IFT101');
    });

    it('enseignant : supprimer le cours appelle api.deleteCourse', async () => {
      vi.mocked(api.deleteCourse).mockResolvedValue(undefined);
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextDeleteCourse }));
      expect(screen.getByText('Supprimer le cours ?')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      await waitFor(() => expect(courseSelector()).toBeNull());
      expect(api.deleteCourse).toHaveBeenCalledWith(20);
      expect(screen.getByRole('heading', { name: noCourseLabels.title })).toBeTruthy();
    });

    it('échec de la suppression d’un cours : ErrorPopup', async () => {
      vi.mocked(api.deleteCourse).mockRejectedValue(new Error('refus'));
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextDeleteCourse }));
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      expect(await screen.findByText('Impossible de supprimer le cours. Réessaie.')).toBeTruthy();
    });

    it('étudiant : pas d’action d’administration dans le menu du cours', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.contextMenu(courseSelector()!);
      expect(screen.queryByRole('menuitem', { name: courseLabels.contextEditCourse })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: courseLabels.contextDeleteCourse })).toBeNull();
    });

    it('enseignant : « Modifier le cours » ouvre le popup de modification', async () => {
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextEditCourse }));
      expect(await screen.findByText('Mets à jour le cours et ses programmes')).toBeTruthy();
      expect(screen.getByDisplayValue('Circuits')).toBeTruthy();
    });
  });

  describe('édition de section (admin)', () => {
    async function deleteGeneral() {
      renderDashboard({ isAdmin: true });
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByRole('button', { name: 'Modifier la section CANAUX' }));
      // Ligne « general » DANS le popup (celle qui porte les icônes d'action).
      const li = screen
        .getAllByText('general')
        .map((el) => el.closest('li'))
        .find((el) => el?.querySelector(':scope > div:last-child > svg')) as HTMLLIElement;
      fireEvent.click(li.querySelectorAll(':scope > div:last-child > svg')[1]);
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    }

    it('supprimer un canal persiste via api.changeSection puis le retire de la sidebar', async () => {
      vi.mocked(api.changeSection).mockImplementation(async (_c, _t, change) => change);
      await deleteGeneral();
      await waitFor(() =>
        expect(api.changeSection).toHaveBeenCalledWith(10, 'text', { type: 'delete', id: '5' })
      );
      const nav = screen.getByRole('navigation', { name: 'Cours' });
      await waitFor(() => expect(within(nav).queryByText('general')).toBeNull());
      expect(within(nav).getByText('entraide')).toBeTruthy();
    });

    it('échec de api.changeSection : le canal reste dans la sidebar', async () => {
      vi.mocked(api.changeSection).mockRejectedValue(new Error('refus'));
      await deleteGeneral();
      await waitFor(() => expect(api.changeSection).toHaveBeenCalled());
      // La sidebar n'est mise à jour qu'après succès.
      const nav = screen.getByRole('navigation', { name: 'Cours' });
      expect(within(nav).getByText('general')).toBeTruthy();
    });
  });

  describe('création depuis un cours vide (enseignant)', () => {
    it('« Créer un canal » ouvre l’éditeur de la section canaux', async () => {
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.click(screen.getByText(emptyCourseLabels.createChannel));
      expect(screen.getByText('Modifier les canaux')).toBeTruthy();
    });

    it('étudiant : pas de bouton de création dans un cours vide', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(courseSelector()!);
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /IFT102/ }));
      expect(screen.getByRole('heading', { name: emptyCourseLabels.title })).toBeTruthy();
      expect(screen.queryByText(emptyCourseLabels.createChannel)).toBeNull();
    });
  });

  describe('menu du compte', () => {
    it('« Modifier le profil » ouvre le popup de profil', async () => {
      renderDashboard();
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Modifier le profil' }));
      expect(await screen.findByText(profileLabels.subtitle)).toBeTruthy();
    });

    it('utilisateur simple : ni gestion des administrateurs ni journal', async () => {
      renderDashboard();
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      expect(screen.queryByRole('menuitem', { name: 'Gérer les administrateurs' })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Journalisation' })).toBeNull();
    });

    it('admin : gestion des administrateurs, échec de chargement → ErrorPopup', async () => {
      vi.mocked(api.fetchGlobalRoles).mockRejectedValue(new Error('refus'));
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gérer les administrateurs' }));
      expect(await screen.findByText('Impossible de charger les administrateurs. Réessaie.')).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'Journalisation' })).toBeNull();
    });

    it('admin : gestion des administrateurs, succès → popup titré', async () => {
      vi.mocked(api.fetchGlobalRoles).mockResolvedValue({ roles: [{ id: 1, name: ROLE.ADMIN }], users: [] });
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gérer les administrateurs' }));
      expect(await screen.findByText('Administrateurs généraux et gardiens de la plateforme.')).toBeTruthy();
    });

    it('gardien : le journal d’audit s’ouvre', async () => {
      vi.mocked(api.fetchAuditLogs).mockResolvedValue([]);
      renderDashboard({ isAdmin: true, isGuardian: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Journalisation' }));
      expect(await screen.findByText(auditLabels.title)).toBeTruthy();
    });
  });

  describe('ajout / adhésion de programme', () => {
    it('« Rejoindre un programme » (état vide) ouvre le popup sur la vue d’adhésion', async () => {
      vi.mocked(api.fetchEstablishmentsForJoin).mockResolvedValue([]);
      renderDashboard();
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByText(noProgramLabels.joinProgram));
      await waitFor(() => expect(api.fetchEstablishmentsForJoin).toHaveBeenCalled());
    });

    it('le « + » du rail ouvre le popup d’ajout de programme', async () => {
      renderDashboard();
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Ajouter un programme' }));
      expect(await screen.findByText('Crée ton propre programme ou rejoins-en un existant.')).toBeTruthy();
    });
  });

  describe('temps réel', () => {
    it('programme ajouté / supprimé via WS : la liste suit, le programme actif bascule', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        (ws.captured.programs!.onProgramUpsert as (p: unknown) => void)({
          id: 9,
          name: 'Physique',
          code: 'PHY',
          cohort: '',
          color: '',
        });
      });
      expect(programButton('Physique')).toBeTruthy();
      act(() => {
        (ws.captured.programs!.onProgramRemove as (id: number) => void)(1);
      });
      expect(screen.queryByRole('button', { name: 'Génie logiciel' })).toBeNull();
      await waitFor(() => expect(programButton('Génie info').getAttribute('aria-current')).toBe('page'));
    });

    it('programme renommé via WS : met à jour le libellé en gardant les cours', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        (ws.captured.programs!.onProgramUpsert as (p: unknown) => void)({
          id: 1,
          name: 'Génie logiciel 2',
          code: 'GLO',
          cohort: '',
          color: '',
        });
      });
      expect(programButton('Génie logiciel 2')).toBeTruthy();
      expect(courseSelector()!.textContent).toBe('IFT101');
    });

    it('changement de rôle dans un programme via WS : les droits suivent', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        (ws.captured.programs!.onProgramRoleChange as (id: number, r: string) => void)(1, ROLE.TEACHER);
      });
      fireEvent.contextMenu(courseSelector()!);
      expect(screen.getByRole('menuitem', { name: courseLabels.contextEditCourse })).toBeTruthy();
    });

    it('rôles globaux via WS : délégués à applyGlobalRoles', async () => {
      const { applyGlobalRoles } = renderDashboard();
      await waitFor(() => expect(ws.captured.programs).toBeDefined());
      const roles = [{ id: 1, name: ROLE.ADMIN }];
      act(() => {
        (ws.captured.programs!.onGlobalRolesChange as (r: unknown) => void)(roles);
      });
      expect(applyGlobalRoles).toHaveBeenCalledWith(roles);
    });

    it('cours supprimé et section modifiée via WS', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        (ws.captured.courses!.onSectionChange as (c: number, t: string, ch: unknown) => void)(10, 'text', {
          type: 'rename',
          id: '5',
          name: 'annonces',
        });
      });
      expect(screen.getByText('annonces')).toBeTruthy();
      expect(screen.queryByText('general')).toBeNull();
      act(() => {
        (ws.captured.courses!.onCourseDelete as (id: number) => void)(10);
      });
      await waitForCourseSelector('IFT102');
    });

    it('cours édité via WS : met à jour la méta d’un cours déjà suivi, n’en ajoute pas', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        const upsert = ws.captured.courses!.onCourseUpsert as (c: unknown) => void;
        upsert({ id: 10, code: 'IFT111', title: 'Prog' });
        upsert({ id: 77, code: 'NOUV', title: 'Inconnu' });
      });
      expect(courseSelector()!.textContent).toBe('IFT111');
      fireEvent.click(courseSelector()!);
      expect(within(screen.getByRole('listbox')).queryByRole('option', { name: /NOUV/ })).toBeNull();
    });

    it('quiz créé via WS : recharge les quiz publiés du cours', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([{ id: 8, title: 'Quiz neuf' }]);
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      act(() => {
        (ws.captured.courses!.onQuizCreated as (c: number) => void)(10);
      });
      expect(await screen.findByText('Quiz neuf')).toBeTruthy();
      expect(api.fetchPublishedQuizzes).toHaveBeenCalledWith(10);
    });

    it('quiz ouvert supprimé via WS : la vue se ferme', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([]);
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('Quiz intro'));
      expect(screen.getByTestId('quiz-view')).toBeTruthy();
      act(() => {
        (ws.captured.courses!.onQuizDeleted as (c: number, q: number) => void)(10, 7);
      });
      await waitFor(() => expect(screen.queryByTestId('quiz-view')).toBeNull());
    });

    it('resync WS : recharge les cours du programme actif', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      expect(api.fetchCourses).toHaveBeenCalledTimes(1);
      act(() => {
        (ws.captured.courses!.onResync as () => void)();
      });
      await waitFor(() => expect(api.fetchCourses).toHaveBeenCalledTimes(2));
    });
  });

  describe('easter eggs', () => {
    function type(keys: string[]) {
      for (const key of keys) fireEvent.keyDown(window, { key });
    }

    it('« 8339! » bascule le thème éphémère « twee », une seconde fois le retire', async () => {
      renderDashboard();
      type(['8', '3', '3', '9', 'Shift', '!']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('twee');
      type(['8', '3', '3', '9', '!']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('Konami → « kiwi », puis « pacman! » bascule directement, et le démontage restaure', async () => {
      const { unmount } = renderDashboard();
      type(['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'B', 'a']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('kiwi');
      type(['p', 'a', 'c', 'm', 'a', 'n', '!']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('pacman');
      unmount();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('une faute de frappe remet la séquence à zéro', async () => {
      renderDashboard();
      type(['8', '3', 'x', '3', '9', '!']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });
});
