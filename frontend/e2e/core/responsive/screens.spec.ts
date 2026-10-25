import { expect, request, test, type Page } from '../fixtures';
import { TEST_PASSWORD } from '../../setup/accounts';
import {
  FORUM_NAME,
  createEnrolledUser,
  mainContent,
  newUser,
  uniqueSuffix,
  waitForPopupSettled,
} from '../helpers';
import { clickCourseMenu, clickProgramMenu, openUserMenu } from '../admin.helpers';
import {
  CHANNEL_NAME,
  CODE_COURSE,
  PROGRAM_NAME,
  closeDrawer,
  courseNav,
  coursePicker,
  expectActionable,
  expectField,
  noteTarget,
  expectNoHorizontalOverflow,
  expectNoScrollableOverflow,
  expectPopupFits,
  expectReachable,
  expectWithinWidth,
  guardianPage,
  layoutOf,
  openDrawer,
  openSidebarItem,
  pickCourse,
  press,
  programAdminPage,
  selectProgram,
  studentPage,
} from '../responsive.helpers';

// Chaque écran principal et chaque popup, sur les 8 profils : aucun débordement horizontal
// (document et conteneurs défilants) et les éléments clés (champs, boutons d'action) sont
// entièrement dans le viewport, non recouverts, et d'une taille tactile suffisante (≥ 24 px,
// seuil WCAG 2.5.8) sur les profils tactiles. Les cibles entre 24 et 32 px sont annotées dans
// le rapport (`cible tactile < 32 px`), pas bloquantes ; les boutons-icônes encore sous 24 px
// passent par `noteTarget` (annotés seulement). Test « cibles tactiles » en fin de fichier.

const main = (page: Page) => mainContent(page);

/** Un écran : document + panneau principal sans débordement. */
async function expectScreenFits(page: Page) {
  await expectNoHorizontalOverflow(page);
  await expectNoScrollableOverflow(main(page));
}

/** Un popup repéré par son titre : corps sans débordement, boutons donnés atteignables. */
async function expectPopup(page: Page, title: string, actions: string[], hasTouch: boolean) {
  const heading = page.getByRole('heading', { name: title, exact: true });
  await expectPopupFits(heading);
  await expectNoHorizontalOverflow(page);
  for (const name of actions) {
    await expectActionable(page.getByRole('button', { name, exact: true }).last(), hasTouch);
  }
}

test('pages d’authentification : champs et boutons atteignables, aucun débordement', async ({
  page,
  baseURL,
  hasTouch,
}) => {
  // /login (les liens sont du texte en ligne : atteignables, sans contrainte de taille).
  await page.goto('/login');
  await expectNoHorizontalOverflow(page);
  await expectField(page.getByPlaceholder('exemple@gmail.com'), hasTouch);
  await expectField(page.getByPlaceholder('••••••••••'), hasTouch);
  await expectActionable(page.getByRole('button', { name: 'Se connecter →' }), hasTouch, 32);
  await expectReachable(page.getByRole('link', { name: 'Mot de passe oublié ?' }));
  await expectReachable(page.getByRole('link', { name: 'Créer un compte' }));

  // /register
  await page.goto('/register');
  await expectNoHorizontalOverflow(page);
  for (const placeholder of [
    'ex : RKarine',
    'ex: Roussel',
    'ex: Karine_Roussel@usherbrooke.ca',
    'Choisissez un mot de passe',
    'Retapez votre mot de passe',
  ]) {
    await expectField(page.getByPlaceholder(placeholder), hasTouch);
  }
  await expectField(page.getByPlaceholder('ex: Karine', { exact: true }), hasTouch);
  await expectReachable(page.getByRole('checkbox'));
  await expectActionable(page.getByRole('button', { name: 'Créer mon compte →' }), hasTouch, 32);
  await expectActionable(page.getByRole('button', { name: 'Changer de thème' }), hasTouch);

  // /forgot-password → /reset-password (sans courriel : l'interface est la même).
  await page.goto('/forgot-password');
  await expectNoHorizontalOverflow(page);
  await expectField(page.getByPlaceholder('exemple@usherbrooke.ca'), hasTouch);
  await expectActionable(page.getByRole('button', { name: 'Envoyer le code →' }), hasTouch, 32);
  await page.getByPlaceholder('exemple@usherbrooke.ca').fill(newUser().email);
  await press(page.getByRole('button', { name: 'Envoyer le code →' }), hasTouch);
  await expect(page).toHaveURL(/\/reset-password$/);
  await expectNoHorizontalOverflow(page);
  const resetBoxes = page.getByRole('group', { name: 'Code à 6 chiffres' }).getByRole('textbox');
  await expect(resetBoxes).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expectField(resetBoxes.nth(i), hasTouch);
  for (let i = 0; i < 2; i++) await expectField(page.getByPlaceholder('••••••••••').nth(i), hasTouch);
  await expectActionable(page.getByRole('button', { name: 'Réinitialiser →' }), hasTouch, 32);
  await expectReachable(page.getByRole('button', { name: 'Renvoyer', exact: true }));

  // /verify-code (2FA d'un compte neuf) : 6 cases qui tiennent côte à côte même à 360 px.
  const { user } = await createEnrolledUser(baseURL!);
  await page.goto('/login');
  await page.getByPlaceholder('exemple@gmail.com').fill(user.email);
  await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
  await press(page.getByRole('button', { name: 'Se connecter →' }), hasTouch);
  await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const boxes = page.getByRole('group', { name: 'Code à 6 chiffres' }).getByRole('textbox');
  await expect(boxes).toHaveCount(6);
  for (let i = 0; i < 6; i++) await expectField(boxes.nth(i), hasTouch);
  const first = (await boxes.first().boundingBox())!;
  const last = (await boxes.last().boundingBox())!;
  expect(last.y).toBe(first.y); // une seule rangée
  await expectReachable(page.getByRole('button', { name: 'Renvoyer le code' }));
  await expectReachable(page.getByRole('link', { name: '← Retour' }));
});

test('états vides : accueil, programme sans cours, aucun canal sélectionné', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  // Compte neuf sans abonnement : « Bienvenue sur MoodIT ».
  const { user, storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  await expect(main(page).getByRole('heading', { name: 'Bienvenue sur MoodIT' })).toBeVisible();
  await expectScreenFits(page);
  await expectReachable(main(page).getByRole('heading', { name: 'Bienvenue sur MoodIT' }));
  await expectActionable(main(page).getByRole('button', { name: '+ Rejoindre un programme' }), hasTouch, 32);

  // Abonnement au programme 1 sans cours (API) : « Ce programme n'a pas de cours ».
  const api = await request.newContext({ baseURL, storageState });
  try {
    const res = await api.post('/api/programs/users', { data: { id: user.id, programIds: [1] } });
    expect(res.ok(), `abonnement : HTTP ${res.status()}`).toBe(true);
  } finally {
    await api.dispose();
  }
  await page.reload();
  await selectProgram(page, PROGRAM_NAME, hasTouch, { courses: false });
  await expect(main(page).getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();
  await expectScreenFits(page);
  await expectActionable(main(page).getByRole('button', { name: '+ Rejoindre un cours' }), hasTouch, 32);
  await expect(main(page).getByRole('button', { name: '+ Créer un cours' })).toHaveCount(0);

  // Inscrit à MAT115 (API) : « Aucun canal sélectionné » puis la barre du cours.
  const api2 = await request.newContext({ baseURL, storageState });
  try {
    const res = await api2.post('/api/courses/users', {
      data: { id: user.id, courseIds: [1], programId: 1 },
    });
    expect(res.ok(), `inscription : HTTP ${res.status()}`).toBe(true);
  } finally {
    await api2.dispose();
  }
  await page.reload();
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await expect(main(page).getByRole('heading', { name: 'Aucun canal sélectionné' })).toBeVisible();
  await expectScreenFits(page);
  await context.close();
});

test('canal : messages longs, réponse, composeur et bouton d’envoi atteignables', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { dense } = layoutOf(page);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, CHANNEL_NAME, hasTouch);
  const composer = main(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` });
  const send = main(page).getByRole('button', { name: 'Envoyer le message' });
  await expectScreenFits(page);
  await expectField(composer, hasTouch);
  await expectActionable(send, hasTouch, 32);

  // Mot sans espace plus large que l'écran, URL longue, puis texte long : tout est replié.
  const tag = uniqueSuffix();
  const longWord = 'DébordementSansEspace'.repeat(8);
  const longText = `${tag} ${longWord} https://exemple.test/${'segment/'.repeat(20)} ${'texte long '.repeat(60)}`;
  await composer.fill(longText);
  await composer.press('Enter');
  const row = main(page).locator('li[role="message"]').filter({ hasText: tag });
  await expect(row).toBeVisible();
  await expectScreenFits(page);
  await expectWithinWidth(row);
  await expectWithinWidth(row.getByRole('paragraph').filter({ hasText: tag }));

  // Réponse au message long : bandeau + puce de réponse (extrait tronqué) sans débordement.
  if (hasTouch) await row.tap();
  else await row.hover();
  const reply = row.getByRole('button', { name: 'Répondre au message' });
  await expectActionable(reply, hasTouch);
  await press(reply, hasTouch);
  await expect(main(page).getByText('Répondre à Neuf E2E')).toBeVisible();
  await noteTarget(main(page).getByRole('button', { name: 'Annuler la réponse' }), hasTouch); // 20×20 px
  await expectReachable(composer);
  const answer = `Réponse ${tag}`;
  await composer.fill(answer);
  await press(send, hasTouch);
  const replyRow = main(page).locator('li[role="message"]').filter({ hasText: answer });
  const chip = replyRow.getByRole('button', { name: new RegExp(`^NE ${tag}`) });
  await expect(chip).toBeVisible();
  await expectScreenFits(page);
  await expectWithinWidth(chip);
  // ≤ 768 px la barre d'actions flotte dans la ligne ; au-delà elle est en ligne.
  if (hasTouch) await replyRow.tap();
  else await replyRow.hover();
  const actions = replyRow.locator('[role="message-actions"]');
  await expect(actions).toHaveCSS('position', dense ? 'absolute' : 'static');
  await expectWithinWidth(actions);
  await context.close();
});

test('forum : sujet Markdown long et réponses sans débordement', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!);
  const { dense } = layoutOf(page);
  // Dès l'ouverture, à 360 px (Galaxy S8) : le nom du forum dans l'en-tête (« Thread — … »,
  // caché sous la barre mobile mais mesuré) se tronque au lieu de déborder du panneau ; les
  // blocs de code, eux, défilent en interne.
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openSidebarItem(page, FORUM_NAME, hasTouch);
  await expectScreenFits(page);
  const newTopic = main(page).getByRole('button', { name: '+ Nouveau sujet' });
  await expectActionable(newTopic, hasTouch);
  await expectActionable(main(page).getByRole('group', { name: 'Trier les sujets' }).getByRole('button', { name: 'Récents' }), hasTouch);
  // ≤ 340 px la barre d'outils passe en colonne (tri sous le bouton) : jamais atteint par les
  // profils (360 px minimum) → la barre reste sur une ligne.
  const toolbar = main(page).locator('[role="toolbar"]').first();
  const toolbarBox = (await toolbar.boundingBox())!;
  const newTopicBox = (await newTopic.boundingBox())!;
  expect(newTopicBox.y).toBeLessThan(toolbarBox.y + toolbarBox.height);

  // Sujet avec Markdown long : titre, mot sans espace, bloc de code à ligne longue, liste, lien.
  const tag = uniqueSuffix();
  // Titre long mais sous les 128 caractères du champ (au-delà il est tronqué à la saisie).
  const title = `Responsive ${tag} ${'TitreLongSansEspace'.repeat(4)}`;
  const content = [
    '# En-tête de premier niveau assez long pour passer sur plusieurs lignes',
    `Mot sans espace : ${'DébordementSansEspace'.repeat(8)}`,
    `Lien : https://exemple.test/${'segment/'.repeat(25)}`,
    '- premier point',
    '- second point **gras** et `code en ligne`',
    '```python',
    `print("${'x'.repeat(200)}")`,
    '```',
    '> Citation ' + 'assez longue '.repeat(30),
  ].join('\n');
  await press(newTopic, hasTouch);
  await expect(page.getByRole('heading', { name: 'Nouveau post' })).toBeVisible();
  await expectScreenFits(page);
  await expectField(page.getByRole('textbox', { name: 'Titre du sujet' }), hasTouch);
  await expectField(page.getByRole('textbox', { name: 'Éditeur Markdown' }), hasTouch);
  await expectReachable(page.getByRole('toolbar', { name: 'Mise en forme Markdown' }));
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill(content);
  await expectActionable(page.getByRole('button', { name: 'Publier' }), hasTouch);
  await press(page.getByRole('button', { name: 'Publier' }), hasTouch);

  const card = main(page).getByRole('listitem').filter({ has: page.getByRole('heading', { name: title }) });
  await expect(card).toBeVisible();
  await expectScreenFits(page);
  await expectWithinWidth(card);
  // Le bloc de code défile en interne : sa boîte tient dans le viewport (et la carte).
  const pre = card.locator('pre').first();
  await expect(pre).toBeVisible();
  await expectWithinWidth(pre);

  // Vote : rail vertical (> 768 px) ou sous le post (≤ 768 px) ; une seule paire visible.
  const up = card.getByRole('button', { name: 'Voter pour' }).first();
  await expect(card.getByRole('button', { name: 'Voter pour' })).toHaveCount(1);
  await expect(up).toBeDisabled(); // son propre sujet
  const upInMobileVote = await up.evaluate((el) => el.closest('[role="mobile-vote"]') !== null);
  expect(upInMobileVote).toBe(dense);

  // Réponse (actions révélées au toucher de la carte ≤ 768 px) puis réponse imbriquée.
  if (dense) await press(card, hasTouch);
  const replyButton = card.getByRole('button', { name: 'Répondre', exact: true }).first();
  await expectActionable(replyButton, hasTouch);
  await press(replyButton, hasTouch);
  const composer = card.getByRole('textbox', { name: 'Éditeur Markdown' });
  await expectField(composer, hasTouch);
  await composer.fill(`Réponse ${tag} ${'LongueRéponseSansEspace'.repeat(8)}`);
  await press(card.getByRole('button', { name: 'Répondre', exact: true }).last(), hasTouch);
  const reply = card.locator('li[role="comment"]').filter({ hasText: `Réponse ${tag}` }).last();
  await expect(reply).toBeVisible();
  await expectScreenFits(page);
  await expectWithinWidth(reply);
  await context.close();
});

test('quiz : question de code (éditeur, console) sans débordement', async ({ browser, baseURL, hasTouch }) => {
  const { page, context } = await studentPage(browser, baseURL!, [CODE_COURSE.id]);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await pickCourse(page, CODE_COURSE.code, hasTouch);
  await openSidebarItem(page, CODE_COURSE.quiz, hasTouch);
  await expectScreenFits(page);
  const editor = main(page).getByRole('textbox', { name: 'Éditeur de code (Python)' });
  await expectField(editor, hasTouch);
  await expectActionable(main(page).getByRole('button', { name: 'Exécuter' }), hasTouch);
  await expectActionable(main(page).getByRole('button', { name: 'Soumettre' }), hasTouch, 32);

  // Ligne très longue : l'éditeur défile en interne, la page et la carte ne bougent pas.
  await editor.fill(`def solution(a, b):\n    return a + b  # ${'commentaire '.repeat(40)}\n`);
  await expectScreenFits(page);
  await expectWithinWidth(editor);
  await context.close();
});

test('popups de l’étudiant : profil, ajouter / rejoindre un programme, rejoindre des cours', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();

  // Modifier le profil (menu du compte).
  const menu = await openUserMenu(page);
  await press(menu.getByRole('menuitem', { name: 'Modifier le profil' }), hasTouch);
  await expectPopup(page, 'Modifier le profil', ['Annuler', 'Enregistrer'], hasTouch);
  for (const name of ['Prénom', 'Nom']) {
    await expectField(page.getByRole('textbox', { name, exact: true }), hasTouch);
  }
  for (const hex of ['#0D9488', '#7D7D94']) {
    await expectActionable(page.getByRole('button', { name: hex }), hasTouch);
  }
  // Sélecteur de couleur libre : <label aria-label> autour d'un <input type="color">.
  await expectActionable(page.locator('label[aria-label="Ajouter une couleur"]'), hasTouch);
  await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
  await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toHaveCount(0);

  // Ajouter un programme → menu des options → Rejoindre un programme (deux étapes).
  await openDrawer(page, hasTouch);
  await press(page.getByRole('button', { name: 'Ajouter un programme', exact: true }), hasTouch);
  await expectPopup(page, 'Ajouter un programme', [], hasTouch);
  await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
  // ≤ 360 px l'icône de l'option (« ↪ ») est masquée : le nom accessible perd son préfixe. Le
  // « + Rejoindre un programme » de l'accueil vide est exclu par son texte « + ».
  const join = page.getByRole('button', { name: /Rejoindre un programme/ }).filter({ hasNotText: /\+\s*Rejoindre/ });
  await expectActionable(join, hasTouch, 32);
  await press(join, hasTouch);
  await expectPopup(page, 'Rejoindre un programme', [], hasTouch);
  await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
  await expectField(page.getByPlaceholder('Rechercher un établissement…'), hasTouch);
  const establishment = page.getByRole('button', { name: /^Université de Sherbrooke / });
  await expectActionable(establishment, hasTouch, 32);
  await press(establishment, hasTouch);
  await expectField(page.getByPlaceholder('Rechercher un programme…'), hasTouch);
  // Ligne = code + nom + cohorte (ex. « GIN Génie informatique Promo … »).
  const program = page.getByRole('button', { name: new RegExp(`${PROGRAM_NAME} `) });
  await expectActionable(program, hasTouch, 32);
  await expect(program).toHaveAttribute('aria-pressed', 'true'); // déjà abonné
  await noteTarget(page.getByRole('button', { name: 'Retour', exact: true }), hasTouch); // 18×18 px
  for (const name of ['Annuler', 'Enregistrer']) {
    await expectActionable(page.getByRole('button', { name, exact: true }), hasTouch);
  }
  await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
  await expect(page.getByPlaceholder('Rechercher un programme…')).toHaveCount(0);
  await closeDrawer(page, hasTouch);

  // Rejoindre des cours (menu contextuel du programme : clic droit, le seul geste que Playwright
  // sait émettre pour `contextmenu` — l'appui long d'Android n'est pas émulable).
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await openDrawer(page, hasTouch);
  await clickProgramMenu(page, PROGRAM_NAME, 'Rejoindre des cours');
  await expectPopup(page, 'Rejoindre des cours', ['Annuler', 'Rejoindre'], hasTouch);
  await expectField(page.getByPlaceholder('Rechercher un cours…'), hasTouch);
  // Ligne = badge (3 lettres) + titre : on vise le titre du cours.
  const course = page.getByRole('button', { name: /^MAT Mathématiques pour ingénieurs I/ });
  await expectActionable(course, hasTouch, 32);
  await expect(course).toHaveAttribute('aria-pressed', 'true');
  await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
  await expect(page.getByPlaceholder('Rechercher un cours…')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await context.close();
});

test('popups de gestion : cours, programme, sections, rôles, MCP', async ({ browser, baseURL, hasTouch }) => {
  const { page, context, revoke } = await programAdminPage(browser, baseURL!);
  try {
    await selectProgram(page, PROGRAM_NAME, hasTouch);

    // Ajouter un cours (menu du programme) : établissement, programmes, code, titre.
    await openDrawer(page, hasTouch);
    await clickProgramMenu(page, PROGRAM_NAME, 'Ajouter un cours');
    await expectPopup(page, 'Ajouter un cours', ['Annuler', 'Sauvegarder'], hasTouch);
    // Déclencheur de la liste : <div onClick> sans rôle, parent du texte de substitution.
    await expectActionable(page.getByText('Sélectionner un établissement').locator('..'), hasTouch);
    for (const name of ['Code du cours', 'Titre du cours']) {
      await expectField(page.getByRole('textbox', { name }), hasTouch);
    }
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toHaveCount(0);

    // Modifier le programme.
    await openDrawer(page, hasTouch);
    await clickProgramMenu(page, PROGRAM_NAME, 'Modifier le programme');
    await expectPopup(page, 'Modifier le programme', ['Annuler', 'Enregistrer'], hasTouch);
    for (const name of ['Code du programme', 'Nom du programme', 'Cohorte']) {
      await expectField(page.getByRole('textbox', { name }), hasTouch);
    }
    await expectActionable(page.getByRole('button', { name: '#7D7D94' }), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toHaveCount(0);

    // Gestion des rôles : sections, « + Ajouter », recherche.
    await openDrawer(page, hasTouch);
    await clickProgramMenu(page, PROGRAM_NAME, 'Gérer les rôles');
    await expectPopup(page, 'Gestion des rôles', [], hasTouch);
    await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
    const add = page.getByRole('button', { name: '+ Ajouter' }).first();
    await noteTarget(add, hasTouch); // 55×18 px
    await press(add, hasTouch);
    await expectField(page.getByPlaceholder('Rechercher un utilisateur…'), hasTouch);
    await expectNoHorizontalOverflow(page);
    await press(page.getByRole('button', { name: '✕' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toHaveCount(0);

    // Modifier le cours (crayon du sélecteur) : programmes multi, code, titre.
    await openDrawer(page, hasTouch);
    await press(coursePicker(page), hasTouch);
    await expectField(page.getByRole('listbox').getByRole('textbox', { name: 'Rechercher un cours…' }), hasTouch);
    await expectActionable(page.getByRole('listbox').getByRole('option', { name: /^MAT115 / }), hasTouch, 32);
    const pencil = page.getByRole('listbox').getByRole('button', { name: 'Modifier le cours MAT115' });
    await noteTarget(pencil, hasTouch);
    await press(pencil, hasTouch);
    await expectPopup(page, 'Modifier le cours', ['Annuler', 'Enregistrer'], hasTouch);
    await expectField(page.getByRole('textbox', { name: 'Titre du cours' }), hasTouch);
    await noteTarget(page.getByRole('button', { name: `Retirer ${PROGRAM_NAME}` }).first(), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toHaveCount(0);

    // Sections CANAUX (crayon de la section) : liste, ajout, « ✕ ».
    await openDrawer(page, hasTouch);
    await press(courseNav(page).getByRole('button', { name: 'Modifier la section CANAUX' }), hasTouch);
    await expectPopup(page, 'Modifier les canaux', ['+ Ajouter un canal'], hasTouch);
    await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
    await expectReachable(page.getByRole('listitem').filter({ hasText: /^⠿/ }).first());
    await press(page.getByRole('button', { name: '+ Ajouter un canal' }), hasTouch);
    await expectPopup(page, 'Nouveau canal', ['Annuler', 'Enregistrer'], hasTouch);
    await expectField(page.getByRole('textbox'), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await press(page.getByRole('button', { name: '✕' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toHaveCount(0);

    // Gestion MCP (menu contextuel du cours) : bandeau « Analyser », historique.
    await openDrawer(page, hasTouch);
    await clickCourseMenu(page, 'MAT115', 'Feedback du cours');
    await expectPopup(page, 'Gestion MCP', ['Analyser'], hasTouch);
    await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
    await expect(page.getByText('Chargement des analyses…')).toBeHidden();
    await expectReachable(page.getByText('HISTORIQUE DES ANALYSES'));
    const history = page.getByRole('button', { name: /\d+ forces? · \d+ points? à améliorer$/ });
    if ((await history.count()) > 0) {
      await expectActionable(history.first(), hasTouch, 32);
      await press(history.first(), hasTouch);
      await expectPopup(page, 'Bilan MCP', [], hasTouch);
      await noteTarget(page.getByRole('button', { name: 'Retour' }), hasTouch); // 18×18 px
      await expect(page.getByText('Chargement de l’analyse…')).toBeHidden();
      for (const tab of ['Points forts', 'À améliorer', 'Recommandations']) {
        await noteTarget(page.getByRole('tab', { name: tab }), hasTouch);
      }
      await expectReachable(page.getByText(/^Sources : \d+ quiz/));
      await press(page.getByRole('button', { name: 'Retour' }), hasTouch);
      // Retour à la liste : la popup rapetisse et se recentre ; ✕ bouge pendant ce temps.
      await expect(page.getByText('HISTORIQUE DES ANALYSES')).toBeVisible();
      await waitForPopupSettled(page);
    }
    await press(page.getByRole('button', { name: '✕' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
    await revoke();
  }
});

test('éditeur de quiz : liste, formulaire, question (6 types), harnais et test', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context, revoke } = await programAdminPage(browser, baseURL!);
  try {
    await selectProgram(page, PROGRAM_NAME, hasTouch);
    await openDrawer(page, hasTouch);
    await press(courseNav(page).getByRole('button', { name: 'Modifier la section QUIZ' }), hasTouch);

    // Liste. « Fermer » / « Retour » du bandeau (✕ / chevron) font 15 px de large : atteignables,
    // taille annotée dans le rapport.
    await expectPopup(page, 'Modifier les quiz', ['Créer un quiz'], hasTouch);
    await noteTarget(page.getByRole('button', { name: 'Fermer', exact: true }), hasTouch);
    const seedRow = page.locator('[data-reorder-id]').first();
    await expectActionable(seedRow, hasTouch, 32);
    await press(seedRow, hasTouch);
    await noteTarget(seedRow.getByRole('button', { name: /^Modifier / }), hasTouch);
    await noteTarget(seedRow.getByRole('button', { name: /^Supprimer / }), hasTouch);

    // Formulaire « Nouveau quiz ».
    await press(page.getByRole('button', { name: 'Créer un quiz' }), hasTouch);
    await expectPopup(page, 'Nouveau quiz', ['Ajouter', 'Annuler', 'Créer'], hasTouch);
    await noteTarget(page.getByRole('button', { name: 'Retour' }), hasTouch);
    await expectField(page.getByRole('textbox', { name: 'Titre' }), hasTouch);
    for (const name of ['Publié', 'Quiz du jour', 'Autoriser les reprises']) {
      await expectReachable(page.getByRole('switch', { name }));
    }

    // Question : chacun des 6 types, sans rien enregistrer.
    await press(page.getByRole('button', { name: 'Ajouter', exact: true }), hasTouch);
    await expectPopup(page, 'Nouvelle question', ['Tester', 'Annuler', 'Ajouter'], hasTouch);
    await expectField(page.getByRole('textbox', { name: 'Éditeur Markdown' }), hasTouch);
    await expectField(page.getByRole('spinbutton', { name: 'Points' }), hasTouch);
    const type = page.getByRole('button', { name: 'Type de question' });
    await expectActionable(type, hasTouch, 32);
    // « Choix unique » d'abord : c'est le type par défaut, les autres sont choisis dans la liste.
    const checks: Record<string, () => Promise<void>> = {
      'Choix unique': async () => {
        await expectField(page.getByRole('textbox', { name: 'Réponse…' }).first(), hasTouch);
        await noteTarget(page.getByRole('button', { name: 'Supprimer la réponse' }).first(), hasTouch);
        await expectActionable(page.getByRole('button', { name: '+ Ajouter une réponse' }), hasTouch);
      },
      'Vrai/Faux': async () => {
        await noteTarget(page.getByRole('button', { name: 'Marquer comme correcte' }).first(), hasTouch);
      },
      'Choix multiple': async () => {
        await expectField(page.getByRole('textbox', { name: 'Réponse…' }).last(), hasTouch);
      },
      'Remise en ordre': async () => {
        await expectField(page.getByRole('textbox', { name: 'Élément…' }).first(), hasTouch);
        await noteTarget(page.getByRole('button', { name: "Supprimer l'élément" }).first(), hasTouch);
        await expectActionable(page.getByRole('button', { name: '+ Ajouter un élément' }), hasTouch);
      },
      Association: async () => {
        await expectField(page.getByRole('textbox', { name: 'Élément…' }).first(), hasTouch);
        await expectField(page.getByRole('textbox', { name: 'Catégorie' }).first(), hasTouch);
        // ≤ 480 px (QuizEditor.module.css, 30rem) : le slot central de la ligne est le bouton
        // d'options, révélé quand la ligne est active (champ focalisé). Au-delà, ce slot est une
        // flèche inerte (pointer-events: none) et la suppression passe par la poubelle de bout de ligne.
        if (page.viewportSize()!.width <= 480) {
          const options = page.getByRole('button', { name: "Options de l'association" }).first();
          await options.scrollIntoViewIfNeeded();
          await press(page.getByRole('textbox', { name: 'Élément…' }).first(), hasTouch);
          await noteTarget(options, hasTouch);
        } else {
          await noteTarget(page.getByRole('button', { name: "Supprimer l'association" }).first(), hasTouch);
        }
        await expectActionable(page.getByRole('button', { name: '+ Ajouter une association' }), hasTouch);
      },
      Code: async () => {
        await expectActionable(page.getByRole('button', { name: 'Langage' }), hasTouch, 32);
        await expectField(page.getByRole('textbox', { name: 'Code de départ' }), hasTouch);
        await expectActionable(page.getByRole('button', { name: 'Gérer' }), hasTouch);
      },
    };
    for (const [label, check] of Object.entries(checks)) {
      if (label !== 'Choix unique') {
        await expect(async () => {
          if ((await type.getAttribute('aria-expanded')) !== 'true') await press(type, hasTouch);
          const option = page.getByRole('option', { name: label, exact: true });
          await expectReachable(option);
          await press(option, hasTouch);
          await expect(type).toHaveText(label, { timeout: 2_000 });
        }).toPass();
      }
      await expect(type).toHaveText(label);
      await expectPopupFits(page.getByRole('heading', { name: 'Nouvelle question' }));
      await check();
    }

    // Harnais (type Code).
    await press(page.getByRole('button', { name: 'Gérer' }), hasTouch);
    await expectPopup(page, 'Harnais de test', ['+ Ajouter un harnais', 'Annuler'], hasTouch);
    await press(page.getByRole('button', { name: '+ Ajouter un harnais' }), hasTouch);
    await expectField(page.getByPlaceholder('Nom du cas (ex. Cas nominal)'), hasTouch);
    // Champ « Poids » : input type=number sans nom accessible (le libellé est un <span> voisin).
    await expectField(page.getByRole('spinbutton').last(), hasTouch);
    await expectField(page.getByRole('textbox', { name: 'Code du harnais 1' }), hasTouch);
    await noteTarget(page.getByRole('button', { name: 'Supprimer le harnais' }), hasTouch);
    await expectActionable(page.getByRole('button', { name: 'Enregistrer' }), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Nouvelle question' })).toBeVisible();

    // Test de la question (Vrai/Faux valide → « Tester »).
    await expect(async () => {
      if ((await type.getAttribute('aria-expanded')) !== 'true') await press(type, hasTouch);
      await press(page.getByRole('option', { name: 'Vrai/Faux', exact: true }), hasTouch);
      await expect(type).toHaveText('Vrai/Faux', { timeout: 2_000 });
    }).toPass();
    await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Deux et deux font quatre.');
    await press(page.getByRole('button', { name: 'Tester', exact: true }), hasTouch);
    await expectPopup(page, 'Tester la question', ['Corriger'], hasTouch);
    await noteTarget(page.getByRole('button', { name: 'Retour' }), hasTouch);
    await expectActionable(page.getByRole('button', { name: 'Vrai', exact: true }), hasTouch, 32);
    await press(page.getByRole('button', { name: 'Vrai', exact: true }), hasTouch);
    await press(page.getByRole('button', { name: 'Corriger' }), hasTouch);
    await expectReachable(page.getByText(/^[01] \/ 1 pts$/));
    await expectActionable(page.getByRole('button', { name: 'Réessayer' }), hasTouch);

    // Rien n'est persisté : fermeture. La question saisie n'est pas enregistrée, l'éditeur demande
    // donc confirmation avant de la perdre.
    await press(page.getByRole('button', { name: 'Fermer', exact: true }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Modifications non enregistrées' })).toBeVisible();
    await expectActionable(page.getByRole('button', { name: "Continuer l'édition" }), hasTouch);
    await press(page.getByRole('button', { name: "Continuer l'édition" }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Tester la question' })).toBeVisible();
    await press(page.getByRole('button', { name: 'Fermer', exact: true }), hasTouch);
    await expectActionable(page.getByRole('button', { name: 'Quitter sans enregistrer' }), hasTouch);
    await press(page.getByRole('button', { name: 'Quitter sans enregistrer' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Tester la question' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
    await revoke();
  }
});

test('popups du gardien : établissements et journal d’audit', async ({ browser, baseURL, hasTouch }) => {
  // Gardien NEUF (rôle global donné par l'API) : le jeton partagé `gardien` est révoqué par toute
  // connexion d'une autre spec en parallèle, ce qui coupait ce test au hasard.
  const { page, context, revoke } = await guardianPage(browser, baseURL!);
  try {
    await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();

    // Journal d'audit (menu du compte) : recherche, filtres, entrées, « Fermer ».
    const menu = await openUserMenu(page);
    await press(menu.getByRole('menuitem', { name: 'Journalisation' }), hasTouch);
    await expectPopup(page, "Journal d'audit", ['Fermer'], hasTouch);
    await expectField(page.getByRole('textbox', { name: 'Rechercher (résumé, auteur, contexte)…' }), hasTouch);
    const filters = page.getByRole('group', { name: "Journal d'audit" });
    for (const name of ['Tout', 'Établissement', 'Analyse MCP']) {
      await expectActionable(filters.getByRole('button', { name, exact: true }), hasTouch);
    }
    await expect(page.getByText('Aucune action ne correspond à ce filtre.')).toHaveCount(0);
    // Entrées dépliables (boutons aria-expanded) : la première s'ouvre sur son détail.
    const entries = page.locator('button[aria-expanded]').filter({ hasText: /\d{4}-\d{2}-\d{2}/ });
    await expect(entries.first()).toBeVisible();
    await expectActionable(entries.first(), hasTouch, 32);
    await press(entries.first(), hasTouch);
    await expectReachable(page.getByText(/^Identifiant/));
    await press(page.getByRole('button', { name: 'Fermer', exact: true }), hasTouch);
    await expect(page.getByRole('heading', { name: "Journal d'audit" })).toHaveCount(0);

    // Gérer les établissements (Ajouter un programme → option) : lignes, formulaire d'ajout.
    await openDrawer(page, hasTouch);
    await press(page.getByRole('button', { name: 'Ajouter un programme', exact: true }), hasTouch);
    await expectPopup(page, 'Ajouter un programme', [], hasTouch);
    await noteTarget(page.getByRole('button', { name: '✕' }), hasTouch);
    // ≤ 360 px les icônes des options sont masquées : noms sans préfixe.
    for (const option of [/Créer un programme/, /Rejoindre un programme/, /Gérer les établissements/]) {
      // Écarte le « + Rejoindre un programme » de l'accueil vide, au nom voisin de l'option.
      const button = page.getByRole('button', { name: option }).filter({ hasNotText: /\+\s*Rejoindre/ });
      await expectActionable(button, hasTouch, 32);
    }
    await press(page.getByRole('button', { name: /Gérer les établissements/ }), hasTouch);
    await expectPopup(page, 'Gérer les établissements', ['+ Ajouter un établissement'], hasTouch);
    await noteTarget(page.getByRole('button', { name: 'Retour' }), hasTouch); // 18×18 px
    const row = page.getByRole('listitem').filter({ hasText: /^Université de Sherbrooke/ });
    await expectReachable(row);
    await noteTarget(row.getByRole('button', { name: 'Modifier' }), hasTouch);
    await noteTarget(row.getByRole('button', { name: 'Supprimer' }), hasTouch);
    await press(page.getByRole('button', { name: '+ Ajouter un établissement' }), hasTouch);
    await expectPopup(page, 'Ajouter un établissement', ['Annuler', 'Créer'], hasTouch);
    await expectField(page.getByPlaceholder("Nom de l'établissement"), hasTouch);
    await expectField(page.getByPlaceholder('Domaine courriel (ex. usherbrooke.ca)'), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Gérer les établissements' })).toBeVisible();

    // Créer un programme : formulaire complet (sans créer).
    await press(page.getByRole('button', { name: 'Retour' }), hasTouch);
    await press(page.getByRole('button', { name: /Créer un programme/ }), hasTouch);
    await expectPopup(page, 'Créer un programme', ['Annuler', 'Créer'], hasTouch);
    for (const name of ['Code du programme', 'Nom du programme', 'Cohorte']) {
      await expectField(page.getByRole('textbox', { name }), hasTouch);
    }
    await expectActionable(page.getByText('Sélectionner un établissement').locator('..'), hasTouch);
    await expectActionable(page.getByRole('button', { name: '#7D7D94' }), hasTouch);
    await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);
    await expect(page.getByRole('heading', { name: 'Créer un programme' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  } finally {
    await context.close();
    await revoke();
  }
});

// Cibles tactiles d'au moins 24 px (WCAG 2.5.8), CSS identique sur tous les profils : boutons
// « Voter pour » / « Voter contre » du forum (icône 15 px dans une zone de 24 px), « Publier » de
// l'éditeur Markdown et « Exécuter » de l'éditeur de code. Mesuré sur tous les profils, tactiles
// ou non (le « Fermer » du journal d'audit l'est dans « popups du gardien »).
test('cibles tactiles : vote, « Publier » et « Exécuter » font au moins 24 px', async ({
  browser,
  baseURL,
  hasTouch,
}) => {
  const { page, context } = await studentPage(browser, baseURL!, [CODE_COURSE.id]);
  await selectProgram(page, PROGRAM_NAME, hasTouch);
  await pickCourse(page, 'MAT115', hasTouch); // l'ordre des cours n'est pas garanti (cf. ensureCourse)
  await openSidebarItem(page, FORUM_NAME, hasTouch);
  const card = main(page).getByRole('listitem').first();
  const up = card.getByRole('button', { name: 'Voter pour' }).first();
  await expect(up).toBeVisible();
  const upBox = (await up.boundingBox())!;
  await press(main(page).getByRole('button', { name: '+ Nouveau sujet' }), hasTouch);
  const publish = page.getByRole('button', { name: 'Publier' });
  await expect(publish).toBeVisible();
  const publishBox = (await publish.boundingBox())!;
  await press(page.getByRole('button', { name: 'Annuler' }), hasTouch);

  await pickCourse(page, CODE_COURSE.code, hasTouch);
  await openSidebarItem(page, CODE_COURSE.quiz, hasTouch);
  const run = main(page).getByRole('button', { name: 'Exécuter' });
  await expect(run).toBeVisible();
  const runBox = (await run.boundingBox())!;

  expect(Math.min(upBox.width, upBox.height), 'bouton de vote').toBeGreaterThanOrEqual(24);
  expect(publishBox.height, 'bouton Publier').toBeGreaterThanOrEqual(24);
  expect(Math.min(runBox.width, runBox.height), 'bouton Exécuter').toBeGreaterThanOrEqual(24);
  await context.close();
});
