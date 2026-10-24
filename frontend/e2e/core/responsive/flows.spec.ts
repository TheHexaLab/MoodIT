import { expect, test } from '../fixtures';
import { TEST_PASSWORD } from '../../setup/accounts';
import { FORUM_NAME, QUIZ_NAME, createEnrolledUser, enterCode, mainContent, uniqueSuffix } from '../helpers';
import { courseSelector } from '../admin.helpers';
import { SECOND_COURSE, settingsSaved } from '../dashboard.helpers';
import { pointerDrag } from '../quiz.helpers';
import {
  CHANNEL_NAME,
  PROGRAM_NAME,
  banner,
  closeDrawer,
  courseNav,
  coursePicker,
  drawer,
  expectActionable,
  expectLayout,
  expectNoHorizontalOverflow,
  expectNoScrollableOverflow,
  expectReachable,
  layoutOf,
  longPressCourseSelector,
  openDrawer,
  openSidebarItem,
  pickCourse,
  press,
  selectProgram,
  studentPage,
} from '../responsive.helpers';

// Parcours essentiels, joués avec le geste du profil : `tap` (événements tactiles) sur les
// profils `hasTouch`, clic ailleurs. Comptes neufs à chaque test. Les glisser-déposer passent
// par des Pointer Events souris (`pointerDrag`) : `page.touchscreen` ne sait que « taper », et
// les composants écoutent les Pointer Events (souris ou doigt) — documenté dans le rapport.

const CHANNEL_INPUT = `Envoyer un message dans ${CHANNEL_NAME}`;

test('connexion complète (identifiants puis 2FA) jusqu’à la disposition attendue', async ({
  page,
  baseURL,
  hasTouch,
}) => {
  const { user } = await createEnrolledUser(baseURL!);
  await page.goto('/login');
  await page.getByPlaceholder('exemple@gmail.com').fill(user.email);
  await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
  await press(page.getByRole('button', { name: 'Se connecter →' }), hasTouch);
  await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
  await enterCode(page);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
  await expectLayout(page);
  await expectNoHorizontalOverflow(page);
  // Le menu du compte confirme l'identité connectée.
  await press(page.getByRole('button', { name: 'Compte utilisateur' }), hasTouch);
  await expect(page.getByRole('menu', { name: 'Menu du compte' })).toContainText(`@${user.username}`);
});

test('tiroir → programme → cours → canal → message envoyé et persisté', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!, [SECOND_COURSE.id]);
  const { drawer: isDrawer } = layoutOf(page);
  const content = `Tactile ${uniqueSuffix()}`;

  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await pickCourse(page, 'MAT115', hasTouch); // l'ordre des cours n'est pas garanti (cf. ensureCourse)
  // Changement de cours par le sélecteur (liste portée) : GIF201 puis retour à MAT115.
  await openDrawer(page, hasTouch);
  await press(coursePicker(page), hasTouch);
  const listbox = page.getByRole('listbox');
  await expectReachable(listbox.getByRole('textbox', { name: 'Rechercher un cours…' }));
  await expectActionable(listbox.getByRole('option', { name: new RegExp(`^${SECOND_COURSE.code} `) }), hasTouch, 32);
  await press(listbox.getByRole('option', { name: new RegExp(`^${SECOND_COURSE.code} `) }), hasTouch);
  await expect(courseSelector(page, SECOND_COURSE.code)).toBeVisible();
  await expect(courseNav(page).getByRole('button', { name: SECOND_COURSE.channel })).toBeVisible();
  await press(coursePicker(page), hasTouch);
  await press(listbox.getByRole('option', { name: /^MAT115 / }), hasTouch);
  await expect(courseSelector(page, 'MAT115')).toBeVisible();
  await closeDrawer(page, hasTouch);

  // Dernier emplacement (PUT /api/me/settings, débouncé 1 s) : on l'attend avant de recharger —
  // sans cela le rechargement peut précéder la sauvegarde (le flush keepalive au pagehide ne
  // suffit pas sur WebKit) et la page revient sur « Aucun canal sélectionné ».
  const locationSaved = settingsSaved(page, (s) => s.location?.courseId === 1 && s.location.channel != null);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  if (isDrawer) await expect(banner(page).getByRole('heading')).toHaveText(CHANNEL_NAME);
  const composer = mainContent(page).getByRole('textbox', { name: CHANNEL_INPUT });
  await expectActionable(composer, hasTouch, 32);
  await press(composer, hasTouch);
  await expect(composer).toBeFocused();
  await composer.fill(content);
  await press(mainContent(page).getByRole('button', { name: 'Envoyer le message' }), hasTouch);
  const row = mainContent(page).locator('li[role="message"]').filter({ hasText: content });
  await expect(row).toBeVisible();
  await expect(composer).toHaveValue('');

  // Persisté : présent après rechargement. Le canal est rouvert explicitement : la restauration du
  // dernier emplacement est couverte ailleurs (profile.spec.ts) et échoue par instants sur WebKit.
  await locationSaved;
  await page.reload();
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  await expect(composer).toBeVisible();
  await expect(row).toBeVisible();
  await expectLayout(page);
  await expectNoScrollableOverflow(mainContent(page));
  await context.close();
});

test('publier un sujet et voter', async ({ browser, baseURL, hasTouch }) => {
  const title = `Sujet tactile ${uniqueSuffix()}`;
  const author = await studentPage(browser, baseURL!);
  await selectProgram(author.page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(author.page, FORUM_NAME, hasTouch);
  await press(mainContent(author.page).getByRole('button', { name: '+ Nouveau sujet' }), hasTouch);
  await author.page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await author.page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Publié depuis un écran tactile.');
  await press(author.page.getByRole('button', { name: 'Publier' }), hasTouch);
  const authorCard = mainContent(author.page)
    .getByRole('listitem')
    .filter({ has: author.page.getByRole('heading', { name: title, exact: true }) });
  await expect(authorCard).toBeVisible();
  await expect(authorCard.getByRole('button', { name: 'Voter pour' }).first()).toBeDisabled();

  // Un lecteur vote (bouton du rail ou du pied de post selon la largeur) ; persisté.
  const reader = await studentPage(browser, baseURL!);
  await selectProgram(reader.page, PROGRAM_NAME, hasTouch);
  // Emplacement sauvegardé (débounce 1 s) avant le rechargement plus bas (cf. test précédent).
  const locationSaved = settingsSaved(reader.page, (s) => s.location?.channel != null);
  await openSidebarItem(reader.page, FORUM_NAME, hasTouch);
  const card = mainContent(reader.page)
    .getByRole('listitem')
    .filter({ has: reader.page.getByRole('heading', { name: title, exact: true }) });
  const up = card.getByRole('button', { name: 'Voter pour' }).first();
  await expectReachable(up);
  await press(up, hasTouch);
  await expect(up).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toMatchAriaSnapshot(`
    - button "Voter pour" [pressed]
    - text: "1"
    - button "Voter contre"
  `);
  await locationSaved;
  await reader.page.reload();
  await selectProgram(reader.page, PROGRAM_NAME, hasTouch); // forum rouvert explicitement (cf. test précédent)
  await openSidebarItem(reader.page, FORUM_NAME, hasTouch);
  await expect(card.getByRole('button', { name: 'Voter pour' }).first()).toHaveAttribute('aria-pressed', 'true');
  // L'auteur voit le score en direct (WS post:voted).
  await expect(authorCard).toMatchAriaSnapshot(`
    - button "Voter pour" [disabled]
    - text: "1"
  `);
  await author.context.close();
  await reader.context.close();
});

// Quiz du seed (5 types sauf code, reprises autorisées), chaque question vérifiée sans
// débordement ; navigation par « Suivant » (≤ 900 px les points de progression sont masqués),
// glisser-déposer par Pointer Events, résumé puis revue.
test('répondre au quiz : boutons, glisser-déposer, soumission, résumé et revue', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { drawer: isDrawer } = layoutOf(page);
  const main = mainContent(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, QUIZ_NAME, hasTouch);
  await expect(main).toContainText('Question 1 sur 5');
  const next = main.getByRole('button', { name: 'Suivant' });
  const dots = main.getByRole('button', { name: /^Question \d$/ });
  if (isDrawer) await expect(dots).toHaveCount(0);
  else await expect(dots).toHaveCount(5);

  const checkQuestion = async (i: number) => {
    await expect(main).toContainText(`Question ${i} sur 5`);
    await expectNoHorizontalOverflow(page);
    await expectNoScrollableOverflow(main);
    await expectActionable(main.getByRole('button', { name: 'Précédent' }), hasTouch, 32);
    await expectActionable(main.getByRole('button', { name: i === 5 ? 'Soumettre' : 'Suivant' }), hasTouch, 32);
  };

  // 1. Vrai/Faux — 2. choix unique — 3. choix multiple : boutons aria-pressed.
  await checkQuestion(1);
  await expectActionable(main.getByRole('button', { name: 'Vrai', exact: true }), hasTouch, 32);
  await press(main.getByRole('button', { name: 'Vrai', exact: true }), hasTouch);
  await expect(main.getByRole('button', { name: 'Vrai', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await press(next, hasTouch);
  await checkQuestion(2);
  await press(main.getByRole('button', { name: 'Pile (stack)' }), hasTouch);
  await press(next, hasTouch);
  await checkQuestion(3);
  await expect(main.getByText('Plusieurs réponses possibles.')).toBeVisible();
  await press(main.getByRole('button', { name: 'Python' }), hasTouch);
  await press(main.getByRole('button', { name: 'Java', exact: true }), hasTouch);
  await press(next, hasTouch);

  // 4. Remise en ordre : chaque poignée glissée à sa place.
  await checkQuestion(4);
  const expected = ['Prétraitement', 'Compilation', 'Assemblage', 'Édition des liens'];
  const rows = main.locator('li[data-reorder-id]');
  await expect(rows).toHaveCount(4);
  for (const [i, label] of expected.entries()) {
    if ((await rows.nth(i).innerText()).includes(label)) continue;
    const grip = rows.filter({ hasText: label }).locator('span[aria-hidden]').first();
    await expectReachable(grip);
    await pointerDrag(page, grip, rows.nth(i));
    await expect(rows.nth(i)).toContainText(label);
  }
  await press(next, hasTouch);

  // 5. Association : puces de la réserve vers les zones.
  await checkQuestion(5);
  for (const [item, group] of [
    ['Haskell', 'Fonctionnel'],
    ['Java', 'Orienté objet'],
    ['Prolog', 'Logique'],
    ['C', 'Impératif'],
  ]) {
    const chip = main.locator('[data-zone="__pool__"]').getByText(item, { exact: true });
    const zone = main.locator(`[data-zone="${group}"]`);
    await expectReachable(zone);
    await pointerDrag(page, chip, zone);
    await expect(zone).toContainText(item);
  }
  await expectNoScrollableOverflow(main);
  await press(main.getByRole('button', { name: 'Soumettre' }), hasTouch);

  // Résumé (correction asynchrone) puis revue : « Retour au résumé » masqué ≤ 900 px, le retour
  // se fait par « Terminé » en fin de revue.
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible({ timeout: 30_000 });
  await expect(main).toContainText('8 / 8 points · 5 questions parfaites sur 5');
  await expectNoHorizontalOverflow(page);
  await expectNoScrollableOverflow(main);
  await expectActionable(main.getByRole('button', { name: 'Revoir mes réponses' }), hasTouch, 32);
  await expectActionable(main.getByRole('button', { name: 'Refaire le quiz' }), hasTouch, 32);
  await expectActionable(main.getByRole('button', { name: /^Vrai\/Faux / }), hasTouch, 32);
  await press(main.getByRole('button', { name: 'Revoir mes réponses' }), hasTouch);
  await expect(main.getByText('1 / 1 pts', { exact: true })).toBeVisible();
  const back = main.getByRole('button', { name: 'Retour au résumé' });
  if (isDrawer) {
    await expect(back).toBeHidden();
    for (let i = 1; i < 5; i++) await press(next, hasTouch);
    await expectActionable(main.getByRole('button', { name: 'Terminé' }), hasTouch, 32);
    await press(main.getByRole('button', { name: 'Terminé' }), hasTouch);
  } else {
    await expectReachable(back);
    await press(back, hasTouch);
  }
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible();
  await context.close();
});

// Menu contextuel du cours : appui long de 500 ms sur le sélecteur (profils tactiles, via des
// événements touch synthétiques — cf. `longPressCourseSelector`) ou clic droit (pointeur).
test('menu contextuel du cours : appui long (tactile) ou clic droit', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openDrawer(page, hasTouch);
  const menu = hasTouch
    ? await longPressCourseSelector(page, 'MAT115')
    : await (async () => {
        await courseSelector(page, 'MAT115').click({ button: 'right' });
        const m = page.getByRole('menu', { name: 'Actions du cours MAT115' });
        await expect(m).toBeVisible();
        return m;
      })();
  await expectReachable(menu);
  // Étudiant : la seule action commune ; la liste des cours ne s'est pas ouverte.
  await expect(menu.getByRole('menuitem')).toHaveText(['Quitter le cours']);
  await expectActionable(menu.getByRole('menuitem', { name: 'Quitter le cours' }), hasTouch, 32);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(coursePicker(page)).toHaveAttribute('aria-expanded', 'false');

  // Fermeture par un geste hors du menu (mousedown) : dans le bas du tiroir ouvert (zone vide
  // sous les sections ; le pied de page du compte y est masqué) ou, barre fixe, dans le contenu
  // principal (état « Aucun canal sélectionné »). Puis le sélecteur s'ouvre normalement.
  const target = layoutOf(page).drawer ? drawer(page) : mainContent(page);
  const position = { x: 100, y: layoutOf(page).height - 40 };
  await (hasTouch ? target.tap({ position }) : target.click({ position }));
  await expect(menu).toBeHidden();
  await press(coursePicker(page), hasTouch);
  await expect(page.getByRole('listbox')).toBeVisible();
  await context.close();
});

// Clavier virtuel : Playwright ne l'affiche pas ; on simule la réduction du viewport visuel
// (hauteur divisée par deux, composeur focalisé) et on vérifie que le composeur reste visible
// et non recouvert, sans débordement.
test('clavier virtuel simulé : le composeur reste visible et atteignable', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { width, height } = layoutOf(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  const composer = mainContent(page).getByRole('textbox', { name: CHANNEL_INPUT });
  await press(composer, hasTouch);
  await expect(composer).toBeFocused();

  await page.setViewportSize({ width, height: Math.round(height / 2) });
  await expect(composer).toBeFocused();
  await expectReachable(composer);
  await expectReachable(mainContent(page).getByRole('button', { name: 'Envoyer le message' }));
  await expectNoHorizontalOverflow(page);
  const content = `Clavier ${uniqueSuffix()}`;
  await composer.fill(content);
  await composer.press('Enter');
  await expect(mainContent(page).locator('li[role="message"]').filter({ hasText: content })).toBeVisible();
  await expectReachable(composer);

  await page.setViewportSize({ width, height });
  await expectReachable(composer);
  await expectLayout(page);
  await context.close();
});
