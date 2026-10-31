import { expect, test } from '../fixtures';
import { FORUM_NAME, QUIZ_NAME, mainContent, uniqueSuffix } from '../helpers';
import { courseSelector } from '../admin.helpers';
import { settingsSaved } from '../dashboard.helpers';
import {
  CHANNEL_NAME,
  PROGRAM_NAME,
  banner,
  closeDrawer,
  coursePicker,
  drawer,
  expectDrawerClosed,
  expectLayout,
  expectNoHorizontalOverflow,
  expectNoScrollableOverflow,
  expectReachable,
  layoutOf,
  openDrawer,
  openSidebarItem,
  press,
  selectProgram,
  studentPage,
} from '../responsive.helpers';

// Disposition de l'application selon la largeur du viewport (tiroir ≤ 900 px ou barre fixe),
// comportement tactile, rotation et menu du compte. Chaque test déduit ses attentes de
// `page.viewportSize()` pour avoir un sens sur les 8 profils (3 bureaux, 2 tablettes, 3 mobiles).

test('disposition selon la largeur : tiroir + barre mobile (≤ 900 px) ou barre latérale fixe', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { drawer: isDrawer, width } = layoutOf(page);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
  await expectLayout(page);
  await expectNoHorizontalOverflow(page);

  // Rail des programmes : 4.5rem (72 px) de large, à gauche du tiroir ou de la barre fixe.
  await openDrawer(page, hasTouch);
  const rail = page.getByRole('navigation', { name: 'Programme' });
  await expect(rail).toBeInViewport({ ratio: 1 });
  const railBox = (await rail.boundingBox())!;
  expect(Math.round(railBox.width)).toBe(72);
  if (isDrawer) {
    // Tiroir = 90 vw ; le rail garde sa largeur et le menu des cours prend le reste.
    const drawerBox = (await drawer(page).boundingBox())!;
    expect(drawerBox.x).toBe(0);
    expect(Math.round(drawerBox.width)).toBe(Math.round(width * 0.9));
    await expect(banner(page).getByRole('button', { name: 'Fermer le menu' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  }

  // Sélection du programme : le sélecteur de cours et les sections apparaissent dans le même
  // conteneur (tiroir ou barre) ; le titre de la barre mobile reste « Accueil » sans canal.
  await press(rail.getByRole('button', { name: PROGRAM_NAME }), hasTouch);
  await expect(courseSelector(page, 'MAT115')).toBeVisible();
  await expectReachable(coursePicker(page));
  for (const section of ['QUIZ', 'CANAUX', 'FORUMS']) {
    await expectReachable(
      page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: section, exact: true })
    );
  }
  await expectReachable(page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: CHANNEL_NAME }));
  if (isDrawer) {
    await expect(banner(page).getByRole('heading')).toHaveText('Accueil');
    await closeDrawer(page, hasTouch);
    await expectLayout(page);
  }
  await expect(mainContent(page).getByRole('heading', { name: 'Aucun canal sélectionné' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await context.close();
});

// Les actions d'un message (répondre / modifier / supprimer) sont révélées au survol sur un
// appareil à pointeur (`hover: hover`) et au toucher de la ligne sur un appareil tactile
// (`hover: none`), y compris la tablette paysage de 1024 px dont la barre reste fixe. Sous
// 768 px la barre d'actions flotte en haut à droite du message, au-dessus du texte.
test('actions d’un message : au survol (pointeur) ou au toucher de la ligne (tactile)', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { dense } = layoutOf(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  const content = `Responsive actions ${uniqueSuffix()}`;
  const composer = mainContent(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` });
  await composer.fill(content);
  await composer.press('Enter');
  const row = mainContent(page).locator('li[data-role="message"]').filter({ hasText: content });
  await expect(row).toBeVisible();
  const actions = row.locator('[data-role="message-actions"]');
  const reply = row.getByRole('button', { name: 'Répondre au message' });

  // Le média `hover: none` suit le profil : vrai sur toutes les tablettes et tous les mobiles.
  const hoverNone = await page.evaluate(() => matchMedia('(hover: none)').matches);
  expect(hoverNone).toBe(hasTouch);

  // Au repos : actions invisibles (opacité 0, sans pointer-events) sur tous les profils.
  await page.mouse.move(0, 0);
  await expect(actions).toHaveCSS('opacity', '0');
  await expect(actions).toHaveCSS('pointer-events', 'none');

  if (hasTouch) {
    // Le survol ne révèle rien ; le toucher de la ligne ouvre les actions (data-actions).
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '0');
    await row.tap();
    await expect(row).toHaveAttribute('data-actions', 'open');
    await expect(actions).toHaveCSS('opacity', '1');
    await expectReachable(reply);
    // Second toucher : refermé.
    await row.tap();
    await expect(row).not.toHaveAttribute('data-actions', 'open');
    await expect(actions).toHaveCSS('opacity', '0');
  } else {
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expectReachable(reply);
  }

  // Sous 768 px la barre d'actions sort du flux (flottante) ; au-delà elle reste en ligne.
  await expect(actions).toHaveCSS('position', dense ? 'absolute' : 'static');
  await expectNoScrollableOverflow(mainContent(page));
  await context.close();
});

// Rotation en cours de session (`setViewportSize` portrait ⇄ paysage) : la disposition suit la
// nouvelle largeur, l'état (programme, cours, canal ouverts) reste en place, rien ne déborde.
// Sur un bureau 1280×720, le « portrait » (720 px de large) bascule en tiroir : la transition
// est exercée dans les deux sens sur tous les profils.
test('rotation portrait ⇄ paysage : disposition adaptée, état conservé, aucun débordement', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const initial = page.viewportSize()!;
  const rotated = { width: initial.height, height: initial.width };
  const composer = mainContent(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` });
  const channel = page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: CHANNEL_NAME });
  const program = page.getByRole('navigation', { name: 'Programme' }).getByRole('button', { name: PROGRAM_NAME });

  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  await expect(composer).toBeVisible();

  for (const size of [rotated, initial]) {
    await page.setViewportSize(size);
    expect(layoutOf(page).width).toBe(size.width);
    await expectLayout(page);
    // État conservé : programme courant, cours MAT115, canal courant et son composeur.
    await expect(program).toHaveAttribute('aria-current', 'page');
    await expect(courseSelector(page, 'MAT115')).toHaveCount(1);
    await expect(channel).toHaveAttribute('aria-current', 'page');
    await expectReachable(composer);
    if (layoutOf(page).drawer) {
      await expect(banner(page).getByRole('heading')).toHaveText(CHANNEL_NAME);
    }
    await expectNoHorizontalOverflow(page);
    await expectNoScrollableOverflow(mainContent(page));
  }

  // Un tiroir ouvert avant la rotation reste ouvert après (état React conservé), puis se
  // referme normalement.
  if (layoutOf(page).drawer) {
    await openDrawer(page, hasTouch);
    await page.setViewportSize(rotated);
    if (layoutOf(page).drawer) await expect(drawer(page)).toBeInViewport({ ratio: 1 });
    await page.setViewportSize(initial);
    await expect(drawer(page)).toBeInViewport({ ratio: 1 });
    await closeDrawer(page, hasTouch);
    await expectLayout(page);
  }
  await context.close();
});

// Menu du compte : feuille collée en bas avec fond (≤ 900 px, déclencheur compact de la barre
// mobile) ou popover ancré au-dessus du pied de page (barre fixe). Dans les deux cas la bascule
// « Mode sombre » est persistée en BD (PUT /api/me/settings) et survit au rechargement.
test('menu du compte : feuille basse ou popover, bascule du thème persistée', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { drawer: isDrawer, height } = layoutOf(page);
  const trigger = page.getByRole('button', { name: 'Compte utilisateur' });
  const menu = page.getByRole('menu', { name: 'Menu du compte' });
  const sheetBackdrop = page.getByRole('button', { name: 'Fermer le menu du compte' });
  await expect(trigger).toBeVisible();

  await press(trigger, hasTouch);
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expectReachable(menu);
  const menuBox = (await menu.boundingBox())!;
  const triggerBox = (await trigger.boundingBox())!;
  if (isDrawer) {
    // Feuille : pleine largeur (moins les marges), collée au bas de l'écran, fond cliquable.
    await expect(sheetBackdrop).toBeVisible();
    expect(menuBox.y + menuBox.height).toBeGreaterThan(height - 24);
    // Largeur min(100 % − 2rem, 25rem), à quelques px près selon le moteur (arrondis, barre).
    expect(menuBox.width).toBeGreaterThanOrEqual(Math.min(layoutOf(page).width - 2 * 16 - 8, 400 - 8));
  } else {
    // Popover de 15rem (+ marges intérieures et bordure), juste au-dessus du déclencheur.
    await expect(sheetBackdrop).toHaveCount(0);
    expect(menuBox.width).toBeGreaterThanOrEqual(240);
    expect(menuBox.width).toBeLessThanOrEqual(260);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y + 1);
  }
  for (const item of ['Modifier le profil', "Copier le nom d'utilisateur", 'Se déconnecter']) {
    await expectReachable(page.getByRole('menuitem', { name: item }));
  }

  const darkSwitch = page.getByRole('menuitemcheckbox', { name: 'Mode sombre' });
  await expectReachable(darkSwitch);
  const saved = settingsSaved(page, (s) => s.theme === 'dark');
  await press(darkSwitch, hasTouch);
  await expect(darkSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await saved;

  // Fermeture : fond de la feuille au tactile, clic hors du menu sinon.
  if (isDrawer) {
    // Le fond est plein écran sous la feuille : on vise sa partie haute, hors de la feuille.
    const position = { x: layoutOf(page).width / 2, y: 20 };
    await (hasTouch ? sheetBackdrop.tap({ position }) : sheetBackdrop.click({ position }));
  } else {
    const box = (await mainContent(page).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectNoHorizontalOverflow(page);
  await context.close();
});

// Disposition tiroir : choisir un canal dans le tiroir le referme (sinon le contenu resterait
// caché derrière ses 90 vw, avec pour seule sortie au tactile la bande de 10 vw du fond).
// Sur barre fixe le test vérifie simplement que la barre reste en place.
test('tiroir : choisir un canal le referme', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { drawer: isDrawer } = layoutOf(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);

  await openDrawer(page, hasTouch);
  await press(page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: CHANNEL_NAME }), hasTouch);
  const composer = mainContent(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` });
  await expect(composer).toBeVisible();
  if (isDrawer) {
    await expectDrawerClosed(page, 3_000);
    await expectReachable(composer);
  } else {
    await expect(drawer(page)).toBeInViewport({ ratio: 1 });
    await expectReachable(composer);
  }
  await context.close();
});

// Disposition tiroir : la barre mobile (fixe, 3.25rem, z-index 70) est en haut de l'écran ; la
// vue du quiz commence sous elle, donc la progression « Question i sur n » (seul indicateur
// chiffré ≤ 900 px, les points étant masqués) est visible et non recouverte. Vérifié aussi sur
// barre fixe.
test('quiz : la progression « Question i sur n » n’est pas recouverte par la barre mobile', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, QUIZ_NAME, hasTouch);
  const status = mainContent(page).getByText('Question 1 sur 5', { exact: true });
  await expect(status).toBeVisible();
  const covered = await status.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && !el.contains(hit) ? hit.tagName : null;
  });
  // Recouvert par le <header> de la barre mobile (role banner) quand le défaut est présent.
  expect(covered, 'statut recouvert par').toBeNull();
  await context.close();
});

// Le forum et le canal partagent la même règle d'en-tête : sur barre fixe l'en-tête de la vue
// (nom + contexte du cours) est visible ; ≤ 900 px il est remplacé par la barre mobile, qui
// porte le nom de l'élément ouvert. ≤ 480 px le contexte du cours disparaît de l'en-tête.
test('en-tête de la vue : barre mobile ≤ 900 px, contexte du cours masqué ≤ 480 px', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { drawer: isDrawer, narrow } = layoutOf(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, FORUM_NAME, hasTouch);
  const header = mainContent(page).locator('header').first();
  const context_ = header.locator('p').last(); // contexte du cours (« MAT115 · … »)
  if (isDrawer) {
    await expect(banner(page).getByRole('heading')).toHaveText(FORUM_NAME);
    await expect(banner(page).getByRole('heading')).toBeInViewport({ ratio: 1 });
  } else {
    await expectReachable(header);
    await expect(header).toContainText(FORUM_NAME);
    await expect(context_).toBeVisible();
  }
  if (narrow) await expect(context_).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await context.close();
});
