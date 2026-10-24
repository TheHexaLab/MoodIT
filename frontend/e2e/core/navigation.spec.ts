import { devices, expect, test, type Browser, type Page } from './fixtures';
import { FORUM_NAME, PROGRAM_NAME, QUIZ_NAME, createEnrolledUser, mainContent } from './helpers';
import { SECOND_COURSE, enrollInCourses, ensureCourse } from './dashboard.helpers';

// Barre latérale : rail des programmes, sélecteur de cours, sections, poignée de
// redimensionnement, états vides et tiroir mobile. Comptes neufs : la navigation enregistre le
// dernier emplacement dans les réglages du compte.

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
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  await ensureCourse(page, 'MAT115'); // l'ordre des cours n'est pas garanti, cf. ensureCourse
  await expect(courseSelect(page, 'MAT115')).toBeVisible();
  return { context, page };
}

test('rail des programmes : la sélection marque le programme courant', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  const program = page
    .getByRole('navigation', { name: 'Programme' })
    .getByRole('button', { name: PROGRAM_NAME });
  await expect(program).not.toHaveAttribute('aria-current', 'page');
  await program.click();
  await expect(program).toHaveAttribute('aria-current', 'page');
  await expect(
    mainContent(page).getByRole('heading', { name: 'Aucun canal sélectionné' })
  ).toBeVisible();
  await expect(courseSelect(page, 'MAT115')).toBeVisible();
  await context.close();
});

test('sélecteur de cours : recherche, « Aucun résultat », Échap, changement de cours', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await openProgramWithTwoCourses(browser, baseURL!);
  const listbox = page.getByRole('listbox');
  const search = listbox.getByRole('textbox', { name: 'Rechercher un cours…' });

  await courseSelect(page, 'MAT115').click();
  await expect(courseSelect(page, 'MAT115')).toHaveAttribute('aria-expanded', 'true');
  await expect(listbox.getByRole('option')).toHaveCount(2);
  await expect(listbox.getByRole('option', { name: /^MAT115/ })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(search).toBeFocused();

  await search.fill('GIF');
  await expect(listbox.getByRole('option')).toHaveCount(1);
  await expect(listbox.getByRole('option', { name: /^GIF201/ })).toBeVisible();

  await search.fill('zzz-aucun-cours');
  await expect(listbox.getByRole('option')).toHaveCount(0);
  await expect(listbox.getByText('Aucun résultat')).toBeVisible();

  await search.press('Escape');
  await expect(listbox).toBeHidden();
  await expect(courseSelect(page, 'MAT115')).toHaveAttribute('aria-expanded', 'false');

  // Changer de cours : le sélecteur et la liste des canaux suivent.
  await courseSelect(page, 'MAT115').click();
  await listbox
    .getByRole('option', { name: `${SECOND_COURSE.code} ${SECOND_COURSE.title}` })
    .click();
  await expect(listbox).toBeHidden();
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

test('compte sans programme : « Bienvenue sur MoodIT », sans création de programme', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  const main = mainContent(page);
  await expect(main.getByRole('heading', { name: 'Bienvenue sur MoodIT' })).toBeVisible();
  await expect(main.getByRole('button', { name: '+ Rejoindre un programme' })).toBeVisible();
  // Créer un programme est réservé aux administrateurs globaux.
  await expect(main.getByRole('button', { name: '+ Ajouter un programme' })).toHaveCount(0);
  // Rail vide (seul le bouton d'ajout) et barre des cours vide.
  await expect(
    page.getByRole('navigation', { name: 'Programme' }).getByRole('listitem')
  ).toHaveCount(0);
  await expect(courseNav(page).getByText('Aucun cours', { exact: true })).toBeVisible();
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
    await drawer.getByRole('button', { name: PROGRAM_NAME }).click();
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
