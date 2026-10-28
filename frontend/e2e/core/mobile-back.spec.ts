import { devices, expect, test, type Page } from './fixtures';
import { createEnrolledUser, FORUM_NAME, loginThroughUi, PROGRAM_NAME } from './helpers';

// Bogue #63 : toute l'app vivait sous /home et la connexion empilait /login puis /verify-code dans
// l'historique. Le bouton « back » du téléphone ramenait alors à l'écran de code : impression de
// déconnexion. Désormais la vue (programme, cours, canal) est dans l'URL et l'écran de code est
// remplacé à la connexion : « back » navigue entre les vues et ne quitte jamais la session.

const CHANNEL_NAME = 'Discussion — Mathématiques pour ingénieurs I';

// Émulation téléphone, sans `defaultBrowserType` (interdit dans un test.use de fichier).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

const AUTH_SCREEN = /\/(login|verify-code|register)$/;
const accountButton = (page: Page) => page.getByRole('button', { name: 'Compte utilisateur' });
const mobileTitle = (page: Page) => page.getByRole('banner').getByRole('heading');

/** Ouvre un élément du cours de test depuis le tiroir mobile (qui se referme ensuite). */
async function openFromDrawer(page: Page, name: string) {
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  const drawer = page.getByRole('complementary', { name: 'Menus lateraux' });
  await expect(drawer).toBeInViewport();
  await drawer.getByRole('button', { name }).click();
  await expect(mobileTitle(page)).toContainText(name);
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName === 'firefox', 'Firefox ne prend pas en charge isMobile.');
});

test('« back » après connexion ne ramène pas à un écran d’authentification', async ({
  page,
  baseURL,
}) => {
  const { user } = await createEnrolledUser(baseURL!);
  await loginThroughUi(page, user.email);
  await page.goBack();

  await expect(page).not.toHaveURL(AUTH_SCREEN);
  await expect(accountButton(page)).toBeVisible();
});

test('« back » entre deux vues : retour à la vue précédente, toujours connecté', async ({
  page,
  baseURL,
}) => {
  const { user } = await createEnrolledUser(baseURL!);
  await loginThroughUi(page, user.email);

  // Programme (depuis le tiroir), puis un canal, puis un forum : trois entrées d'historique.
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('complementary', { name: 'Menus lateraux' })
    .getByRole('button', { name: PROGRAM_NAME })
    .click();
  await expect(page).toHaveURL(/\/home\/p\/\d+(\/c\/\d+)?$/);
  await openFromDrawer(page, CHANNEL_NAME);
  await expect(page).toHaveURL(/\/home\/p\/\d+\/c\/\d+\/text\/\d+$/);
  await openFromDrawer(page, FORUM_NAME);
  await expect(page).toHaveURL(/\/home\/p\/\d+\/c\/\d+\/forum\/\d+$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/home\/p\/\d+\/c\/\d+\/text\/\d+$/);
  await expect(mobileTitle(page)).toContainText(CHANNEL_NAME);
  await expect(accountButton(page)).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/home\/p\/\d+(\/c\/\d+)?$/);
  await expect(mobileTitle(page)).not.toContainText(CHANNEL_NAME);
  await expect(accountButton(page)).toBeVisible();

  // Encore « back » : l'entrée de la connexion a été remplacée, on reste dans l'app.
  await page.goBack();
  await expect(page).not.toHaveURL(AUTH_SCREEN);
  await expect(accountButton(page)).toBeVisible();
});

test('lien vers un forum : la vue s’ouvre directement, même après rechargement', async ({
  page,
  baseURL,
}) => {
  const { user } = await createEnrolledUser(baseURL!);
  await loginThroughUi(page, user.email);
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
  await page
    .getByRole('complementary', { name: 'Menus lateraux' })
    .getByRole('button', { name: PROGRAM_NAME })
    .click();
  await openFromDrawer(page, FORUM_NAME);
  const forumUrl = page.url();

  await page.reload();
  await expect(page).toHaveURL(forumUrl);
  await expect(mobileTitle(page)).toContainText(FORUM_NAME);
});
