import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
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
import { defaultLabels as addCourseLabels } from '../../components/AddCoursePopup/labels';
import type { ItemChange } from '../../components/SectionEditorPopup/types';

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
  adminRoles?: (users: unknown[]) => void;
  mcp?: Record<string, (...args: never[]) => void>;
  mcpCourseId?: number;
}
const ws = vi.hoisted(() => ({
  captured: {} as CapturedHandlers,
  open: vi.fn(),
  close: vi.fn(),
  /** Abonnements à la room de l'utilisateur (programmes, rôles, corrections de quiz). */
  programsSubscriptions: 0,
}));
vi.mock('../../services/appSocket.ts', () => ({
  createAppSocket: () => {
    const noopSub = () => () => {};
    return {
      open: ws.open,
      close: ws.close,
      channels: { subscribe: noopSub },
      forums: { subscribe: noopSub },
      mcp: {
        subscribe: (courseId: number, handlers: CapturedHandlers['mcp']) => {
          ws.captured.mcpCourseId = courseId;
          ws.captured.mcp = handlers;
          return () => {};
        },
      },
      establishments: { subscribe: noopSub },
      adminRoles: {
        subscribe: (handler: (users: unknown[]) => void) => {
          ws.captured.adminRoles = handler;
          return () => {};
        },
      },
      programs: {
        subscribe: (userId: number, handlers: CapturedHandlers['programs']) => {
          ws.programsSubscriptions += 1;
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

// ── Vues de contenu : doublures (testées ailleurs) ; on vérifie laquelle s'affiche, et des
// boutons « sonde » invoquent les callbacks reçus pour vérifier leur routage vers l'API.
type Callback = (...args: unknown[]) => unknown;
interface ViewProps {
  channel: { id: number; name: string };
  canModerate?: boolean;
  staleNotice?: boolean;
  attemptOutcome?: unknown;
  onReloadStale?: () => void;
  [handler: string]: unknown;
}
function probe(props: ViewProps, label: string, handler: string, ...args: unknown[]) {
  return (
    <button type="button" onClick={() => (props[handler] as Callback)(...args)}>
      {label}
    </button>
  );
}
vi.mock('../../components/MainPanel/ChannelView/ChannelView.tsx', () => ({
  default: (props: ViewProps) => (
    <>
      <div data-testid="channel-view" data-can-moderate={String(!!props.canModerate)}>
        {props.channel.name}
      </div>
      {probe(props, 'chat:fetch', 'onFetchMessages', props.channel.id, 40, 20)}
      {probe(props, 'chat:send', 'onSendMessage', props.channel.id, 'Bonjour', null, 'c-1')}
      {probe(props, 'chat:edit', 'onEditMessage', 11, 'Modifié')}
      {probe(props, 'chat:delete', 'onDeleteMessage', 11)}
    </>
  ),
}));
vi.mock('../../components/MainPanel/ForumView/ForumView.tsx', () => ({
  default: (props: ViewProps) => (
    <>
      <div data-testid="forum-view">{props.channel.name}</div>
      {probe(props, 'forum:threads', 'onFetchThreads', props.channel.id, 3, 10)}
      {probe(props, 'forum:replies', 'onFetchReplies', props.channel.id, 12)}
      {probe(props, 'forum:create', 'onCreatePost', props.channel.id, 'Contenu', null, 'p-1', 'Titre')}
      {probe(props, 'forum:edit', 'onEditPost', 12, 'Nouveau', 'T')}
      {probe(props, 'forum:delete', 'onDeletePost', 12)}
      {probe(props, 'forum:vote', 'onVotePost', 12, -1)}
    </>
  ),
}));
vi.mock('../../components/MainPanel/QuizView/QuizView.tsx', () => ({
  default: (props: ViewProps) => (
    <>
      <div
        data-testid="quiz-view"
        data-stale={String(!!props.staleNotice)}
        data-outcome={props.attemptOutcome ? JSON.stringify(props.attemptOutcome) : ''}
      >
        {props.channel.name}
      </div>
      <button type="button" onClick={() => props.onReloadStale?.()}>
        quiz:reload
      </button>
    </>
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
  /** URL de départ (la vue y est lue, #63). */
  path?: string;
}

/** Expose l'URL et le type de la dernière navigation (PUSH, REPLACE, POP), et un « back ». */
function RouterProbe() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  return (
    <span data-testid="router" data-path={pathname} data-navigation={navigationType} hidden>
      <button type="button" data-testid="router-back" onClick={() => navigate(-1)} />
    </span>
  );
}

/** Bouton « back » du navigateur. */
function goBack() {
  fireEvent.click(screen.getByTestId('router-back'));
}

function currentPath() {
  return screen.getByTestId('router').getAttribute('data-path');
}

function lastNavigation() {
  return screen.getByTestId('router').getAttribute('data-navigation');
}

function renderDashboard({
  isAdmin = false,
  isGuardian = false,
  settings = {},
  profileLoading = false,
  path = '/home',
}: Setup = {}) {
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
        <MemoryRouter initialEntries={[path]}>
          <Dashboard />
          <RouterProbe />
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
  ws.programsSubscriptions = 0;
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

  describe('vue dans l’URL (#63)', () => {
    it('chaque choix ajoute une entrée d’historique : programme, cours, canal', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitFor(() => expect(currentPath()).toBe('/home/p/1'));
      expect(lastNavigation()).toBe('PUSH');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('entraide'));
      await waitFor(() => expect(currentPath()).toBe('/home/p/1/c/10/forum/6'));
      fireEvent.click(courseSelector()!);
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /IFT102/ }));
      await waitFor(() => expect(currentPath()).toBe('/home/p/1/c/11'));
      expect(lastNavigation()).toBe('PUSH');
    });

    // Revue de #176 : `navigate` change à chaque navigation ; un setView qui en dépendait faisait
    // désabonner puis réabonner la room de l'utilisateur à chaque clic (évènements manqués).
    it('naviguer entre les vues ne réabonne pas la room de l’utilisateur', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      const subscriptions = ws.programsSubscriptions;
      expect(subscriptions).toBeGreaterThan(0);
      fireEvent.click(screen.getByText('general'));
      fireEvent.click(screen.getByText('Quiz intro'));
      goBack();
      await waitFor(() => expect(currentPath()).toBe('/home/p/1/c/10/text/5'));
      expect(ws.programsSubscriptions).toBe(subscriptions);
    });

    it('« back » revient à la vue précédente, sans quitter le dashboard', async () => {
      renderDashboard();
      await selectProgram('Génie logiciel');
      await waitForCourseSelector('IFT101');
      fireEvent.click(screen.getByText('general'));
      fireEvent.click(screen.getByText('Quiz intro'));
      expect(screen.getByTestId('quiz-view').textContent).toBe('Quiz intro');

      goBack();
      expect((await screen.findByTestId('channel-view')).textContent).toBe('general');
      goBack();
      await waitFor(() => expect(currentPath()).toBe('/home/p/1'));
      expect(screen.queryByTestId('channel-view')).toBeNull();
      expect(screen.getByRole('heading', { name: noActiveLabels.title })).toBeTruthy();
    });

    it('lien vers un canal : la vue s’ouvre telle quelle, la localisation enregistrée est ignorée', async () => {
      const { saveSettings } = renderDashboard({
        path: '/home/p/1/c/10/forum/6',
        settings: { location: { programId: 2, courseId: 20 } },
      });
      expect((await screen.findByTestId('forum-view')).textContent).toBe('entraide');
      expect(api.fetchCourses).toHaveBeenCalledWith(1);
      expect(api.fetchCourses).not.toHaveBeenCalledWith(2);
      expect(currentPath()).toBe('/home/p/1/c/10/forum/6');
      await waitFor(() =>
        expect(saveSettings).toHaveBeenLastCalledWith({
          location: { programId: 1, courseId: 10, channel: { type: 'forum', id: 6 } },
        })
      );
    });

    it('arrivée sur /home : la localisation enregistrée remplace l’entrée, sans en ajouter', async () => {
      renderDashboard({
        settings: { location: { programId: 1, courseId: 11, channel: { type: 'text', id: 5 } } },
      });
      await waitFor(() => expect(currentPath()).toBe('/home/p/1/c/11/text/5'));
      expect(lastNavigation()).toBe('REPLACE');
      await waitForCourseSelector('IFT102');
    });

    it('programme inconnu dans l’URL : retour à /home, sans charger ses cours', async () => {
      renderDashboard({ path: '/home/p/42/c/1' });
      await waitFor(() => expect(currentPath()).toBe('/home'));
      expect(lastNavigation()).toBe('REPLACE');
      expect(api.fetchCourses).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: noProgramLabels.title })).toBeTruthy();
    });

    it('programme actif quitté : le repli remplace l’entrée d’historique', async () => {
      vi.mocked(api.leaveProgram).mockResolvedValue(undefined);
      renderDashboard({ path: '/home/p/1/c/10/text/5' });
      expect((await screen.findByTestId('channel-view')).textContent).toBe('general');
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Quitter le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Quitter' }));
      await waitFor(() => expect(currentPath()).toBe('/home/p/2'));
      expect(lastNavigation()).toBe('REPLACE');
    });

    it('quiz ouvert supprimé à distance : la vue revient au cours, en remplaçant l’entrée', async () => {
      renderDashboard({ path: '/home/p/1/c/10/quiz/7' });
      expect((await screen.findByTestId('quiz-view')).textContent).toBe('Quiz intro');
      act(() => (ws.captured.courses!.onQuizDeleted as (c: number, q: number) => void)(10, 7));
      await waitFor(() => expect(currentPath()).toBe('/home/p/1/c/10'));
      expect(lastNavigation()).toBe('REPLACE');
    });
  });

  describe('restauration du dernier emplacement', () => {
    // Un vrai appel réseau prend toujours au moins une tâche : on simule cette latence
    // (le cas d'une réponse instantanée est couvert par un test dédié plus bas).
    beforeEach(() => {
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return structuredClone(coursesByProgram[id] ?? []);
      });
    });

    // Garde : si les cours du programme restauré répondent avant que React n'ait rendu
    // l'état « chargement » (cache, réponse instantanée), la transition true → false n'est
    // jamais rendue. La restauration ne doit pas en dépendre (cours restauré, et la
    // sauvegarde de la localisation reste débloquée).
    it('restaure le cours même quand les cours répondent instantanément', async () => {
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

  describe('droit de modération', () => {
    // Le programme 2 (« Génie info ») a le rôle Enseignant : on lui donne un canal texte.
    beforeEach(() => {
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) =>
        id === 2
          ? [{ id: 20, code: 'GIF200', title: 'Circuits', forums: [{ id: 8, title: 'labo', fType: 'Discussion' }] }]
          : structuredClone(coursesByProgram[id] ?? [])
      );
    });

    async function openTeacherChannel() {
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.click(screen.getByText('labo'));
      return screen.getByTestId('channel-view');
    }

    // Garde : l'Enseignant gère le contenu (canManageContent) mais NE modère PAS ; seul
    // l'admin global ou l'Administrateur du programme voit « Supprimer » sur le contenu d'autrui.
    it('enseignant du programme : le canal ne reçoit pas canModerate', async () => {
      renderDashboard();
      expect((await openTeacherChannel()).dataset.canModerate).toBe('false');
    });

    it('admin global : le canal reçoit canModerate', async () => {
      renderDashboard({ isAdmin: true });
      expect((await openTeacherChannel()).dataset.canModerate).toBe('true');
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

describe('Dashboard — compléments', () => {
  /** Ouvre « Génie logiciel » (IFT101 sélectionné). */
  async function openGlo(setup: Setup = {}) {
    const utils = renderDashboard(setup);
    await selectProgram('Génie logiciel');
    await waitForCourseSelector('IFT101');
    return utils;
  }

  /** Barre latérale des cours (canaux, forums, quiz). */
  function nav() {
    return screen.getByRole('navigation', { name: 'Cours' });
  }

  /** Ordre d'apparition de libellés dans la barre latérale. */
  function orderInNav(...names: string[]) {
    const text = nav().textContent ?? '';
    return [...names].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  }

  function courses() {
    return ws.captured.courses as unknown as {
      onSectionChange: (courseId: number, type: string, change: ItemChange) => void;
      onQuizUpdated: (courseId: number, quizId: number) => void;
      onQuizReordered: (courseId: number) => void;
      onQuizCreated: (courseId: number) => void;
      onQuizDeleted: (courseId: number, quizId: number) => void;
      onResync: () => void;
    };
  }

  function programsWs() {
    return ws.captured.programs as unknown as {
      onProgramRemove: (id: number) => void;
      onQuizAttemptGraded: (quizId: number, attemptId: number) => void;
      onQuizAttemptFailed: (quizId: number, attemptId: number, reason?: string) => void;
    };
  }

  describe('temps réel : quiz', () => {
    it('verdict de correction reçu via WS : transmis à la vue de quiz ouverte', async () => {
      await openGlo();
      fireEvent.click(screen.getByText('Quiz intro'));
      act(() => programsWs().onQuizAttemptGraded(7, 99));
      expect(JSON.parse(screen.getByTestId('quiz-view').dataset.outcome ?? '')).toEqual({
        quizId: 7,
        attemptId: 99,
        ok: true,
      });
      act(() => programsWs().onQuizAttemptFailed(7, 100, 'délai dépassé'));
      expect(JSON.parse(screen.getByTestId('quiz-view').dataset.outcome ?? '')).toEqual({
        quizId: 7,
        attemptId: 100,
        ok: false,
        reason: 'délai dépassé',
      });
    });

    it('quiz ouvert modifié via WS : liste rechargée, bannière affichée puis retirée au rechargement', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([{ id: 7, title: 'Quiz intro v2' }]);
      await openGlo();
      fireEvent.click(screen.getByText('Quiz intro'));
      expect(screen.getByTestId('quiz-view').dataset.stale).toBe('false');

      act(() => courses().onQuizUpdated(10, 7));
      expect(screen.getByTestId('quiz-view').dataset.stale).toBe('true');
      expect(api.fetchPublishedQuizzes).toHaveBeenCalledWith(10);
      await waitFor(() => expect(within(nav()).getByText('Quiz intro v2')).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: 'quiz:reload' }));
      expect(screen.getByTestId('quiz-view').dataset.stale).toBe('false');
    });

    it('un autre quiz modifié via WS : pas de bannière sur la vue ouverte', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([{ id: 7, title: 'Quiz intro' }]);
      await openGlo();
      fireEvent.click(screen.getByText('Quiz intro'));
      act(() => courses().onQuizUpdated(10, 8));
      expect(screen.getByTestId('quiz-view').dataset.stale).toBe('false');
    });

    it('quiz réordonnés via WS : la liste suit le nouvel ordre renvoyé par l’API', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([
        { id: 8, title: 'Quiz deux' },
        { id: 7, title: 'Quiz intro' },
      ]);
      await openGlo();
      act(() => courses().onQuizReordered(10));
      await waitFor(() => expect(within(nav()).getByText('Quiz deux')).toBeTruthy());
      expect(api.fetchPublishedQuizzes).toHaveBeenCalledWith(10);
      expect(orderInNav('Quiz intro', 'Quiz deux')).toEqual(['Quiz deux', 'Quiz intro']);
    });

    it('échec du rechargement des quiz : la liste garde son état courant', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockRejectedValue(new Error('panne'));
      await openGlo();
      act(() => courses().onQuizCreated(10));
      await waitFor(() => expect(api.fetchPublishedQuizzes).toHaveBeenCalledWith(10));
      expect(within(nav()).getByText('Quiz intro')).toBeTruthy();
    });

    it('resync avec un quiz ouvert : recharge les cours et marque la vue à recharger', async () => {
      await openGlo();
      fireEvent.click(screen.getByText('Quiz intro'));
      act(() => courses().onResync());
      expect(screen.getByTestId('quiz-view').dataset.stale).toBe('true');
      await waitFor(() => expect(api.fetchCourses).toHaveBeenCalledTimes(2));
      expect(api.fetchCourses).toHaveBeenLastCalledWith(1);
    });

    it('quiz supprimé via WS alors qu’un canal est ouvert : le canal reste affiché', async () => {
      vi.mocked(api.fetchPublishedQuizzes).mockResolvedValue([]);
      await openGlo();
      fireEvent.click(screen.getByText('general'));
      act(() => courses().onQuizDeleted(10, 7));
      await waitFor(() => expect(within(nav()).queryByText('Quiz intro')).toBeNull());
      expect(screen.getByTestId('channel-view').textContent).toBe('general');
    });
  });

  describe('temps réel : sections', () => {
    it('quiz : renommage, création (id suivant), réordre puis suppression', async () => {
      await openGlo();
      act(() => courses().onSectionChange(10, 'quiz', { type: 'rename', id: '7', name: 'Quiz renommé' }));
      expect(within(nav()).getByText('Quiz renommé')).toBeTruthy();

      act(() =>
        courses().onSectionChange(10, 'quiz', { type: 'create', item: { id: '', name: 'Quiz neuf' } })
      );
      expect(within(nav()).getByText('Quiz neuf')).toBeTruthy();
      expect(orderInNav('Quiz neuf', 'Quiz renommé')).toEqual(['Quiz renommé', 'Quiz neuf']);
      // Le quiz créé reçoit l'id max + 1 (= 8) : il est ouvrable et réordonnable par cet id.
      act(() => courses().onSectionChange(10, 'quiz', { type: 'reorder', orderedIds: ['8', '7'] }));
      expect(orderInNav('Quiz neuf', 'Quiz renommé')).toEqual(['Quiz neuf', 'Quiz renommé']);

      act(() => courses().onSectionChange(10, 'quiz', { type: 'delete', id: '7' }));
      expect(within(nav()).queryByText('Quiz renommé')).toBeNull();
      expect(within(nav()).getByText('Quiz neuf')).toBeTruthy();
    });

    it('forum : création avec l’id réel, dédupliquée si l’écho WS arrive deux fois', async () => {
      await openGlo();
      const change: ItemChange = { type: 'create', item: { id: '42', name: 'annonces' } };
      act(() => courses().onSectionChange(10, 'forum', change));
      act(() => courses().onSectionChange(10, 'forum', change));
      expect(within(nav()).getAllByText('annonces')).toHaveLength(1);
      // Ouvrable comme forum (fType 'Thread') avec l'id réel.
      fireEvent.click(within(nav()).getByText('annonces'));
      expect(screen.getByTestId('forum-view').textContent).toBe('annonces');
    });

    it('forum : création sans id → id temporaire, puis réordre limité à la section', async () => {
      await openGlo();
      act(() =>
        courses().onSectionChange(10, 'forum', { type: 'create', item: { id: '', name: 'aide-tp' } })
      );
      expect(within(nav()).getByText('aide-tp')).toBeTruthy();
      expect(orderInNav('entraide', 'aide-tp')).toEqual(['entraide', 'aide-tp']);
      // Id temporaire = max(5, 6) + 1 = 7 ; un id absent de orderedIds est ré-ajouté en fin.
      act(() => courses().onSectionChange(10, 'forum', { type: 'reorder', orderedIds: ['7'] }));
      expect(orderInNav('entraide', 'aide-tp')).toEqual(['aide-tp', 'entraide']);
      // Le canal texte (autre section) n'a pas bougé.
      expect(within(nav()).getByText('general')).toBeTruthy();
    });

    it('forum : un renommage visant un id de la section canaux est ignoré', async () => {
      await openGlo();
      act(() => courses().onSectionChange(10, 'forum', { type: 'rename', id: '5', name: 'pirate' }));
      expect(within(nav()).getByText('general')).toBeTruthy();
      expect(within(nav()).queryByText('pirate')).toBeNull();
    });
  });

  describe('tiroir mobile (selectionKey)', () => {
    beforeEach(() => {
      // Deux éléments du MÊME nom dans le cours : un canal texte et un forum « general ».
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) =>
        id === 1
          ? [
              {
                id: 10,
                code: 'IFT101',
                title: 'Programmation',
                forums: [
                  { id: 5, title: 'general', fType: 'Discussion' },
                  { id: 6, title: 'general', fType: 'Thread' },
                ],
              },
            ]
          : structuredClone(coursesByProgram[id] ?? [])
      );
    });

    function drawerToggle() {
      return document.querySelector<HTMLButtonElement>('[aria-controls="left-menu-drawer"]')!;
    }

    it('passer d’un « general » à un autre du même nom referme le tiroir', async () => {
      await openGlo();
      const [textGeneral, forumGeneral] = within(nav()).getAllByText('general');

      fireEvent.click(drawerToggle());
      expect(drawerToggle().getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(textGeneral);
      expect(screen.getByTestId('channel-view')).toBeTruthy();
      expect(drawerToggle().getAttribute('aria-expanded')).toBe('false');
      // Titre mobile = nom de l'élément ouvert.
      expect(document.querySelector('[role="title"]')?.textContent).toBe('general');

      // Même nom, autre élément : la clé (cours:type:id) change → le tiroir se referme.
      fireEvent.click(drawerToggle());
      fireEvent.click(within(nav()).getAllByText('general')[1] ?? forumGeneral);
      expect(screen.getByTestId('forum-view')).toBeTruthy();
      expect(drawerToggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('sans élément ouvert : titre « Accueil »', async () => {
      await openGlo();
      expect(document.querySelector('[role="title"]')?.textContent).toBe('Accueil');
    });
  });

  describe('délégation des actions de contenu à l’API', () => {
    it('chat : chargement, envoi, édition et suppression routés vers le canal ouvert', async () => {
      await openGlo();
      fireEvent.click(screen.getByText('general'));
      fireEvent.click(screen.getByRole('button', { name: 'chat:fetch' }));
      expect(api.fetchMessages).toHaveBeenCalledWith(5, 40, 20);
      fireEvent.click(screen.getByRole('button', { name: 'chat:send' }));
      expect(api.sendMessage).toHaveBeenCalledWith(5, 'Bonjour', null, 'c-1');
      fireEvent.click(screen.getByRole('button', { name: 'chat:edit' }));
      expect(api.editMessage).toHaveBeenCalledWith(5, 11, 'Modifié');
      fireEvent.click(screen.getByRole('button', { name: 'chat:delete' }));
      expect(api.deleteMessage).toHaveBeenCalledWith(5, 11);
    });

    it('forum : sujets, réponses, création, édition, suppression et vote routés vers le forum ouvert', async () => {
      await openGlo();
      fireEvent.click(screen.getByText('entraide'));
      const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
      click('forum:threads');
      expect(api.fetchThreads).toHaveBeenCalledWith(6, 3, 10);
      click('forum:replies');
      expect(api.fetchReplies).toHaveBeenCalledWith(6, 12);
      click('forum:create');
      expect(api.createPost).toHaveBeenCalledWith(6, 'Contenu', null, 'p-1', 'Titre');
      click('forum:edit');
      expect(api.editPost).toHaveBeenCalledWith(6, 12, 'Nouveau', 'T');
      click('forum:delete');
      expect(api.deletePost).toHaveBeenCalledWith(6, 12);
      click('forum:vote');
      expect(api.votePost).toHaveBeenCalledWith(6, 12, -1);
    });
  });

  describe('confirmations annulées', () => {
    const confirmText = {
      leaveProgram: 'Quitter le programme ?',
      deleteProgram: 'Supprimer le programme ?',
    };

    it('« Annuler » sur « Quitter le programme » : rien n’est appelé', async () => {
      renderDashboard();
      await waitFor(() => expect(programButton('Mathématiques')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Quitter le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByText(confirmText.leaveProgram)).toBeNull();
      expect(api.leaveProgram).not.toHaveBeenCalled();
    });

    it('« Annuler » sur « Supprimer le programme » : rien n’est appelé', async () => {
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Mathématiques')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Supprimer le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByText(confirmText.deleteProgram)).toBeNull();
      expect(api.deleteProgram).not.toHaveBeenCalled();
    });

    it('« Annuler » sur « Quitter le cours » puis « Supprimer le cours » : rien n’est appelé', async () => {
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextLeaveCourse }));
      expect(screen.getByText(/Tu ne verras plus les canaux, quiz et forums de « GIF200 »/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByText('Quitter le cours ?')).toBeNull();

      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextDeleteCourse }));
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByText('Supprimer le cours ?')).toBeNull();
      expect(api.leaveCourse).not.toHaveBeenCalled();
      expect(api.deleteCourse).not.toHaveBeenCalled();
      expect(courseSelector()!.textContent).toBe('GIF200');
    });
  });

  describe('suppression / retrait du programme actif', () => {
    it('supprimer le programme actif bascule sur un autre programme', async () => {
      vi.mocked(api.deleteProgram).mockResolvedValue(undefined);
      await openGlo({ isAdmin: true });
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Supprimer le programme' })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
      await waitFor(() => expect(programButton('Génie info').getAttribute('aria-current')).toBe('page'));
      expect(api.deleteProgram).toHaveBeenCalledWith(1);
      await waitForCourseSelector('GIF200');
    });

    it('tous les programmes retirés via WS : aucune localisation fantôme n’est sauvegardée', async () => {
      const { saveSettings } = await openGlo();
      act(() => {
        programsWs().onProgramRemove(2);
        programsWs().onProgramRemove(3);
      });
      saveSettings.mockClear();
      act(() => programsWs().onProgramRemove(1));
      expect(screen.queryByRole('button', { name: 'Génie logiciel' })).toBeNull();
      expect(screen.getByRole('heading', { name: noProgramLabels.title })).toBeTruthy();
      for (const [arg] of saveSettings.mock.calls) expect(arg.location.programId).toBeGreaterThan(0);
    });
  });

  describe('popups d’édition', () => {
    it('modifier le programme : api.updateProgram puis le rail affiche le nouveau nom', async () => {
      vi.mocked(api.updateProgram).mockResolvedValue(undefined);
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Modifier le programme' })
      );
      fireEvent.change(screen.getByDisplayValue('Génie logiciel'), { target: { value: 'Génie logiciel avancé' } });
      fireEvent.change(screen.getByPlaceholderText('Ex. Promo 71'), { target: { value: 'Promo 72' } });
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await waitFor(() => expect(programButton('Génie logiciel avancé')).toBeTruthy());
      expect(api.updateProgram).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'Génie logiciel avancé', code: 'GLO', cohort: 'Promo 72' })
      );
      expect(screen.queryByText('Mets à jour les informations du programme.')).toBeNull();
    });

    it('modifier le programme : les codes des AUTRES programmes sont réservés', async () => {
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Modifier le programme' })
      );
      fireEvent.change(screen.getByDisplayValue('GLO'), { target: { value: 'GIF' } });
      expect(screen.getByText('Ce code existe déjà dans cet établissement')).toBeTruthy();
    });

    it('modifier le cours : charge les programmes rattachés, api.updateCourse puis le sélecteur suit', async () => {
      vi.mocked(api.fetchCourseProgramIds).mockResolvedValue([2]);
      vi.mocked(api.updateCourse).mockResolvedValue(undefined);
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextEditCourse }));
      await waitFor(() => expect(api.fetchCourseProgramIds).toHaveBeenCalledWith(20));
      fireEvent.change(screen.getByDisplayValue('GIF200'), { target: { value: 'GIF201' } });
      const save = screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement;
      await waitFor(() => expect(save.disabled).toBe(false));
      fireEvent.click(save);
      await waitForCourseSelector('GIF201');
      expect(api.updateCourse).toHaveBeenCalledWith(20, {
        title: 'Circuits',
        code: 'GIF201',
        programIds: [2],
      });
    });

    it('rejoindre des cours : api.joinCourses puis rechargement des cours du programme', async () => {
      vi.mocked(api.fetchProgramCourses).mockResolvedValue([{ id: 30, code: 'MAT100', title: 'Algèbre' }]);
      vi.mocked(api.fetchJoinedCourseIds).mockResolvedValue([]);
      vi.mocked(api.joinCourses).mockResolvedValue([]);
      renderDashboard();
      await selectProgram('Mathématiques');
      await screen.findByText(noCourseLabels.joinCourse);
      vi.mocked(api.fetchCourses).mockResolvedValue([{ id: 30, code: 'MAT100', title: 'Algèbre' }]);

      fireEvent.click(
        within(openProgramContextMenu('Mathématiques')).getByRole('menuitem', { name: 'Rejoindre des cours' })
      );
      fireEvent.click(await screen.findByRole('button', { name: /Algèbre/ }));
      fireEvent.click(screen.getByRole('button', { name: joinCoursesLabels.join }));
      await waitForCourseSelector('MAT100');
      expect(api.joinCourses).toHaveBeenCalledWith(3, [30]);
      expect(api.fetchCourses).toHaveBeenLastCalledWith(3);
    });

    it('ajouter un cours (enseignant) : api.createCourse puis le cours apparaît dans le sélecteur', async () => {
      vi.mocked(api.fetchEstablishments).mockResolvedValue([{ id: 1, name: 'UdeS' }] as never);
      vi.mocked(api.fetchManageableProgramsInEstablishment).mockResolvedValue([
        { id: 2, name: 'Programme GIF', code: 'GIF', cohort: 'P1', color: '#000000' },
      ] as never);
      vi.mocked(api.createCourse).mockResolvedValue({ id: 21, code: 'GIF201', title: 'Structures' });
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.click(
        within(openProgramContextMenu('Génie info')).getByRole('menuitem', { name: 'Ajouter un cours' })
      );
      const control = (label: string) =>
        screen.getByText(label).nextElementSibling?.firstElementChild as HTMLElement;
      fireEvent.click(control(addCourseLabels.establishmentLabel));
      fireEvent.click(await screen.findByText('UdeS'));
      fireEvent.click(control(addCourseLabels.programsLabel));
      fireEvent.click(await screen.findByText('Programme GIF'));
      fireEvent.change(screen.getByPlaceholderText(addCourseLabels.codePlaceholder), { target: { value: 'gif201' } });
      fireEvent.change(screen.getByPlaceholderText(addCourseLabels.titlePlaceholder), { target: { value: 'Structures' } });
      fireEvent.click(screen.getByText(addCourseLabels.save).closest('button')!);

      await waitFor(() =>
        expect(api.createCourse).toHaveBeenCalledWith({ code: 'GIF201', title: 'Structures', programIds: [2] })
      );
      await waitFor(() => expect(screen.queryByText('Ajoute ce cours à un ou plusieurs programmes')).toBeNull());
      fireEvent.click(courseSelector()!);
      expect(within(screen.getByRole('listbox')).getByRole('option', { name: /GIF201/ })).toBeTruthy();
    });

    it('programme sans cours (enseignant) : « Créer un cours » ouvre l’ajout, Échap le ferme', async () => {
      vi.mocked(api.fetchCourses).mockImplementation(async (id: number) =>
        id === 2 ? [] : structuredClone(coursesByProgram[id] ?? [])
      );
      vi.mocked(api.fetchEstablishments).mockResolvedValue([]);
      renderDashboard();
      await selectProgram('Génie info');
      fireEvent.click(await screen.findByText(noCourseLabels.addCourse));
      expect(await screen.findByText('Ajoute ce cours à un ou plusieurs programmes')).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText('Ajoute ce cours à un ou plusieurs programmes')).toBeNull());
    });

    it('cours vide (enseignant) : créer un canal persiste via api.changeSection et l’ajoute à la sidebar', async () => {
      vi.mocked(api.changeSection).mockResolvedValue({ type: 'create', item: { id: '55', name: 'labo-1' } });
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.click(screen.getByText(emptyCourseLabels.createChannel));
      fireEvent.click(screen.getByText('Ajouter un canal'));
      const input = within(screen.getByRole('dialog')).getByRole('textbox');
      fireEvent.change(input, { target: { value: 'labo-1' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() =>
        expect(api.changeSection).toHaveBeenCalledWith(20, 'text', {
          type: 'create',
          item: { id: expect.any(String), name: 'labo-1' },
        })
      );
      await waitFor(() => expect(within(nav()).getByText('labo-1')).toBeTruthy());
      // Fermer l'éditeur : il disparaît.
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText('Modifier les canaux')).toBeNull());
      // Le canal créé porte l'id réel renvoyé par le backend.
      fireEvent.click(within(nav()).getByText('labo-1'));
      expect(screen.getByTestId('channel-view').textContent).toBe('labo-1');
    });

    it('cours vide (enseignant) : « Créer un Forum » ouvre l’éditeur des forums', async () => {
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.click(screen.getByText(emptyCourseLabels.createForum));
      expect(screen.getByText('Modifier les forums')).toBeTruthy();
    });

    it('profil : « Annuler » ferme le popup', async () => {
      renderDashboard();
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Modifier le profil' }));
      expect(screen.getByDisplayValue('Jean')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: profileLabels.cancel }));
      await waitFor(() => expect(screen.queryByText(profileLabels.subtitle)).toBeNull());
    });

    it('journal d’audit : charge les entrées via l’API et se ferme avec Échap', async () => {
      vi.mocked(api.fetchAuditLogs).mockResolvedValue([]);
      renderDashboard({ isAdmin: true, isGuardian: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Journalisation' }));
      await waitFor(() => expect(api.fetchAuditLogs).toHaveBeenCalled());
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByText(auditLabels.title)).toBeNull());
    });
  });

  describe('gestion des rôles', () => {
    const globalRoles = {
      roles: [
        { id: 1, name: ROLE.ADMIN },
        { id: 2, name: ROLE.GUARDIAN },
      ],
      users: [
        { id: 4, username: 'jdoe', firstName: 'Jean', lastName: 'Doe', email: 'j@x.ca', avatarColor: '#123456', role_ids: [2] },
        { id: 8, username: 'ali', firstName: 'Ali', lastName: 'Ba', email: 'a@x.ca', avatarColor: '#654321', role_ids: [1] },
      ],
    };

    async function openGlobalRoles(setup: Setup) {
      vi.mocked(api.fetchGlobalRoles).mockResolvedValue(structuredClone(globalRoles) as never);
      renderDashboard(setup);
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gérer les administrateurs' }));
      await screen.findByText('Administrateurs généraux et gardiens de la plateforme.');
    }

    function section(roleId: number) {
      return document.querySelector<HTMLElement>(`section[data-role-id="${roleId}"]`)!;
    }
    function trashButtons(roleId: number) {
      return section(roleId).querySelectorAll('ul > li > button');
    }

    it('admin général : n’attribue que le rôle Administrateur et ne retire personne', async () => {
      await openGlobalRoles({ isAdmin: true });
      expect(within(section(1)).getByText('Ajouter')).toBeTruthy();
      expect(within(section(2)).queryByText('Ajouter')).toBeNull();
      expect(trashButtons(1)).toHaveLength(0);
      expect(trashButtons(2)).toHaveLength(0);
    });

    it('gardien : attribue tout, retire autrui mais pas son propre rôle gardien', async () => {
      vi.mocked(api.changeGlobalRole).mockResolvedValue(undefined);
      await openGlobalRoles({ isAdmin: true, isGuardian: true });
      expect(within(section(1)).getByText('Ajouter')).toBeTruthy();
      expect(within(section(2)).getByText('Ajouter')).toBeTruthy();
      // Anti-lockout : pas de corbeille sur soi-même (Jean, gardien).
      expect(trashButtons(2)).toHaveLength(0);
      expect(trashButtons(1)).toHaveLength(1);
      fireEvent.click(trashButtons(1)[0]);
      await waitFor(() =>
        expect(api.changeGlobalRole).toHaveBeenCalledWith({ type: 'unassign', roleId: 1, userId: 8 })
      );
    });

    it('gardien : les candidats sont chargés côté serveur avec les paramètres du sélecteur', async () => {
      vi.mocked(api.fetchGlobalRoleCandidates).mockResolvedValue([]);
      await openGlobalRoles({ isAdmin: true, isGuardian: true });
      fireEvent.click(within(section(1)).getByText('Ajouter'));
      await waitFor(() =>
        expect(api.fetchGlobalRoleCandidates).toHaveBeenCalledWith(1, '', expect.any(Number), expect.any(Number))
      );
    });

    it('liste des administrateurs poussée via WS : rôles mappés vers role_ids', async () => {
      await openGlobalRoles({ isAdmin: true });
      const push = ws.captured.adminRoles as (users: unknown[]) => void;
      act(() =>
        push([
          { id: 9, username: 'zoe', firstName: 'Zoé', lastName: 'Zed', email: 'z@x.ca', avatarColor: '#111111', roles: [1] },
          { id: 10, username: 'sans', firstName: 'Sans', lastName: 'Rôle', email: 's@x.ca', avatarColor: '#222222' },
        ])
      );
      expect(within(section(1)).getByText('Zoé Zed')).toBeTruthy();
      expect(within(section(1)).queryByText('Ali Ba')).toBeNull();
      // `roles` absent → aucun rôle (n'apparaît dans aucune section).
      expect(screen.queryByText('Sans Rôle')).toBeNull();
    });

    it('échec du chargement des administrateurs : « Fermer » referme l’erreur', async () => {
      vi.mocked(api.fetchGlobalRoles).mockRejectedValue(new Error('refus'));
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Compte utilisateur' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Gérer les administrateurs' }));
      await screen.findByText('Impossible de charger les administrateurs. Réessaie.');
      fireEvent.click(screen.getByRole('button', { name: errorLabels.close }));
      await waitFor(() =>
        expect(screen.queryByText('Impossible de charger les administrateurs. Réessaie.')).toBeNull()
      );
    });

    it('rôles d’un programme : changements et candidats routés vers le programme ciblé', async () => {
      vi.mocked(api.fetchProgramRoles).mockResolvedValue({
        roles: [{ id: 3, name: ROLE.TEACHER }],
        users: [{ id: 8, username: 'ali', firstName: 'Ali', lastName: 'Ba', email: 'a@x.ca', avatarColor: '#654321', role_ids: [3] }],
      } as never);
      vi.mocked(api.fetchProgramRoleCandidates).mockResolvedValue([]);
      vi.mocked(api.changeRole).mockResolvedValue(undefined);
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Gérer les rôles' })
      );
      await screen.findByText('Gestion des rôles');
      fireEvent.click(trashButtons(3)[0]);
      await waitFor(() =>
        expect(api.changeRole).toHaveBeenCalledWith(1, { type: 'unassign', roleId: 3, userId: 8 })
      );
      fireEvent.click(within(section(3)).getByText('Ajouter'));
      await waitFor(() =>
        expect(api.fetchProgramRoleCandidates).toHaveBeenCalledWith(1, 3, '', expect.any(Number), expect.any(Number))
      );
    });

    it('rôles d’un programme : « Fermer » referme l’erreur de chargement', async () => {
      vi.mocked(api.fetchProgramRoles).mockRejectedValue(new Error('refus'));
      renderDashboard({ isAdmin: true });
      await waitFor(() => expect(programButton('Génie logiciel')).toBeTruthy());
      fireEvent.click(
        within(openProgramContextMenu('Génie logiciel')).getByRole('menuitem', { name: 'Gérer les rôles' })
      );
      await screen.findByText('Impossible de charger les membres du programme. Réessaie.');
      fireEvent.click(screen.getByRole('button', { name: errorLabels.close }));
      await waitFor(() =>
        expect(screen.queryByText('Impossible de charger les membres du programme. Réessaie.')).toBeNull()
      );
    });
  });

  describe('gestion MCP d’un cours', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
          unobserve() {}
        }
      );
    });

    async function openMcp() {
      vi.mocked(api.fetchCourseAnalyses).mockResolvedValue([]);
      vi.mocked(api.fetchPendingAnalysis).mockResolvedValue(true);
      renderDashboard();
      await selectProgram('Génie info');
      await waitForCourseSelector('GIF200');
      fireEvent.contextMenu(courseSelector()!);
      fireEvent.click(screen.getByRole('menuitem', { name: courseLabels.contextMcpManagement }));
      await waitFor(() => expect(api.fetchPendingAnalysis).toHaveBeenCalledWith(20));
      expect(api.fetchCourseAnalyses).toHaveBeenCalledWith(20);
      expect(ws.captured.mcpCourseId).toBe(20);
      return ws.captured.mcp as unknown as {
        onAnalysisFailed: (launcherId: number, reason?: string) => void;
        onAnalysisProgress: (launcherId: number, step: string) => void;
      };
    }

    it('progression et échec : seuls ceux de l’utilisateur courant (lanceur) sont affichés', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mcp = await openMcp();
      act(() => mcp.onAnalysisProgress(99, 'collecting'));
      expect(screen.queryByText('Collecte des données du cours…')).toBeNull();
      act(() => mcp.onAnalysisProgress(me.id, 'collecting'));
      expect(screen.getByText('Collecte des données du cours…')).toBeTruthy();

      act(() => mcp.onAnalysisFailed(99, 'autre'));
      expect(screen.queryByText(/L’analyse n’a pas pu être générée/)).toBeNull();
      act(() => mcp.onAnalysisFailed(me.id, 'Service MCP indisponible'));
      expect(screen.getByText(/L’analyse n’a pas pu être générée/)).toBeTruthy();
      warn.mockRestore();
    });

    it('« Analyser » déclenche api.requestCourseAnalysis pour le cours ciblé', async () => {
      vi.mocked(api.requestCourseAnalysis).mockResolvedValue(undefined);
      const mcp = await openMcp();
      // Débloque l'action (le job en cours échoue) puis relance l'analyse.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      act(() => mcp.onAnalysisFailed(me.id));
      fireEvent.click(screen.getByRole('button', { name: errorLabels.close }));
      fireEvent.click(await screen.findByRole('button', { name: 'Analyser' }));
      await waitFor(() => expect(api.requestCourseAnalysis).toHaveBeenCalledWith(20));
      warn.mockRestore();
    });
  });

  describe('easter egg sans thème explicite', () => {
    it('sans data-theme initial : le second « 8339! » retire l’attribut', () => {
      document.documentElement.removeAttribute('data-theme');
      renderDashboard();
      const type = (keys: string[]) => keys.forEach((key) => fireEvent.keyDown(window, { key }));
      type(['8', '3', '3', '9', '!']);
      expect(document.documentElement.getAttribute('data-theme')).toBe('twee');
      type(['8', '3', '3', '9', '!']);
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });
  });
});
