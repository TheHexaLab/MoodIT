import {
  expect,
  request,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { DEV_2FA_CODE, TEST_COURSE_ID, TEST_PASSWORD, TEST_PROGRAM_ID } from '../setup/accounts';
import { createEnrolledUser, uniqueSuffix } from './helpers';

/**
 * Aides des specs de gestion (programmes, cours, sections, rôles, établissements, audit).
 * La préparation (créer un programme / un cours de test) passe par l'API pour que chaque test
 * n'exerce par l'UI que le parcours qu'il vérifie.
 */

/** Établissement des comptes `@e2e.test` (dev-db.sql) : y vivent les programmes créés par les tests. */
export const E2E_ESTABLISHMENT = 'MoodIT E2E (dev)';
/** Établissement du programme 1 du seed (Génie informatique). */
export const SEED_ESTABLISHMENT = 'Université de Sherbrooke';

/**
 * Client API connecté (identifiants + 2FA de dev), SANS toucher aux abonnements du compte.
 * Attention : session UNIQUE par compte (le gateway ne valide que le dernier jeton émis) ; toute
 * nouvelle connexion du même compte (apiAs, sessionAs…) invalide celle-ci. Voir `sessionFor`.
 */
export async function apiAs(baseURL: string, email: string): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL });
  for (const [path, data] of [
    ['/auth/login', { email, password: TEST_PASSWORD }],
    ['/auth/verify-2fa', { email, code: DEV_2FA_CODE }],
  ] as const) {
    const res = await api.post(path, { data });
    expect(res.ok(), `${path} pour ${email} : HTTP ${res.status()}`).toBe(true);
  }
  return api;
}

async function json<T>(
  res: Awaited<ReturnType<APIRequestContext['get']>>,
  step: string
): Promise<T> {
  expect(res.ok(), `${step} : HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

/** Id d'un établissement d'après son domaine courriel. */
export async function establishmentId(api: APIRequestContext, domain = 'e2e.test') {
  const list = await json<{ id: number; domainEmail: string }[]>(
    await api.get('/api/establishments'),
    'liste des établissements'
  );
  const found = list.find((e) => e.domainEmail === domain);
  expect(found, `établissement ${domain}`).toBeDefined();
  return found!.id;
}

/** Cohorte des programmes créés par createProgramApi. */
export const PROGRAM_COHORT = 'Promo E2E';

export interface TestProgram {
  id: number;
  name: string;
  code: string;
}

/** Nom + code uniques d'un programme de test (code en majuscules, comme le formulaire). */
export function newProgramIdentity(prefix = 'Prog'): { name: string; code: string } {
  const suffix = uniqueSuffix();
  return { name: `E2E ${prefix} ${suffix}`, code: `P${suffix}`.toUpperCase() };
}

/**
 * Programme de test dans l'établissement `domain` (`e2e.test` par défaut), créé par un admin global (gardien). L'API
 * n'abonne PAS le créateur (c'est le frontend qui le fait après coup).
 */
export async function createProgramApi(
  api: APIRequestContext,
  prefix = 'Prog',
  domain = 'e2e.test'
): Promise<TestProgram> {
  const identity = newProgramIdentity(prefix);
  const created = await json<{ id: number }>(
    await api.post('/api/establishments/programs', {
      data: {
        ...identity,
        cohort: PROGRAM_COHORT,
        color: '#0F766E',
        establishmentId: await establishmentId(api, domain),
      },
    }),
    'création du programme'
  );
  return { id: created.id, ...identity };
}

/** Cours de test rattaché aux programmes donnés (créé par un admin global ou un enseignant). */
export async function createCourseApi(
  api: APIRequestContext,
  programIds: number[],
  prefix = 'C'
): Promise<{ id: number; code: string; title: string }> {
  const code = `${prefix}${uniqueSuffix()}`.toUpperCase();
  const title = `Cours E2E ${code}`;
  const created = await json<{ id: number }>(
    await api.post('/api/programs/courses', { data: { code, title, programIds } }),
    'création du cours'
  );
  return { id: created.id, code, title };
}

/** Abonne (ajout seul, sans retrait) le compte au programme et l'inscrit aux cours donnés. */
export async function enrollApi(
  api: APIRequestContext,
  programId: number,
  courseIds: number[] = []
) {
  const { id } = await json<{ id: number }>(await api.get('/api/me'), 'profil');
  const sub = await api.post('/api/programs/users', { data: { id, programIds: [programId] } });
  expect(sub.ok(), `abonnement au programme ${programId}`).toBe(true);
  if (courseIds.length > 0) {
    const res = await api.post('/api/courses/users', { data: { id, courseIds, programId } });
    expect(res.ok(), `inscription aux cours ${courseIds.join(',')}`).toBe(true);
  }
}

/** Id d'un rôle d'après son nom (Enseignant, Administrateur, Gardien). */
export async function roleId(api: APIRequestContext, name: string, scope: 'program' | 'global') {
  const roles = await json<{ id: number; name: string }[]>(
    await api.get(`/api/roles?scope=${scope}`),
    'liste des rôles'
  );
  const found = roles.find((r) => r.name === name);
  expect(found, `rôle ${name}`).toBeDefined();
  return found!.id;
}

/**
 * Donne un rôle de programme à un compte (par un Administrateur du programme ou un admin global).
 * Réservé aux comptes NEUFS : les rôles des comptes partagés ne doivent pas changer.
 */
export async function assignProgramRoleApi(
  api: APIRequestContext,
  programId: number,
  userId: number,
  role: 'Enseignant' | 'Administrateur'
) {
  const res = await api.post('/api/roles/change', {
    data: { type: 'assign', roleId: await roleId(api, role, 'program'), userId, programId },
  });
  expect(res.ok(), `rôle ${role} à ${userId} : HTTP ${res.status()}`).toBe(true);
}

/** Nettoyage best effort (le programme a pu être supprimé par le test lui-même). */
export async function deleteProgramApi(api: APIRequestContext, programId: number) {
  await api.delete(`/api/programs/${programId}`);
}

/** Nettoyage best effort d'un cours de test. */
export async function deleteCourseApi(api: APIRequestContext, courseId: number) {
  await api.delete(`/api/courses/${courseId}`);
}

/** Échappe un texte pour l'insérer dans une RegExp (noms avec parenthèses, points…). */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compte NEUF (sans abonnement) + client API sur la MÊME session ; `storageState` sert à ouvrir
 * le navigateur avec ce compte.
 */
export async function freshAccount(baseURL: string) {
  const { user } = await createEnrolledUser(baseURL, undefined, { enroll: false });
  const api = await apiAs(baseURL, user.email);
  return { user, api, storageState: await api.storageState() };
}

/** Nouveau contexte navigateur ouvert sur /home avec la session donnée. */
export async function openHome(
  browser: Browser,
  storageState: Awaited<ReturnType<APIRequestContext['storageState']>>
) {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  return { context, page };
}

/**
 * Session d'un compte pour un test : client API ET navigateur (/home) sur le MÊME jeton, avec une
 * seule connexion (deux connexions successives s'invalideraient). `enroll` : abonnement (ajout
 * seul) au programme 1 et inscription à MAT115, comme `sessionAs`.
 */
export async function sessionFor(
  browser: Browser,
  baseURL: string,
  email: string,
  { enroll = true }: { enroll?: boolean } = {}
) {
  const api = await apiAs(baseURL, email);
  if (enroll) await enrollApi(api, TEST_PROGRAM_ID, [TEST_COURSE_ID]);
  const home = await openHome(browser, await api.storageState());
  return {
    api,
    ...home,
    close: async () => {
      await api.dispose();
      await home.context.close();
    },
  };
}

/** Pastille d'un programme dans le rail (nom accessible = nom du programme). */
export const programButton = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Programme' }).getByRole('button', { name, exact: true });

/** Sélecteur de cours de la barre latérale (texte = code du cours actif). */
export const courseSelector = (page: Page, code: string) =>
  page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: code, exact: true });

/**
 * Menus contextuels (clic droit). Ils se referment au moindre défilement de la page : un canal
 * ouvert qui reçoit des messages d'autres specs (défilement auto) peut donc les fermer à tout
 * moment. Ouverture + lecture / clic sont faites d'un bloc, réessayé jusqu'à réussite.
 */
async function withContextMenu(
  target: Locator,
  menu: Locator,
  action: (menu: Locator) => Promise<void>
) {
  await expect(async () => {
    if (!(await menu.isVisible())) await target.click({ button: 'right' });
    await action(menu);
  }).toPass();
}

const programMenu = (page: Page, name: string) =>
  [programButton(page, name), page.getByRole('menu')] as const;
const courseMenu = (page: Page, code: string) =>
  [
    courseSelector(page, code),
    page.getByRole('menu', { name: `Actions du cours ${code}` }),
  ] as const;

const expectItems = (items: string[]) => (menu: Locator) =>
  expect(menu.getByRole('menuitem')).toHaveText(items, { timeout: 1_000 });
const clickItem = (item: string) => (menu: Locator) =>
  menu.getByRole('menuitem', { name: item, exact: true }).click({ timeout: 1_000 });

/** Vérifie la liste EXACTE des actions du menu contextuel d'un programme. */
export const expectProgramMenu = (page: Page, name: string, items: string[]) =>
  withContextMenu(...programMenu(page, name), expectItems(items));

/** Choisit une action du menu contextuel d'un programme. */
export const clickProgramMenu = (page: Page, name: string, item: string) =>
  withContextMenu(...programMenu(page, name), clickItem(item));

/** Vérifie la liste EXACTE des actions du menu contextuel d'un cours. */
export const expectCourseMenu = (page: Page, code: string, items: string[]) =>
  withContextMenu(...courseMenu(page, code), expectItems(items));

/** Choisit une action du menu contextuel d'un cours. */
export const clickCourseMenu = (page: Page, code: string, item: string) =>
  withContextMenu(...courseMenu(page, code), clickItem(item));

/** Ouvre le menu du compte (bas de la barre latérale). */
export async function openUserMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Compte utilisateur' }).click();
  const menu = page.getByRole('menu', { name: 'Menu du compte' });
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * Popup de confirmation (DeleteConfirmationPopup, sans rôle dialog) : bloc titre + boutons,
 * remonté depuis son titre. Utile quand un autre popup ouvert derrière a des boutons homonymes.
 */
export const confirmationPopup = (page: Page, title: string) =>
  page.getByRole('heading', { name: title, exact: true }).locator('xpath=../..');
