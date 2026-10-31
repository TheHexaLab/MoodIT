import { devices, expect, test, type Browser, type Page } from './fixtures';
import { courseTile, enterProgram, programButton } from './admin.helpers';
import { FORUM_NAME, PROGRAM_NAME, QUIZ_NAME, createEnrolledUser, mainContent } from './helpers';
import { SECOND_COURSE, enrollInCourses, ensureCourse } from './dashboard.helpers';

// Barre latérale : barre du portail (complète et réduite), panneau du cours, sections, poignée de
// redimensionnement, états vides et tiroir mobile.

const CHANNEL_NAME = 'Discussion — Mathématiques pour ingénieurs I';

const courseNav = (page: Page) => page.getByRole('navigation', { name: 'Cours' });
const courseSelect = (page: Page, code: string) =>
  courseNav(page).getByRole('button', { name: code, exact: true });

/** Compte neuf inscrit à MAT115 et GIF201, sur /home avec le programme de test ouvert. */
async function openProgramWithTwoCourses(browser: Browser, baseURL: string) {
  const { user, storageState } = await createEnrolledUser(baseURL);
  await enrollInCourses(baseURL, storageState, user.id, [1, SECOND_COURSE.id]);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  await enterProgram(page, PROGRAM_NAME);
  await ensureCourse(page, 'MAT115'); // l'ordre des cours n'est pas garanti, cf. ensureCourse
  await expect(courseSelect(page, 'MAT115')).toBeVisible();
  return { context, page };
}

test('Accueil : ouvrir un cours depuis la barre, puis y revenir', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  const home = page.getByRole('navigation', { name: 'Portail' }).getByRole('link', { name: 'Accueil' });
  await expect(home).toHaveAttribute('aria-current', 'page');
  await expect(mainContent(page).getByRole('heading', { name: /^Bonjour/ })).toBeVisible();

  // Le nom du programme ne s'ouvre pas au clic.
  await programButton(page, PROGRAM_NAME).click();
  await expect(page).toHaveURL(/\/home$/);

  await courseTile(page, 'MAT115').click();
  await expect(page).toHaveURL(/\/home\/p\/\d+\/c\/\d+$/);
  await expect(home).not.toHaveAttribute('aria-current', 'page');
  await expect(courseTile(page, 'MAT115')).toHaveAttribute('aria-current', 'page');
  await expect(
    mainContent(page).getByRole('heading', { name: 'Aucun canal sélectionné' })
  ).toBeVisible();
  await expect(courseSelect(page, 'MAT115')).toBeVisible();

  await home.click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(mainContent(page).getByRole('heading', { name: /^Bonjour/ })).toBeVisible();
  await context.close();
});

test('la barre de l’Accueil se réduit et se déplie sans déplacer ses icônes, et le choix est gardé', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  const icon = page.getByRole('navigation', { name: 'Portail' }).locator('svg').first();
  const tile = courseTile(page, 'MAT115').locator('span').first();
  await expect(tile).toBeVisible();
  const before = [await icon.boundingBox(), await tile.boundingBox()];

  await page.getByRole('button', { name: 'Réduire le menu' }).click();
  const expand = page.getByRole('button', { name: 'Déplier le menu' });
  await expect(expand).toBeVisible();
  await expect(programButton(page, PROGRAM_NAME)).toBeHidden();
  await expect.poll(async () => (await icon.boundingBox())?.x).toBe(before[0]!.x);
  await expect.poll(async () => (await tile.boundingBox())?.x).toBe(before[1]!.x);
  expect((await tile.boundingBox())!.width).toBe(before[1]!.width);

  await page.reload();
  await expect(expand).toBeVisible();

  await expand.click();
  await expect(page.getByRole('button', { name: 'Réduire le menu' })).toBeVisible();
  await expect(programButton(page, PROGRAM_NAME)).toBeVisible();
  await context.close();
});

test('dans un cours : barre toujours réduite, panneau qui se réduit en bande sans disparaître', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);
  await expect(page.getByRole('button', { name: 'Déplier le menu' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Réduire le menu' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Réduire le panneau du cours' }).click();
  const reopen = page.getByRole('button', { name: 'Déplier le panneau du cours' });
  await expect(reopen).toBeVisible();
  await expect.poll(async () => Math.round((await reopen.locator('xpath=ancestor::nav[1]').boundingBox())!.width)).toBe(48);
  await expect(courseNav(page).getByRole('button', { name: CHANNEL_NAME })).toBeHidden();

  await reopen.click();
  await expect(courseNav(page).getByRole('button', { name: CHANNEL_NAME })).toBeVisible();

  // Réduit, puis un autre cours : le panneau se rouvre, avec les canaux de ce cours.
  await page.getByRole('button', { name: 'Réduire le panneau du cours' }).click();
  await courseTile(page, SECOND_COURSE.code).click();
  await expect(courseNav(page).getByRole('button', { name: SECOND_COURSE.channel })).toBeVisible();
  await context.close();
});

test('le titre d’un cours n’ouvre rien au clic ; changer de cours passe par la barre', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);

  await courseSelect(page, 'MAT115').click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(0);

  await courseTile(page, SECOND_COURSE.code).click();
  await expect(courseSelect(page, SECOND_COURSE.code)).toBeVisible();
  await expect(courseNav(page).getByRole('button', { name: SECOND_COURSE.channel })).toBeVisible();
  await expect(courseNav(page).getByRole('button', { name: CHANNEL_NAME })).toHaveCount(0);
  await context.close();
});

test('sections QUIZ / CANAUX / FORUMS : repli et dépli', async ({ browser, baseURL }) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);

  for (const [section, item] of [
    ['QUIZ', QUIZ_NAME],
    ['CANAUX', CHANNEL_NAME],
    ['FORUMS', FORUM_NAME],
  ]) {
    const region = courseNav(page).getByRole('region', { name: section });
    const toggle = region.getByRole('button', { name: section, exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(region.getByRole('button', { name: item })).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(region.getByRole('button', { name: item })).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(region.getByRole('button', { name: item })).toBeVisible();
  }
  await context.close();
});

test('sélection d’un canal puis d’un forum : un seul élément courant', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);
  const channel = courseNav(page).getByRole('button', { name: CHANNEL_NAME });
  const forum = courseNav(page).getByRole('button', { name: FORUM_NAME });

  await channel.click();
  await expect(channel).toHaveAttribute('aria-current', 'page');
  await expect(forum).not.toHaveAttribute('aria-current', 'page');
  await expect(
    mainContent(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` })
  ).toBeVisible();

  await forum.click();
  await expect(forum).toHaveAttribute('aria-current', 'page');
  await expect(channel).not.toHaveAttribute('aria-current', 'page');
  await expect(mainContent(page).getByRole('button', { name: '+ Nouveau sujet' })).toBeVisible();
  await context.close();
});

// Largeur pilotée au clavier (±16 px par flèche), mémorisée dans localStorage
// (`courseMenu:width`) ; le double-clic revient à la largeur par défaut.
test('poignée de redimensionnement : clavier, persistance, double-clic', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);
  const handle = page.getByRole('separator', { name: 'Redimensionner le menu des cours' });
  const width = async () => Math.round((await courseNav(page).boundingBox())!.width);
  const initial = await width();

  await handle.focus();
  await handle.press('ArrowRight');
  await handle.press('ArrowRight');
  await expect.poll(width).toBe(initial + 32);
  await handle.press('ArrowLeft');
  await expect.poll(width).toBe(initial + 16);
  expect(await page.evaluate(() => localStorage.getItem('courseMenu:width'))).toBe(
    String(initial + 16)
  );

  await page.reload();
  await expect(courseNav(page)).toBeVisible();
  await expect.poll(width).toBe(initial + 16);

  await handle.dblclick();
  await expect.poll(width).toBe(initial);
  expect(await page.evaluate(() => localStorage.getItem('courseMenu:width'))).toBeNull();
  await context.close();
});

test('compte sans programme : Accueil et « Rejoindre un programme », sans création', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  await expect(mainContent(page).getByRole('heading', { name: /^Bonjour/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rejoindre un programme', exact: true })).toBeVisible();
  // Liste vide.
  await expect(
    page.getByRole('navigation', { name: 'Programme' }).getByRole('listitem')
  ).toHaveCount(0);
  // Créer un programme est réservé aux administrateurs globaux : le menu du logo ne le propose pas.
  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /Créer un programme/ })).toHaveCount(0);
  await context.close();
});

test.describe('vue mobile', () => {
  // Émulation téléphone, sans `defaultBrowserType` (interdit dans un test.use).
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

  test('tiroir des menus : ouverture, fond, Échap', async ({ page, browserName, baseURL }) => {
    test.skip(browserName === 'firefox', 'Firefox ne prend pas en charge isMobile.');
    const { storageState } = await createEnrolledUser(baseURL!);
    await page.context().addCookies(storageState.cookies);
    await page.goto('/home');

    const drawer = page.getByRole('complementary', { name: 'Menus lateraux' });
    const open = page.getByRole('button', { name: 'Ouvrir le menu' });
    // Hors écran tant qu'il est fermé (présent dans le DOM, translaté de -100 %). WebKit, avec le
    // DPR fractionnaire du Pixel 7, laisse un liseré sous-pixel dans la fenêtre (ratio ~0,0004) :
    // « fermé » = moins de 1 % visible.
    const expectClosed = () => expect(drawer).not.toBeInViewport({ ratio: 0.01 });
    await expectClosed();

    await open.click();
    await expect(
      page.getByRole('banner').getByRole('button', { name: 'Fermer le menu' })
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toBeInViewport();
    // Ouvrir un cours referme le tiroir ; le rouvrir montre le panneau du cours.
    await drawer.getByRole('button', { name: /MAT115/ }).click();
    await expectClosed();
    await open.click();
    await expect(drawer.getByRole('button', { name: CHANNEL_NAME })).toBeVisible();

    // Le fond assombri referme le tiroir (clic hors du tiroir, à droite).
    const viewportSize = page.viewportSize()!;
    await page.mouse.click(viewportSize.width - 10, viewportSize.height / 2);
    await expectClosed();
    await expect(open).toHaveAttribute('aria-expanded', 'false');

    await open.click();
    await expect(drawer).toBeInViewport();
    await page.keyboard.press('Escape');
    await expectClosed();
  });
});
