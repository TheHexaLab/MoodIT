import { expect, request, test, type Browser, type Page } from './fixtures';
import {
  ROLE_ACCOUNTS,
  createEnrolledUser,
  mainContent,
  openCourseItem,
  sessionAs,
  uniqueSuffix,
} from './helpers';

// Canal texte du cours 1 (seed d'init.sql). Les messages s'y accumulent d'un run à l'autre :
// chaque test n'agit que sur les messages qu'il a lui-même envoyés (contenu unique).
const CHANNEL = 'Discussion — Mathématiques pour ingénieurs I';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ouvre le canal dans un nouveau contexte. Les « étudiants » des tests sont des comptes NEUFS
 * (createEnrolledUser) : un compte n'a qu'un jeton actif, et toute reconnexion des comptes
 * partagés (alice, bob : setup global d'un autre run) révoquerait la session en plein test.
 */
async function openChannel(browser: Browser, { storageState }: { storageState: StorageState }) {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await openCourseItem(page, CHANNEL);
  await expect(composer(page)).toBeVisible();
  return { context, page };
}

type StorageState = Awaited<ReturnType<typeof sessionAs>>['storageState'];

const composer = (page: Page) =>
  mainContent(page).getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL}` });

/**
 * Ligne d'un message par son contenu EXACT. Filtrer sur le paragraphe du contenu (et non sur
 * tout le texte de la ligne) : une réponse affiche aussi l'extrait de son parent dans sa puce.
 */
const message = (page: Page, content: string) =>
  mainContent(page)
    .getByRole('listitem')
    .filter({
      has: page
        .getByRole('paragraph')
        .filter({ hasText: new RegExp(`^${escapeRegExp(content)}$`) }),
    });

/** Les actions d'un message ne sont révélées qu'au survol (opacity 0 + pointer-events none). */
async function messageAction(page: Page, content: string, action: string) {
  const row = message(page, content);
  await row.hover();
  await row.getByRole('button', { name: action }).click();
}

async function send(page: Page, content: string) {
  await composer(page).fill(content);
  await composer(page).press('Enter');
  await expect(message(page, content)).toBeVisible();
}

/** Carte de confirmation (DeleteConfirmationPopup) : plus petit bloc titre + boutons. */
const confirmPopup = (page: Page) =>
  page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Supprimer le message' }) })
    .filter({ has: page.getByRole('button', { name: 'Annuler' }) })
    .last();

test('envoyer un message : Entrée ou bouton, reçu en direct, persisté', async ({
  browser,
  baseURL,
}) => {
  const first = `Chat E2E entrée ${uniqueSuffix()}`;
  const second = `Chat E2E bouton ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const reader = await openChannel(browser, await createEnrolledUser(baseURL!));

  // Entrée envoie ; le composeur se vide et le bouton d'envoi se désactive.
  await send(author.page, first);
  await expect(composer(author.page)).toHaveValue('');
  await expect(author.page.getByRole('button', { name: 'Envoyer le message' })).toBeDisabled();
  // Le lecteur le reçoit par WebSocket, sans recharger.
  await expect(message(reader.page, first)).toBeVisible();

  // Maj+Entrée n'envoie pas : il insère un saut de ligne (composeur multiligne). Le message est
  // rogné à l'envoi, le saut de ligne final ne le change donc pas.
  await composer(author.page).fill(second);
  await composer(author.page).press('Shift+Enter');
  await expect(composer(author.page)).toHaveValue(`${second}
`);
  await expect(message(author.page, second)).toHaveCount(0);

  await author.page.getByRole('button', { name: 'Envoyer le message' }).click();
  await expect(message(author.page, second)).toBeVisible();
  await expect(message(reader.page, second)).toBeVisible();

  // Persisté côté serveur : présents après rechargement, dans l'ordre d'envoi.
  await openCourseItem(reader.page, CHANNEL);
  await expect(message(reader.page, first)).toBeVisible();
  await expect(message(reader.page, second)).toBeVisible();
  const contents = await mainContent(reader.page).getByRole('paragraph').allTextContents();
  expect(contents.indexOf(first)).toBeLessThan(contents.indexOf(second));

  await author.context.close();
  await reader.context.close();
});

test('un étudiant ne peut ni modifier ni supprimer le message d’un autre', async ({
  browser,
  baseURL,
}) => {
  const content = `Chat E2E autrui ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const reader = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, content);

  const row = message(reader.page, content);
  await expect(row.getByRole('button', { name: 'Répondre au message' })).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Modifier le message' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Supprimer le message' })).toHaveCount(0);
  // L'auteur, lui, a les deux actions.
  await expect(
    message(author.page, content).getByRole('button', { name: 'Modifier le message' })
  ).toHaveCount(1);
  await expect(
    message(author.page, content).getByRole('button', { name: 'Supprimer le message' })
  ).toHaveCount(1);

  await author.context.close();
  await reader.context.close();
});

test('répondre à un message : bandeau, annulation, puce de réponse', async ({
  browser,
  baseURL,
}) => {
  const parent = `Chat E2E parent ${uniqueSuffix()}`;
  const reply = `Chat E2E réponse ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const reader = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, parent);

  // « Répondre » ouvre le bandeau au nom de l'auteur ; « Annuler la réponse » le referme.
  await messageAction(reader.page, parent, 'Répondre au message');
  const banner = mainContent(reader.page).getByText('Répondre à Neuf E2E');
  await expect(banner).toBeVisible();
  await mainContent(reader.page).getByRole('button', { name: 'Annuler la réponse' }).click();
  await expect(banner).toBeHidden();

  await messageAction(reader.page, parent, 'Répondre au message');
  await expect(banner).toBeVisible();
  await send(reader.page, reply);
  await expect(banner).toBeHidden();

  // La réponse porte une puce (initiales « Neuf E2E » + extrait du parent), chez l'auteur de la
  // réponse et en direct chez celui du parent.
  for (const page of [reader.page, author.page]) {
    await expect(message(page, reply).getByRole('button', { name: `NE ${parent}` })).toBeVisible();
  }

  await author.context.close();
  await reader.context.close();
});

test('modifier son message : Échap annule, Entrée enregistre, visible en direct', async ({
  browser,
  baseURL,
}) => {
  const original = `Chat E2E à modifier ${uniqueSuffix()}`;
  const edited = `${original} (modifié)`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const reader = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, original);

  const editor = mainContent(author.page).getByRole('textbox', { name: 'Modifier le message' });
  await messageAction(author.page, original, 'Modifier le message');
  await expect(editor).toHaveValue(original);
  await editor.fill('brouillon abandonné');
  await editor.press('Escape');
  await expect(editor).toBeHidden();
  await expect(message(author.page, original)).toBeVisible();

  await messageAction(author.page, original, 'Modifier le message');
  await editor.fill(edited);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
  await expect(message(author.page, edited)).toBeVisible();

  // Le lecteur voit la modification sans recharger, puis après rechargement (persistée).
  await expect(message(reader.page, edited)).toBeVisible();
  await expect(message(reader.page, original)).toHaveCount(0);
  await openCourseItem(reader.page, CHANNEL);
  await expect(message(reader.page, edited)).toBeVisible();

  await author.context.close();
  await reader.context.close();
});

test('supprimer son message : confirmation, disparition en direct, parent supprimé', async ({
  browser,
  baseURL,
}) => {
  const parent = `Chat E2E à supprimer ${uniqueSuffix()}`;
  const reply = `Chat E2E réponse orpheline ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const reader = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, parent);
  await messageAction(reader.page, parent, 'Répondre au message');
  await send(reader.page, reply);
  await expect(message(author.page, reply)).toBeVisible();

  // « Annuler » dans la confirmation ne supprime rien.
  await messageAction(author.page, parent, 'Supprimer le message');
  const popup = confirmPopup(author.page);
  await expect(popup).toContainText('Ce message sera définitivement supprimé. Continuer ?');
  await popup.getByRole('button', { name: 'Annuler' }).click();
  await expect(popup).toBeHidden();
  await expect(message(author.page, parent)).toBeVisible();

  await messageAction(author.page, parent, 'Supprimer le message');
  await confirmPopup(author.page).getByRole('button', { name: 'Supprimer', exact: true }).click();

  // Disparu des deux côtés sans rechargement ; la réponse signale son parent supprimé.
  for (const page of [author.page, reader.page]) {
    await expect(message(page, parent)).toHaveCount(0);
    await expect(
      message(page, reply).getByRole('button', { name: 'Message original supprimé' })
    ).toBeDisabled();
  }
  // Persisté : toujours absent après rechargement.
  await openCourseItem(reader.page, CHANNEL);
  await expect(message(reader.page, reply)).toBeVisible();
  await expect(message(reader.page, parent)).toHaveCount(0);

  await author.context.close();
  await reader.context.close();
});

test('modération : l’admin du programme supprime le message d’autrui', async ({
  browser,
  baseURL,
}) => {
  const content = `Chat E2E modération ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, content);

  // Administrateur du programme : peut supprimer (mais pas modifier) le message de l'auteur.
  const padmin = await openChannel(browser, await sessionAs(baseURL!, ROLE_ACCOUNTS.padmin));
  await expect(
    message(padmin.page, content).getByRole('button', { name: 'Modifier le message' })
  ).toHaveCount(0);
  await messageAction(padmin.page, content, 'Supprimer le message');
  await confirmPopup(padmin.page).getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(message(padmin.page, content)).toHaveCount(0);
  await expect(message(author.page, content)).toHaveCount(0);

  await author.context.close();
  await padmin.context.close();
});

test('modération : le serveur refuse à l’enseignant de supprimer le message d’autrui', async ({
  browser,
  baseURL,
}) => {
  const content = `Chat E2E refus enseignant ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  // Id du message et du canal lus sur la requête d'envoi (DELETE /api/forums/{canal}/posts/{id}).
  const sent = author.page.waitForResponse(
    (res) => res.url().endsWith('/api/forums/messages') && res.request().method() === 'POST'
  );
  await send(author.page, content);
  const response = await sent;
  const { id } = (await response.json()) as { id: number };
  const { forumId } = response.request().postDataJSON() as { forumId: number };

  // Appel direct à l'API : le contrôle réel est dans permission-service, pas dans l'UI.
  const { storageState } = await sessionAs(baseURL!, ROLE_ACCOUNTS.prof);
  const profApi = await request.newContext({ baseURL, storageState });
  const res = await profApi.delete(`/api/forums/${forumId}/posts/${id}`);
  expect(res.status()).toBe(403);
  await profApi.dispose();

  await openCourseItem(author.page, CHANNEL);
  await expect(message(author.page, content)).toBeVisible();
  await author.context.close();
});

test('modération : l’enseignant ne voit pas « Supprimer » sur le message d’autrui', async ({
  browser,
  baseURL,
}) => {
  const content = `Chat E2E gating enseignant ${uniqueSuffix()}`;
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  await send(author.page, content);

  const prof = await openChannel(browser, await sessionAs(baseURL!, ROLE_ACCOUNTS.prof));
  const row = message(prof.page, content);
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Modifier le message' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Supprimer le message' })).toHaveCount(0, {
    timeout: 3_000,
  });

  await author.context.close();
  await prof.context.close();
});

test('message de plus de 5000 caractères : avertissement et envoi bloqué', async ({
  browser,
  baseURL,
}) => {
  const author = await openChannel(browser, await createEnrolledUser(baseURL!));
  const sendButton = author.page.getByRole('button', { name: 'Envoyer le message' });
  const warning = mainContent(author.page).getByText(
    'Message trop long : limite de 5000 caractères dépassée.'
  );

  await composer(author.page).fill('a'.repeat(5000));
  await expect(warning).toBeHidden();
  await expect(sendButton).toBeEnabled();

  await composer(author.page).fill('a'.repeat(5001));
  await expect(warning).toBeVisible();
  await expect(sendButton).toBeDisabled();
  // Entrée ne contourne pas la limite : le brouillon reste en place.
  await composer(author.page).press('Enter');
  await expect(composer(author.page)).toHaveValue('a'.repeat(5001));

  await author.context.close();
});
