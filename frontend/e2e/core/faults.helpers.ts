import {
  expect,
  request,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { ROLE_ACCOUNTS, uniqueSuffix } from './helpers';
import {
  apiAs,
  assignProgramRoleApi,
  confirmationPopup,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  freshAccount,
  openHome,
  programButton,
  type TestProgram,
} from './admin.helpers';

/**
 * Aides des specs « chemins d'erreur », « défilements » et « détails » : injection de pannes
 * réseau, popup d'erreur, et préparation par l'API d'un programme / cours de test complet
 * (canal, forum, quiz) avec des comptes NEUFS à rôles, pour ne jamais toucher au seed.
 */

// ── Injection de pannes ────────────────────────────────────────────────────────────────────

/** `server` = HTTP 500 ; `network` = requête interrompue (panne réseau, `route.abort`). */
export type Fault = 'server' | 'network';
export const FAULTS: Fault[] = ['server', 'network'];

/**
 * Fait échouer les requêtes `method` vers `url` (glob Playwright) dans `page`, jusqu'à l'appel
 * de la fonction renvoyée. Les autres méthodes sur la même URL passent normalement.
 */
export async function injectFault(
  page: Page,
  url: string | RegExp,
  fault: Fault,
  method?: string
): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    if (method && route.request().method() !== method) return route.fallback();
    if (fault === 'server') {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'panne simulée (E2E)' }),
      });
    }
    return route.abort('connectionfailed');
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

/** Popup d'erreur (ErrorPopup, titre « Une erreur est survenue » sauf `title`). */
export const errorPopup = (page: Page, title = 'Une erreur est survenue') =>
  confirmationPopup(page, title);

/** Attend le popup d'erreur avec `message`, puis le ferme par « Fermer ». */
export async function expectErrorAndClose(page: Page, message: string, title?: string) {
  const popup = errorPopup(page, title);
  await expect(popup).toContainText(message);
  await popup.getByRole('button', { name: 'Fermer' }).click();
  await expect(popup).toBeHidden();
}

/**
 * Joue `attempt` sous chaque type de panne (500, puis coupure réseau) sur `url`/`method` : à
 * chaque fois `onFailure` vérifie l'affichage d'erreur (et l'état conservé) ; la route est
 * ensuite rétablie et `attempt` rejouée une dernière fois (succès attendu par l'appelant).
 */
export async function underFaultsThenRecover(
  page: Page,
  url: string | RegExp,
  method: string,
  attempt: () => Promise<void>,
  onFailure: (fault: Fault) => Promise<void>
) {
  for (const fault of FAULTS) {
    const restore = await injectFault(page, url, fault, method);
    await attempt();
    await onFailure(fault);
    await restore();
  }
  await attempt();
}

// ── Préparation par l'API ──────────────────────────────────────────────────────────────────

/**
 * Session gardien courte (API seulement) : le compte est partagé et n'a qu'un jeton actif, on
 * ne la garde jamais ouverte au-delà d'une étape.
 */
export async function asGardien<T>(baseURL: string, action: (api: APIRequestContext) => Promise<T>) {
  const api = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
  try {
    return await action(api);
  } finally {
    await api.dispose();
  }
}

export interface TestCourse {
  id: number;
  code: string;
  title: string;
}

/** Ajoute un canal (`text`) ou un forum à un cours ; renvoie l'id réel de la section. */
export async function addSectionApi(
  api: APIRequestContext,
  courseId: number,
  sectionType: 'text' | 'forum',
  name: string
): Promise<number> {
  const res = await api.patch(`/api/courses/${courseId}/sections`, {
    data: { sectionType, change: { type: 'create', item: { id: `tmp-${name}`, name } } },
  });
  expect(res.ok(), `création de la section ${name} : HTTP ${res.status()}`).toBe(true);
  const applied = (await res.json()) as { type: string; item?: { id: string } };
  expect(applied.item?.id, 'id de la section créée').toBeDefined();
  return Number(applied.item!.id);
}

/** Quiz publié d'une question Vrai/Faux (réponse « Vrai ») ; renvoie son id. */
export async function addTrueFalseQuizApi(
  api: APIRequestContext,
  courseId: number,
  title: string,
  options: { isDaily?: boolean; isPublished?: boolean; prompts?: string[] } = {}
): Promise<number> {
  const prompts = options.prompts ?? ['Le ciel est bleu.'];
  const res = await api.post(`/api/courses/${courseId}/quizzes`, {
    data: {
      title,
      isPublished: options.isPublished ?? true,
      isDaily: options.isDaily ?? false,
      allowRetry: true,
      questions: prompts.map((prompt, i) => ({
        qType: 'true_false',
        prompt,
        totalScore: 1,
        orderIndex: i,
        answers: [
          { content: 'Vrai', isCorrect: true },
          { content: 'Faux', isCorrect: false },
        ],
      })),
    },
  });
  expect(res.ok(), `création du quiz : HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

/** Programme + cours de test (gardien) : le cours a un canal, un forum et, si demandé, un quiz. */
export interface Fixture {
  program: TestProgram;
  course: TestCourse;
  channelId: number;
  channelName: string;
  forumId: number;
  forumName: string;
}

export async function createFixture(baseURL: string, prefix: string): Promise<Fixture> {
  return asGardien(baseURL, async (api) => {
    const program = await createProgramApi(api, prefix);
    const course = await createCourseApi(api, [program.id], prefix.slice(0, 2));
    const channelName = `canal-${uniqueSuffix()}`;
    const forumName = `forum-${uniqueSuffix()}`;
    const channelId = await addSectionApi(api, course.id, 'text', channelName);
    const forumId = await addSectionApi(api, course.id, 'forum', forumName);
    return { program, course, channelId, channelName, forumId, forumName };
  });
}

export async function deleteFixture(baseURL: string, fixture: Fixture | undefined) {
  if (!fixture) return;
  await asGardien(baseURL, async (api) => {
    await deleteCourseApi(api, fixture.course.id);
    await deleteProgramApi(api, fixture.program.id);
  });
}

/**
 * Compte NEUF membre du programme (et inscrit au cours), avec un rôle de programme optionnel
 * donné par le gardien. Renvoie l'état de session (le client API est libéré).
 */
export async function member(
  baseURL: string,
  fixture: Pick<Fixture, 'program' | 'course'>,
  role?: 'Enseignant' | 'Administrateur'
) {
  const account = await freshAccount(baseURL);
  await enrollApi(account.api, fixture.program.id, [fixture.course.id]);
  await account.api.dispose();
  if (role) {
    await asGardien(baseURL, (api) =>
      assignProgramRoleApi(api, fixture.program.id, account.user.id, role)
    );
  }
  return { user: account.user, storageState: account.storageState };
}

/** Client API sur une session existante (même jeton que le navigateur). */
export const apiFor = (baseURL: string, storageState: StorageState) =>
  request.newContext({ baseURL, storageState });

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/** Ouvre /home puis le programme de test (son unique cours s'ouvre de lui-même). */
export async function openProgram(browser: Browser, storageState: StorageState, program: TestProgram) {
  const opened = await openHome(browser, storageState);
  await programButton(opened.page, program.name).click();
  await expect(programButton(opened.page, program.name)).toHaveAttribute('aria-current', 'page');
  return opened;
}

/** Barre latérale du cours. */
export const courseNav = (page: Page) => page.getByRole('navigation', { name: 'Cours' });

/** Élément (canal / forum / quiz) de la barre latérale du cours. */
export const sidebarItem = (page: Page, name: string): Locator =>
  courseNav(page).getByRole('button', { name, exact: true });

// ── Contenus par l'API ─────────────────────────────────────────────────────────────────────

/** Publie un message dans un canal ; renvoie son id. */
export async function postMessageApi(api: APIRequestContext, channelId: number, content: string) {
  const res = await api.post('/api/forums/messages', {
    data: { forumId: channelId, parentPostId: null, content, clientMessageId: uniqueSuffix() },
  });
  expect(res.ok(), `envoi du message : HTTP ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

/** Publie un sujet (ou une réponse si `parentId`) dans un forum ; renvoie son id. */
export async function postThreadApi(
  api: APIRequestContext,
  forumId: number,
  content: string,
  title: string | null,
  parentId: number | null = null
) {
  const res = await api.post('/api/forums/posts', {
    data: { forumId, parentPostId: parentId, content, title, clientPostId: uniqueSuffix() },
  });
  expect(res.ok(), `publication du sujet : HTTP ${res.status()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

// ── Courriels (Mailpit) ────────────────────────────────────────────────────────────────────

const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

/** Nombre de courriels reçus par `to` dont le sujet contient `subject`. */
export async function countMails(to: string, subject: string): Promise<number> {
  const api = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    const res = await api.get('/api/v1/search', {
      params: { query: `to:"${to}" subject:"${subject}"`, limit: 50 },
    });
    const { messages } = (await res.json()) as { messages: unknown[] };
    return messages.length;
  } finally {
    await api.dispose();
  }
}
