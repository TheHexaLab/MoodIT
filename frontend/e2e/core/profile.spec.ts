import { expect, test, type Page } from './fixtures';
import { storageStatePath } from '../setup/accounts';
import {
  PROGRAM_NAME,
  createEnrolledUser,
  mainContent,
  openCourseItem,
  uniqueSuffix,
} from './helpers';
import { SECOND_COURSE, enrollInCourses, ensureCourse, settingsSaved } from './dashboard.helpers';

// Menu du compte, profil et réglages persistés. Tout ce qui modifie le compte (profil, thème,
// dernier emplacement) se fait sur un compte NEUF : les comptes partagés ne doivent pas changer.

const CHANNEL_NAME = 'Discussion — Mathématiques pour ingénieurs I';

const accountButton = (page: Page) => page.getByRole('button', { name: 'Compte utilisateur' });
const accountMenu = (page: Page) => page.getByRole('menu', { name: 'Menu du compte' });

async function openAccountMenu(page: Page) {
  await accountButton(page).click();
  await expect(accountMenu(page)).toBeVisible();
}

/** Ouvre « Modifier le profil » depuis le menu du compte. */
async function openEditProfile(page: Page) {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Modifier le profil' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeVisible();
}

test('menu du compte : ouverture, Échap et clic extérieur', async ({ browser, baseURL }) => {
  const { user, storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');

  await expect(accountButton(page)).toHaveAttribute('aria-expanded', 'false');
  await openAccountMenu(page);
  await expect(accountButton(page)).toHaveAttribute('aria-expanded', 'true');
  // Carte d'identité en tête du menu.
  await expect(accountMenu(page)).toContainText(`Neuf E2E@${user.username}`);

  await page.keyboard.press('Escape');
  await expect(accountMenu(page)).toBeHidden();

  // Clic à la souris au milieu du contenu principal (le conteneur du menu, plein écran,
  // intercepte le clic : Playwright refuserait de cliquer « sur » le titre).
  await openAccountMenu(page);
  const box = (await mainContent(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(accountMenu(page)).toBeHidden();

  await context.close();
});

// Le thème est un réglage du compte (BD) : il suit l'utilisateur dans un navigateur sans cache
// local, et l'emporte même sur un cache localStorage contraire.
test('mode sombre persisté en BD', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const html = page.locator('html');
  await page.goto('/home');
  await expect(html).toHaveAttribute('data-theme', 'light');

  await openAccountMenu(page);
  const darkSwitch = page.getByRole('menuitemcheckbox', { name: 'Mode sombre' });
  await expect(darkSwitch).toHaveAttribute('aria-checked', 'false');
  const saved = settingsSaved(page, (s) => s.theme === 'dark');
  await darkSwitch.click();
  await expect(darkSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await saved;

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  // Nouveau navigateur (cookies seulement, pas de localStorage) dont le cache local dit
  // « light » : le thème de la BD revient.
  const other = await browser.newContext({ storageState });
  await other.addInitScript(() => localStorage.setItem('moodit-theme', 'light'));
  const otherPage = await other.newPage();
  await otherPage.goto('/home');
  await expect(otherPage.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openAccountMenu(otherPage);
  await expect(otherPage.getByRole('menuitemcheckbox', { name: 'Mode sombre' })).toHaveAttribute(
    'aria-checked',
    'true'
  );

  await other.close();
  await context.close();
});

test('modifier le profil : nom et couleur, « Annuler » ne change rien', async ({
  browser,
  baseURL,
}) => {
  const { user, storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  const avatar = accountButton(page).locator('span').first(); // pastille sans nom accessible

  // « Annuler » : les saisies sont jetées.
  await openEditProfile(page);
  await page.getByRole('textbox', { name: 'Prénom', exact: true }).fill('Jetable');
  await page.getByRole('button', { name: '#7D7D94' }).click();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeHidden();
  await expect(accountButton(page)).toContainText('Neuf E2E');
  await openEditProfile(page);
  await expect(page.getByRole('textbox', { name: 'Prénom', exact: true })).toHaveValue('Neuf');
  await expect(page.getByRole('button', { name: '#7D7D94' })).toHaveAttribute(
    'aria-pressed',
    'false'
  );

  // « Enregistrer » : pied du menu et carte du menu à jour, et persisté (rechargement).
  await page.getByRole('textbox', { name: 'Prénom', exact: true }).fill('Marie');
  await page.getByRole('textbox', { name: 'Nom', exact: true }).fill('Tremblay');
  await page.getByRole('button', { name: '#0F766E' }).click();
  await expect(page.getByRole('button', { name: '#0F766E' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeHidden();
  await expect(accountButton(page)).toContainText(`Marie Tremblay @${user.username}`);
  // Initiales dessinées en CSS (data-initials), hors du texte visible du bouton.
  await expect(avatar).toHaveAttribute('data-initials', 'MT');
  await expect(avatar).toHaveCSS('background-color', 'rgb(15, 118, 110)');

  await page.reload();
  await expect(accountButton(page)).toContainText('Marie Tremblay');
  await expect(avatar).toHaveCSS('background-color', 'rgb(15, 118, 110)');
  await openAccountMenu(page);
  await expect(accountMenu(page)).toContainText('Marie Tremblay');
  await context.close();
});

// WS `user:updated` : un autre utilisateur qui a le canal ouvert voit le nouveau nom de
// l'auteur sans recharger.
test('le nouveau nom s’affiche en direct chez un autre utilisateur', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const text = `Message de profil E2E ${uniqueSuffix()}`;
  const newFirstName = `Renomme${uniqueSuffix()}`;

  const author = await browser.newContext({ storageState });
  const authorPage = await author.newPage();
  await openCourseItem(authorPage, CHANNEL_NAME);
  const composer = authorPage.getByRole('textbox', {
    name: `Envoyer un message dans ${CHANNEL_NAME}`,
  });
  await composer.fill(text);
  await composer.press('Enter');
  await expect(mainContent(authorPage).getByText(text)).toBeVisible();

  const alice = await browser.newContext({ storageState: storageStatePath('alice') });
  const alicePage = await alice.newPage();
  await openCourseItem(alicePage, CHANNEL_NAME);
  const message = mainContent(alicePage).getByRole('listitem').filter({ hasText: text });
  await expect(message).toContainText('Neuf E2E');

  await openEditProfile(authorPage);
  await authorPage.getByRole('textbox', { name: 'Prénom', exact: true }).fill(newFirstName);
  await authorPage.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(accountButton(authorPage)).toContainText(`${newFirstName} E2E`);

  await expect(message).toContainText(`${newFirstName} E2E`);
  await expect(message).not.toContainText('Neuf E2E');

  await alice.close();
  await author.close();
});

test('copier le nom d’utilisateur', async ({ browser, browserName, baseURL }) => {
  const { user, storageState } = await createEnrolledUser(baseURL!);
  // Seul Chromium accorde les permissions du presse-papiers à Playwright (Firefox et WebKit :
  // « Unknown permission »). Ailleurs, l'écriture reste permise au clic mais pas la lecture : on
  // relève le texte que l'app confie à navigator.clipboard.writeText.
  const canReadClipboard = browserName === 'chromium';
  const context = await browser.newContext({
    storageState,
    ...(canReadClipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}),
  });
  if (!canReadClipboard) {
    await context.addInitScript(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text: string) => {
        (window as unknown as { __copied?: string }).__copied = text;
        return original(text);
      };
    });
  }
  const copiedText = () =>
    canReadClipboard
      ? page.evaluate(() => navigator.clipboard.readText())
      : page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
  const page = await context.newPage();
  await page.goto('/home');

  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: "Copier le nom d'utilisateur" }).click();
  await expect(page.getByRole('menuitem', { name: 'Nom copié' })).toBeVisible();
  expect(await copiedText()).toBe(user.username);
  // Le libellé revient de lui-même après 1,5 s.
  await expect(page.getByRole('menuitem', { name: "Copier le nom d'utilisateur" })).toBeVisible();
  await context.close();
});

// Le dernier emplacement (programme → cours → canal) est un réglage du compte : une nouvelle
// session (autre navigateur) y revient directement.
test('le dernier emplacement est restauré à la session suivante', async ({
  browser,
  baseURL,
}) => {
  // Garde (révélée par WebKit) : la restauration du cours et du canal ne doit pas dépendre de la
  // vitesse de la réponse des cours (autrefois abandonnée quand elle arrivait avant le rendu de
  // `coursesLoading === true`).
  const { user, storageState } = await createEnrolledUser(baseURL!);
  await enrollInCourses(baseURL!, storageState, user.id, [1, SECOND_COURSE.id]);

  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  await ensureCourse(page, SECOND_COURSE.code); // l'ordre initial des cours n'est pas garanti
  const saved = settingsSaved(
    page,
    (s) => s.location?.courseId === SECOND_COURSE.id && s.location.channel != null
  );
  await page.getByRole('button', { name: SECOND_COURSE.channel }).click();
  await saved;
  await context.close();

  const next = await browser.newContext({ storageState });
  const nextPage = await next.newPage();
  await nextPage.goto('/home');
  await expect(nextPage.getByRole('button', { name: PROGRAM_NAME })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(
    nextPage.getByRole('navigation', { name: 'Cours' }).getByRole('button', {
      name: SECOND_COURSE.code,
      exact: true,
    })
  ).toBeVisible();
  await expect(nextPage.getByRole('button', { name: SECOND_COURSE.channel })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await expect(
    nextPage.getByRole('textbox', { name: `Envoyer un message dans ${SECOND_COURSE.channel}` })
  ).toBeVisible();
  await next.close();
});

// Easter eggs : thèmes éphémères posés sur <html data-theme>, refaire la séquence les annule.
test('easter eggs « kiwi » et « twee »', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const html = page.locator('html');
  await page.goto('/home');
  await expect(accountButton(page)).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'light');

  const konami = async () => {
    for (const key of [
      'ArrowUp',
      'ArrowUp',
      'ArrowDown',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'ArrowLeft',
      'ArrowRight',
      'b',
      'a',
    ]) {
      await page.keyboard.press(key);
    }
  };
  await konami();
  await expect(html).toHaveAttribute('data-theme', 'kiwi');
  await konami();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.keyboard.type('8339!');
  await expect(html).toHaveAttribute('data-theme', 'twee');
  // Non persisté : un rechargement revient au thème normal.
  await page.reload();
  await expect(accountButton(page)).toBeVisible();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await context.close();
});
