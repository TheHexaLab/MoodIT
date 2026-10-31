import { expect, test, type APIResponse, type BrowserContext, type Page } from './fixtures';
import {
  FORUM_NAME,
  createEnrolledUser,
  mainContent,
  openCourseItem,
  uniqueSuffix,
} from './helpers';

// En-têtes de sécurité envoyés par l'image nginx du frontend (#93, frontend/nginx/security-headers.conf),
// et absence de violation de la CSP (bloquante) sur les écrans principaux, KaTeX et pages statiques
// compris : une ressource refusée casserait l'écran sans erreur visible ailleurs.
// HSTS n'est pas attendu ici : c'est Caddy, devant nginx en prod, qui le pose.

const EXPECTED: Record<string, string | RegExp> = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': /camera=\(self\), microphone=\(self\),.*geolocation=\(\)/,
  'content-security-policy': /^default-src 'self'; script-src 'self' 'sha256-.*frame-ancestors 'none'$/,
};

/** Chaque en-tête attendu est présent UNE fois (nginx retire ceux des services) avec sa valeur. */
function expectSecurityHeaders(response: APIResponse, what: string) {
  const headers = response.headersArray();
  for (const [name, value] of Object.entries(EXPECTED)) {
    const values = headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);
    expect(values, `${name} sur ${what}`).toHaveLength(1);
    if (typeof value === 'string') expect(values[0], `${name} sur ${what}`).toBe(value);
    else expect(values[0], `${name} sur ${what}`).toMatch(value);
  }
  expect(response.headers()['strict-transport-security'], `HSTS sur ${what}`).toBeUndefined();
  expect(
    response.headers()['content-security-policy-report-only'],
    `CSP Report-Only sur ${what}`
  ).toBeUndefined();
}

test('en-têtes de sécurité sur la page, les fichiers du build et une erreur de l’API', async ({
  request,
}) => {
  const home = await request.get('/');
  expect(home.status()).toBe(200);
  expectSecurityHeaders(home, '/');

  // Fichier haché du build : la location /assets/ peut poser ses propres en-têtes (cache), elle
  // doit garder ceux de sécurité (add_header_inherit merge).
  const asset = (await home.text()).match(/\/assets\/[^"]+\.js/)?.[0];
  expect(asset, 'script du build dans index.html').toBeTruthy();
  const assetResponse = await request.get(asset!);
  expect(assetResponse.status()).toBe(200);
  expectSecurityHeaders(assetResponse, asset!);

  // Refus du gateway (requête sans jeton) relayé par nginx : réponse d'erreur (`always`), et les
  // en-têtes posés par les services sont remplacés par ceux de nginx.
  const api = await request.get('/api/me');
  expect(api.status()).toBe(401);
  expectSecurityHeaders(api, '/api/me');
});

/** Note chaque violation de CSP dès la création du document. */
async function recordCspViolations(context: BrowserContext) {
  await context.addInitScript(() => {
    const store = window as unknown as { cspViolations: string[] };
    store.cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      store.cspViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations);

test('aucune violation de la CSP : authentification, pages statiques, tableau de bord, forum avec KaTeX', async ({
  browser,
  baseURL,
}) => {
  const guest = await browser.newContext();
  await recordCspViolations(guest);
  const guestPage = await guest.newPage();
  for (const path of ['/login', '/register', '/forgot-password']) {
    await guestPage.goto(path);
    await expect(guestPage.getByRole('img', { name: 'Logo MoodIT' })).toBeVisible();
    await guestPage.evaluate(() => document.fonts.ready);
    expect(await violations(guestPage), path).toEqual([]);
  }
  // Pages statiques de public/ : scripts et styles en fichiers (SheetJS, schéma SVG de la BD).
  for (const path of ['/plan-de-test.html', '/schema-bd.html']) {
    await guestPage.goto(path, { waitUntil: 'load' });
    expect(await violations(guestPage), path).toEqual([]);
  }
  await guest.close();

  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  await recordCspViolations(context);
  const page = await context.newPage();
  await openCourseItem(page, FORUM_NAME);

  // Sujet avec une équation : le HTML de KaTeX porte des attributs style="…" et charge ses polices.
  const title = `CSP KaTeX ${uniqueSuffix()}`;
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await page
    .getByRole('textbox', { name: 'Éditeur Markdown' })
    .fill('Équation $\\frac{a}{b} + \\sqrt{x^2}$ et code `print(1)`');
  await page.getByRole('button', { name: 'Publier' }).click();
  const card = mainContent(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card.locator('.katex-html').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  expect(await violations(page)).toEqual([]);
});
