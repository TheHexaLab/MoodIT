import { expect, test, type Browser, type Locator, type Page } from './fixtures';
import { storageStatePath } from '../setup/accounts';
import {
  FORUM_NAME,
  ROLE_ACCOUNTS,
  createEnrolledUser,
  mainContent,
  openCourseItem,
  sessionAs,
  uniqueSuffix,
} from './helpers';

// Alice publie un sujet, Bob vote pour : le score est persisté (visible après rechargement) et
// l'auteur ne peut pas voter pour son propre sujet.
test('poster un sujet puis voter', async ({ browser }) => {
  const title = `Sujet E2E ${uniqueSuffix()}`;

  const alice = await browser.newContext({ storageState: storageStatePath('alice') });
  const alicePage = await alice.newPage();
  await openCourseItem(alicePage, FORUM_NAME);
  await alicePage.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await alicePage.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await alicePage.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Corps en **gras**');
  await alicePage.getByRole('button', { name: 'Publier' }).click();

  const alicePost = mainContent(alicePage)
    .getByRole('listitem')
    .filter({ has: alicePage.getByRole('heading', { name: title }) });
  await expect(alicePost.getByRole('strong')).toHaveText('gras'); // Markdown rendu
  await expect(alicePost.getByRole('button', { name: 'Voter pour' })).toBeDisabled();

  const bob = await browser.newContext({ storageState: storageStatePath('bob') });
  const bobPage = await bob.newPage();
  await openCourseItem(bobPage, FORUM_NAME);
  const bobPost = mainContent(bobPage)
    .getByRole('listitem')
    .filter({ has: bobPage.getByRole('heading', { name: title }) });
  // Score = texte entre les deux boutons de vote.
  const voted = `
    - button "Voter pour" [pressed]
    - text: "1"
    - button "Voter contre"
  `;
  await bobPost.getByRole('button', { name: 'Voter pour' }).click();
  await expect(bobPost).toMatchAriaSnapshot(voted);

  // Persisté côté serveur : Bob recharge et retrouve son vote ; Alice voit le score.
  await openCourseItem(bobPage, FORUM_NAME);
  await expect(bobPost).toMatchAriaSnapshot(voted);
  await openCourseItem(alicePage, FORUM_NAME);
  await expect(alicePost).toMatchAriaSnapshot(`
    - button "Voter pour" [disabled]
    - text: "1"
  `);

  await alice.close();
  await bob.close();
});

// ─── Parcours complémentaires ─────────────────────────────────────────────────────────────
// Le forum du seed est partagé et s'enrichit à chaque run : chaque test crée ses propres sujets
// (titre unique) et n'agit que sur eux.

type StorageState = Awaited<ReturnType<typeof sessionAs>>['storageState'];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compte étudiant NEUF, abonné au cours. Plutôt que alice/bob : un compte n'a qu'un jeton actif,
 * et toute reconnexion d'un compte partagé (setup global d'un autre run) révoquerait la session
 * en plein test.
 */
const newStudent = async (baseURL: string) => (await createEnrolledUser(baseURL)).storageState;

/** Ouvre le forum dans un nouveau contexte. */
async function openForum(browser: Browser, storageState: StorageState) {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await openCourseItem(page, FORUM_NAME);
  await expect(page.getByRole('button', { name: '+ Nouveau sujet' })).toBeVisible();
  return { context, page };
}

/** Carte d'un sujet racine (son titre est un heading). */
const thread = (page: Page, title: string) =>
  mainContent(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/**
 * Réponse par son contenu exact. Une réponse est imbriquée dans son sujet et dans ses
 * ancêtres (tous des listitem qui contiennent son texte) : la plus profonde est la dernière.
 */
const reply = (page: Page, content: string) =>
  mainContent(page)
    .getByRole('listitem')
    .filter({
      has: page
        .getByRole('paragraph')
        .filter({ hasText: new RegExp(`^${escapeRegExp(content)}$`) }),
    })
    .last();

/** Titres des sujets dans l'ordre affiché. */
const threadTitles = (page: Page) =>
  mainContent(page).getByRole('heading', { level: 2 }).allTextContents();

async function publishThread(page: Page, title: string, content = `Corps de ${title}`) {
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill(content);
  await page.getByRole('button', { name: 'Publier' }).click();
  await expect(thread(page, title)).toBeVisible();
}

/** Les actions d'un post précèdent celles de ses réponses dans le DOM : on prend la première. */
const ownButton = (card: Locator, name: string) =>
  card.getByRole('button', { name, exact: true }).first();

/** Carte de confirmation (DeleteConfirmationPopup) : plus petit bloc titre + boutons. */
const confirmPopup = (page: Page) =>
  page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Supprimer le message' }) })
    .filter({ has: page.getByRole('button', { name: 'Annuler' }) })
    .last();

async function confirmDelete(page: Page) {
  const popup = confirmPopup(page);
  await expect(popup).toContainText(
    'Ce message et ses réponses seront définitivement supprimés. Continuer ?'
  );
  await popup.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(popup).toBeHidden();
}

/** Ordre relatif de deux sujets dans la liste affichée (vrai si `first` précède `second`). */
async function isBefore(page: Page, first: string, second: string) {
  const titles = await threadTitles(page);
  return titles.includes(first) && titles.indexOf(first) < titles.indexOf(second);
}

test('trier les sujets : Populaires et Récents', async ({ browser, baseURL }) => {
  const older = `Sujet E2E ancien ${uniqueSuffix()}`;
  const newer = `Sujet E2E récent ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, older);
  await publishThread(author.page, newer);

  // Le lecteur vote pour le plus ancien : il passe devant en « Populaires », pas en « Récents ».
  const reader = await openForum(browser, await newStudent(baseURL!));
  const olderUp = ownButton(thread(reader.page, older), 'Voter pour');
  await olderUp.click();
  await expect(olderUp).toHaveAttribute('aria-pressed', 'true');

  const sort = reader.page.getByRole('group', { name: 'Trier les sujets' });
  const recent = sort.getByRole('button', { name: 'Récents' });
  const top = sort.getByRole('button', { name: 'Populaires' });
  await recent.click();
  await expect(recent).toHaveAttribute('aria-pressed', 'true');
  await expect(top).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => isBefore(reader.page, newer, older)).toBe(true);

  await top.click();
  await expect(top).toHaveAttribute('aria-pressed', 'true');
  await expect(recent).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => isBefore(reader.page, older, newer)).toBe(true);

  await author.context.close();
  await reader.context.close();
});

test('répondre à un sujet puis à une réponse, déplier et replier', async ({ browser, baseURL }) => {
  const title = `Sujet E2E réponses ${uniqueSuffix()}`;
  const first = `Réponse E2E niveau 1 ${uniqueSuffix()}`;
  const nested = `Réponse E2E niveau 2 ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);
  const authorCard = thread(author.page, title);
  await expect(authorCard).toContainText('Aucune réponse');

  const reader = await openForum(browser, await newStudent(baseURL!));
  const card = thread(reader.page, title);
  // Réponse au sujet par le bouton « Répondre » du composeur : tant que le sujet n'a pas de
  // réponse, c'est le dernier « Répondre » de la carte (il suit le bouton d'action).
  await ownButton(card, 'Répondre').click();
  const composer = card.getByRole('textbox', { name: 'Éditeur Markdown' });
  await expect(composer).toHaveAttribute('placeholder', 'Votre réponse…');
  await composer.fill(first);
  await card.getByRole('button', { name: 'Répondre', exact: true }).last().click();
  await expect(reply(reader.page, first)).toBeVisible();
  await expect(ownButton(card, 'Replier les réponses')).toHaveText('1 réponse');

  // Réponse à la réponse (imbriquée), envoyée par Ctrl+Entrée.
  const firstReply = reply(reader.page, first);
  await ownButton(firstReply, 'Répondre').click();
  const nestedComposer = firstReply.getByRole('textbox', { name: 'Éditeur Markdown' });
  await nestedComposer.fill(nested);
  await nestedComposer.press('Control+Enter');
  await expect(firstReply.getByText(nested, { exact: true })).toBeVisible();
  await expect(ownButton(firstReply, 'Replier les réponses')).toHaveText('1 réponse');

  // Replier le sujet masque tout le fil ; le déplier le réaffiche.
  await ownButton(card, 'Replier les réponses').click();
  await expect(reply(reader.page, first)).toBeHidden();
  await ownButton(card, 'Déplier les réponses').click();
  await expect(reply(reader.page, first)).toBeVisible();

  // Côté auteur (après rechargement) : compteurs, puis chargement paresseux niveau par niveau.
  await openCourseItem(author.page, FORUM_NAME);
  await expect(ownButton(authorCard, 'Déplier les réponses')).toHaveText('1 réponse');
  await ownButton(authorCard, 'Déplier les réponses').click();
  const authorFirst = reply(author.page, first);
  await expect(authorFirst).toBeVisible();
  await expect(author.page.getByText(nested, { exact: true })).toBeHidden();
  await ownButton(authorFirst, 'Déplier les réponses').click();
  await expect(authorFirst.getByText(nested, { exact: true })).toBeVisible();

  await author.context.close();
  await reader.context.close();
});

test('modifier son sujet : titre et contenu, visible en direct', async ({ browser, baseURL }) => {
  const title = `Sujet E2E à modifier ${uniqueSuffix()}`;
  const newTitle = `${title} (modifié)`;
  const newContent = `Contenu modifié ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  const reader = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);
  await expect(thread(reader.page, title)).toBeVisible();

  const card = thread(author.page, title);
  await ownButton(card, 'Modifier').click();
  const titleBox = card.getByRole('textbox', { name: 'Titre du sujet' });
  await expect(titleBox).toHaveValue(title);
  // Le titre est obligatoire : vide, l'enregistrement est désactivé.
  await titleBox.fill('');
  await expect(card.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await titleBox.fill(newTitle);
  await card.getByRole('textbox', { name: 'Éditeur Markdown' }).fill(newContent);
  await card.getByRole('button', { name: 'Enregistrer' }).click();

  await expect(thread(author.page, newTitle)).toContainText(newContent);
  // Lecteur : modification reçue en direct, puis persistée (rechargement).
  await expect(thread(reader.page, newTitle)).toContainText(newContent);
  await expect(thread(reader.page, title)).toHaveCount(0);
  await openCourseItem(reader.page, FORUM_NAME);
  await expect(thread(reader.page, newTitle)).toContainText(newContent);

  await author.context.close();
  await reader.context.close();
});

test('supprimer son sujet et ses réponses, disparition en direct', async ({ browser, baseURL }) => {
  const title = `Sujet E2E à supprimer ${uniqueSuffix()}`;
  const answer = `Réponse E2E supprimée ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);
  const reader = await openForum(browser, await newStudent(baseURL!));
  const readerCard = thread(reader.page, title);
  await ownButton(readerCard, 'Répondre').click();
  await readerCard.getByRole('textbox', { name: 'Éditeur Markdown' }).fill(answer);
  await readerCard.getByRole('textbox', { name: 'Éditeur Markdown' }).press('Control+Enter');
  await expect(reply(reader.page, answer)).toBeVisible();

  // « Annuler » dans la confirmation ne supprime rien.
  await ownButton(thread(author.page, title), 'Supprimer').click();
  await confirmPopup(author.page).getByRole('button', { name: 'Annuler' }).click();
  await expect(confirmPopup(author.page)).toBeHidden();
  await expect(thread(author.page, title)).toBeVisible();

  await ownButton(thread(author.page, title), 'Supprimer').click();
  await confirmDelete(author.page);
  await expect(thread(author.page, title)).toHaveCount(0);
  // Chez le lecteur : sujet et réponse disparaissent sans recharger, et restent absents après.
  await expect(readerCard).toHaveCount(0);
  await expect(reader.page.getByText(answer, { exact: true })).toHaveCount(0);
  await openCourseItem(reader.page, FORUM_NAME);
  await expect(reader.page.getByRole('button', { name: '+ Nouveau sujet' })).toBeVisible();
  await expect(readerCard).toHaveCount(0);

  await author.context.close();
  await reader.context.close();
});

test('vote : même sens retire le vote, sens opposé le bascule', async ({ browser, baseURL }) => {
  const title = `Sujet E2E votes ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);

  const reader = await openForum(browser, await newStudent(baseURL!));
  const card = thread(reader.page, title);
  const up = ownButton(card, 'Voter pour');
  const down = ownButton(card, 'Voter contre');
  // Score = texte entre les deux boutons de vote.
  const state = (score: number, upPressed: boolean, downPressed: boolean) => `
    - button "Voter pour"${upPressed ? ' [pressed]' : ''}
    - text: "${score}"
    - button "Voter contre"${downPressed ? ' [pressed]' : ''}
  `;

  // Deux précautions, ce test vérifiant la logique du vote et non le pointeur ni la concurrence :
  // - tri « Populaires » d'un forum PARTAGÉ : chaque vote, celui-ci ou ceux des tests en parallèle,
  //   réordonne la liste à tout moment, et un clic positionné tombait parfois à côté (Firefox) ;
  //   le clic est donc envoyé directement au bouton (dispatchEvent) ;
  // - on attend la réponse du serveur avant le vote suivant, comme un utilisateur qui marque une
  //   pause : deux votes simultanés sur un même sujet sont un autre cas (cf. #130).
  const press = async (button: Locator) => {
    const saved = reader.page.waitForResponse(
      (res) => res.url().includes('/api/forums/posts/votes') && res.request().method() === 'POST'
    );
    await button.dispatchEvent('click');
    expect((await saved).ok(), 'vote enregistré par le serveur').toBe(true);
  };
  await press(up);
  await expect(card).toMatchAriaSnapshot(state(1, true, false));
  await press(up); // même sens : retrait
  await expect(card).toMatchAriaSnapshot(state(0, false, false));
  await press(down);
  await expect(card).toMatchAriaSnapshot(state(-1, false, true));
  await press(up); // sens opposé : bascule directe (-1 → +1)
  await expect(card).toMatchAriaSnapshot(state(1, true, false));

  // Persisté : même état après rechargement.
  await openCourseItem(reader.page, FORUM_NAME);
  await expect(card).toMatchAriaSnapshot(state(1, true, false));

  await author.context.close();
  await reader.context.close();
});

// Votes rapprochés (#130) : contrairement au test précédent, aucun clic n'attend la réponse du
// précédent. Le frontend les met en file par sujet et le serveur les sérialise : aucune requête
// refusée (409), et l'état enregistré est celui affiché, après rechargement.
test('votes rapprochés sans attendre les réponses : aucun refus, état enregistré = état affiché', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E votes rapides ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);

  const reader = await openForum(browser, await newStudent(baseURL!));
  const card = thread(reader.page, title);
  const up = ownButton(card, 'Voter pour');
  const down = ownButton(card, 'Voter contre');
  const state = (score: number, upPressed: boolean, downPressed: boolean) => `
    - button "Voter pour"${upPressed ? ' [pressed]' : ''}
    - text: "${score}"
    - button "Voter contre"${downPressed ? ' [pressed]' : ''}
  `;
  const statuses: number[] = [];
  reader.page.on('response', (res) => {
    if (res.url().includes('/api/forums/posts/votes') && res.request().method() === 'POST') {
      statuses.push(res.status());
    }
  });

  // Clic envoyé directement au bouton (tri « Populaires » d'un forum partagé, cf. test précédent).
  // Double-clic sur « Voter pour » (+1 puis retrait), puis « Voter contre » : −1 au final.
  await up.dispatchEvent('click');
  await up.dispatchEvent('click');
  await down.dispatchEvent('click');
  await expect(card).toMatchAriaSnapshot(state(-1, false, true));
  await expect.poll(() => statuses.length, { message: 'les 3 votes ont reçu une réponse' }).toBe(3);
  expect(statuses, 'aucun vote refusé (204 = enregistré)').toEqual([204, 204, 204]);
  await expect(reader.page.getByText("Votre vote n'a pas pu être enregistré. Réessayez.")).toHaveCount(0);

  // Persisté : même état après rechargement.
  await openCourseItem(reader.page, FORUM_NAME);
  await expect(card).toMatchAriaSnapshot(state(-1, false, true));

  await author.context.close();
  await reader.context.close();
});

test('un non-auteur ne peut ni modifier ni supprimer le sujet d’un autre', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E autrui ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);
  await expect(ownButton(thread(author.page, title), 'Modifier')).toBeVisible();

  const reader = await openForum(browser, await newStudent(baseURL!));
  const card = thread(reader.page, title);
  await expect(ownButton(card, 'Répondre')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Supprimer', exact: true })).toHaveCount(0);

  await author.context.close();
  await reader.context.close();
});

test('modération : l’admin du programme supprime le sujet d’autrui', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E modération ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);

  const { storageState } = await sessionAs(baseURL!, ROLE_ACCOUNTS.padmin);
  const padmin = await openForum(browser, storageState);
  const card = thread(padmin.page, title);
  // Un modérateur supprime mais ne réécrit pas.
  await expect(ownButton(card, 'Répondre')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
  await ownButton(card, 'Supprimer').click();
  await confirmDelete(padmin.page);
  await expect(thread(padmin.page, title)).toHaveCount(0);
  await expect(thread(author.page, title)).toHaveCount(0);

  await author.context.close();
  await padmin.context.close();
});

test('modération : l’enseignant ne voit pas « Supprimer » sur le sujet d’autrui', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E gating enseignant ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  await publishThread(author.page, title);

  const { storageState } = await sessionAs(baseURL!, ROLE_ACCOUNTS.prof);
  const prof = await openForum(browser, storageState);
  const card = thread(prof.page, title);
  await expect(ownButton(card, 'Répondre')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Modifier', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Supprimer', exact: true })).toHaveCount(0, {
    timeout: 3_000,
  });

  await author.context.close();
  await prof.context.close();
});

test('nouveau sujet : barre Markdown, aperçu, Publier, Annuler, Ctrl+Entrée', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E clavier ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  const page = author.page;
  const heading = page.getByRole('heading', { name: 'Nouveau post' });
  const editor = page.getByRole('textbox', { name: 'Éditeur Markdown' });
  const preview = page.getByRole('button', { name: 'Aperçu' });
  const publish = page.getByRole('button', { name: 'Publier' });
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await expect(heading).toBeVisible();

  // Aperçu d'un contenu vide.
  await preview.click();
  await expect(page.getByText('Rien à prévisualiser.')).toBeVisible();
  await preview.click();

  // « Gras » insère la syntaxe et place le curseur entre les marqueurs.
  await page
    .getByRole('toolbar', { name: 'Mise en forme Markdown' })
    .getByRole('button', { name: 'Gras' })
    .click();
  await expect(editor).toHaveValue('****');
  await expect(editor).toBeFocused();
  await page.keyboard.type('fort');
  await expect(editor).toHaveValue('**fort**');

  // L'aperçu remplace la zone de saisie par le rendu HTML.
  await preview.click();
  await expect(editor).toBeHidden();
  await expect(
    mainContent(page)
      .getByRole('strong')
      .filter({ hasText: /^fort$/ })
  ).toBeVisible();
  await preview.click();

  // Sans titre, « Publier » est désactivé même avec un contenu.
  await expect(publish).toBeDisabled();
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await expect(publish).toBeEnabled();

  // « Annuler » ferme le formulaire sans rien publier.
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(heading).toBeHidden();
  await expect(thread(page, title)).toHaveCount(0);

  // Ctrl+Entrée publie depuis l'éditeur.
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await editor.fill('Publié au clavier');
  await editor.press('Control+Enter');
  await expect(heading).toBeHidden();
  await expect(thread(page, title)).toContainText('Publié au clavier');

  await author.context.close();
});

test('temps réel : nouveau sujet, vote et suppression visibles sans recharger', async ({
  browser,
  baseURL,
}) => {
  const title = `Sujet E2E direct ${uniqueSuffix()}`;
  const author = await openForum(browser, await newStudent(baseURL!));
  const reader = await openForum(browser, await newStudent(baseURL!));

  // Création : le lecteur voit le sujet de l'auteur apparaître.
  await publishThread(author.page, title);
  await expect(thread(reader.page, title)).toBeVisible();

  // Vote : l'auteur voit le score changer.
  await ownButton(thread(reader.page, title), 'Voter pour').click();
  await expect(thread(author.page, title)).toMatchAriaSnapshot(`
    - button "Voter pour" [disabled]
    - text: "1"
  `);

  // Suppression : le sujet disparaît chez le lecteur.
  await ownButton(thread(author.page, title), 'Supprimer').click();
  await confirmDelete(author.page);
  await expect(thread(reader.page, title)).toHaveCount(0);

  await author.context.close();
  await reader.context.close();
});
