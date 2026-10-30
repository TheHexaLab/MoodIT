import { randomBytes } from 'node:crypto';
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { DEV_2FA_CODE, TEST_COURSE_ID, TEST_PASSWORD, TEST_PROGRAM_ID } from '../setup/accounts';

/** Noms du seed d'init.sql pour le programme / cours de test (ids 1). */
export const PROGRAM_NAME = 'Génie informatique';
export const FORUM_NAME = 'Thread — Mathématiques pour ingénieurs I';
export const QUIZ_NAME = 'Quiz découverte — tous les types (sauf code)';

/** Suffixe unique par exécution : la BD de dev persiste entre deux runs locaux. */
// Suffixe unique des noms de comptes et de contenus de test. `randomBytes` plutôt que
// `Math.random` : le suffixe entre dans des identifiants de compte, CodeQL (js/insecure-randomness)
// exige une source cryptographique pour tout ce qui ressemble à un identifiant.
export const uniqueSuffix = () => `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;

export interface FreshUser {
  username: string;
  email: string;
}

/**
 * Nouvel identifiant de compte. Domaine `e2e.test` (dev-db.sql) par défaut ; `MAIL_DOMAIN` pour
 * un compte dont le test lit les courriels.
 */
export function newUser(domain = 'e2e.test'): FreshUser {
  const username = `e2e_${uniqueSuffix()}`;
  return { username, email: `${username}@${domain}` };
}

async function expectOk(res: Awaited<ReturnType<APIRequestContext['get']>>, step: string) {
  expect(res.ok(), `${step} : HTTP ${res.status()} ${await res.text()}`).toBe(true);
}

/**
 * Comptes à rôles créés par e2e/core/bootstrap.sh (mot de passe TEST_PASSWORD) :
 *  - gardien : rôle global Gardien (établissements, journal d'audit, administrateurs, programmes) ;
 *  - padmin  : Administrateur du programme 1 (rôles du programme, modification, modération) ;
 *  - prof    : Enseignant du programme 1 (cours, sections, quiz, analyse MCP ; NE modère PAS).
 */
export const ROLE_ACCOUNTS = {
  gardien: 'gardien@e2e.test',
  padmin: 'padmin@e2e.test',
  prof: 'prof@e2e.test',
} as const;

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/**
 * Ouvre une session par l'API (identifiants + 2FA de dev) et, sauf `enroll: false`, abonne le
 * compte au programme et au cours de test (idempotent). Renvoie l'état de session (cookie) à
 * passer à `browser.newContext({ storageState })`.
 */
export async function sessionAs(
  baseURL: string,
  email: string,
  { enroll = true }: { enroll?: boolean } = {}
): Promise<{ id: number; storageState: StorageState }> {
  const ctx = await request.newContext({ baseURL });
  try {
    await expectOk(
      await ctx.post('/auth/login', { data: { email, password: TEST_PASSWORD } }),
      `connexion de ${email}`
    );
    await expectOk(
      await ctx.post('/auth/verify-2fa', { data: { email, code: DEV_2FA_CODE } }),
      `2FA de ${email}`
    );
    const { id } = (await (await ctx.get('/api/me')).json()) as { id: number };
    if (enroll) {
      await expectOk(
        await ctx.post('/api/programs/users', { data: { id, programIds: [TEST_PROGRAM_ID] } }),
        `abonnement de ${email} au programme`
      );
      await expectOk(
        await ctx.post('/api/courses/users', {
          data: { id, courseIds: [TEST_COURSE_ID], programId: TEST_PROGRAM_ID },
        }),
        `inscription de ${email} au cours`
      );
    }
    return { id, storageState: await ctx.storageState() };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Compte NEUF, validé, connecté, abonné au programme et au cours de test (sauf `enroll: false`).
 * Pour les parcours à état unique par compte (une tentative de quiz, des essais 2FA ratés) ou
 * qui modifient le compte : rejouables sans nettoyer la BD.
 */
export async function createEnrolledUser(
  baseURL: string,
  domain?: string,
  { enroll = true }: { enroll?: boolean } = {}
) {
  const user = newUser(domain);
  const ctx = await request.newContext({ baseURL });
  try {
    await expectOk(
      await ctx.post('/auth/register', {
        data: {
          username: user.username,
          firstName: 'Neuf',
          lastName: 'E2E',
          email: user.email,
          password: TEST_PASSWORD,
        },
      }),
      `inscription de ${user.email}`
    );
    await expectOk(await ctx.get(`/auth/verify/${user.username}`), 'validation dev');
  } finally {
    await ctx.dispose();
  }
  const { id, storageState } = await sessionAs(baseURL, user.email, { enroll });
  return { user: { ...user, id }, storageState };
}

/**
 * Saisit un code dans les 6 cases de /verify-code (la page valide seule dès que 6 chiffres sont
 * présents). Les cases sont d'abord vidées : après un essai raté elles restent pleines, et
 * remplacer un seul chiffre soumettrait aussitôt un code hybride (essai raté de plus).
 */
export async function enterCode(page: Page, code: string = DEV_2FA_CODE) {
  const boxes = page.getByRole('group', { name: 'Code à 6 chiffres' }).getByRole('textbox');
  for (let i = 5; i >= 0; i--) {
    await boxes.nth(i).fill('');
  }
  for (const [i, digit] of [...code].entries()) {
    await boxes.nth(i).fill(digit);
  }
}

/** Connexion complète par l'UI (identifiants puis 2FA) ; s'arrête sur /home. */
export async function loginThroughUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('exemple@gmail.com').fill(email);
  await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Se connecter →' }).click();
  await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
  await enterCode(page);
  await expect(page).toHaveURL(/\/home(\/|$)/);
}

/** Ouvre le programme de test puis un élément de la barre du cours (quiz, canal ou forum). */
export async function openCourseItem(page: Page, itemName: string) {
  await page.goto('/home');
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  await page.getByRole('button', { name: itemName }).click();
}

export const mainContent = (page: Page) => page.getByRole('region', { name: 'Contenu principal' });

/**
 * Attend que la popup ouverte (la dernière, s'il y en a plusieurs) ne bouge plus : même boîte sur
 * deux mesures espacées. Une popup est centrée : quand son contenu change (chargement, retour d'une
 * vue détaillée), elle change de taille et se recentre, et ses boutons se déplacent. Un clic lancé
 * pendant ce mouvement tombe à côté (vu sur Firefox et WebKit). À appeler avant de cliquer dans une
 * popup juste après un changement de vue ou un chargement.
 */
export async function waitForPopupSettled(page: Page) {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  await waitForSettled(dialog, 'popup immobile (taille et position stables)');
}

/**
 * Attend que `locator` garde la même boîte sur deux mesures espacées de 150 ms. Pour un élément
 * qu'une action déplace (ex. un sujet de forum trié par popularité, qui change de place à chaque
 * vote) : un clic lancé pendant le déplacement tombe à côté.
 */
export async function waitForSettled(locator: Locator, message = 'élément immobile') {
  await expect
    .poll(
      async () => {
        const before = JSON.stringify(await locator.boundingBox());
        await locator.page().waitForTimeout(150);
        return before === JSON.stringify(await locator.boundingBox());
      },
      { message }
    )
    .toBe(true);
}

/** API de Mailpit (faux SMTP de la pile E2E, docker-compose-e2e.yml). */
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

/**
 * Domaine des comptes dont les tests LISENT les courriels (validation, réinitialisation).
 * Distinct de `e2e.test` : la branche vocale bloque l'envoi vers les TLD réservés (.test…).
 * Non routable (TLD inexistant) ; établissement créé par e2e/core/bootstrap.sh.
 */
export const MAIL_DOMAIN = 'e2e.courriel';

/**
 * Code à 6 chiffres du DERNIER courriel reçu par `to` dont le sujet contient `subject`. Attend
 * jusqu'à 15 s : l'envoi est asynchrone (@Async côté auth-service).
 */
export async function readCodeFromMail(to: string, subject: string): Promise<string> {
  const api = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    let code: string | undefined;
    await expect
      .poll(
        async () => {
          const res = await api.get('/api/v1/search', {
            params: { query: `to:"${to}" subject:"${subject}"`, limit: 1 },
          });
          const { messages } = (await res.json()) as { messages: { Snippet: string }[] };
          code = messages[0]?.Snippet.match(/\b(\d{6})\b/)?.[1];
          return code;
        },
        { message: `courriel « ${subject} » pour ${to}`, timeout: 15_000 }
      )
      .toBeTruthy();
    return code!;
  } finally {
    await api.dispose();
  }
}
