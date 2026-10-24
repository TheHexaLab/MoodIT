import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { ROLE_ACCOUNTS, uniqueSuffix } from './helpers';
import { confirmationPopup, createProgramApi, sessionFor } from './admin.helpers';

// Gestion des établissements (Gardien). Chaque test crée SON établissement (nom et domaine
// uniques) et le supprime ; `e2e.test` et les établissements du seed ne sont jamais modifiés.

/** Ouvre « Ajouter un programme » → « Gérer les établissements ». */
async function openManage(page: Page) {
  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await page.getByRole('button', { name: /^⚙ Gérer les établissements/ }).click();
  await expect(page.getByRole('heading', { name: 'Gérer les établissements' })).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ hasText: new RegExp(`^${name}`) });
const nameInput = (page: Page) => page.getByPlaceholder("Nom de l'établissement");
const domainInput = (page: Page) => page.getByPlaceholder('Domaine courriel (ex. usherbrooke.ca)');

/** Nettoyage best effort par l'API (si le test a échoué avant sa propre suppression). */
async function deleteByDomain(api: APIRequestContext, domain: string) {
  const list = (await (await api.get('/api/establishments')).json()) as {
    id: number;
    domainEmail: string;
  }[];
  const found = list.find((e) => e.domainEmail === domain);
  if (found) await api.delete(`/api/establishments/${found.id}`);
}

test('le gardien crée, modifie et supprime un établissement ; un 2e onglet suit en direct', async ({
  browser,
  baseURL,
}) => {
  const suffix = uniqueSuffix();
  const name = `Établissement E2E ${suffix}`;
  const domain = `etab${suffix}.e2e-test.ca`;
  const renamed = `${name} renommé`;
  const { api, context, page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  // Second onglet du même gardien, popup ouvert : reçoit les changements par WebSocket.
  const watcher = await context.newPage();
  await watcher.goto('/home');

  try {
    await openManage(page);
    await openManage(watcher);

    // Création : « Créer » inactif tant que le nom ou le domaine manque ; domaine en minuscules.
    await page.getByRole('button', { name: '+ Ajouter un établissement' }).click();
    await expect(page.getByRole('heading', { name: 'Ajouter un établissement' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();
    await nameInput(page).fill(name);
    await domainInput(page).fill(domain.toUpperCase());
    await expect(domainInput(page)).toHaveValue(domain);

    // Domaine invalide : message inline, création bloquée.
    await domainInput(page).fill('pas-un-domaine');
    await expect(page.getByText('Domaine invalide (ex. usherbrooke.ca)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();

    // Domaine déjà pris (e2e.test) : refusé par le serveur (409), message inline.
    await domainInput(page).fill('e2e.test');
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(
      page.getByText('Ce domaine courriel est déjà utilisé par un établissement.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();

    await domainInput(page).fill(domain);
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(row(page, name)).toContainText(`${domain} · Aucun programme`);
    await expect(row(watcher, name)).toBeVisible(); // WS establishment:upserted

    // Modification : formulaire pré-rempli ; « Annuler » puis enregistrement réel.
    await row(page, name).getByRole('button', { name: 'Modifier' }).click();
    await expect(page.getByRole('heading', { name: "Modifier l'établissement" })).toBeVisible();
    await expect(nameInput(page)).toHaveValue(name);
    await expect(domainInput(page)).toHaveValue(domain);
    await nameInput(page).fill('Ne pas garder');
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(row(page, name)).toBeVisible();
    await row(page, name).getByRole('button', { name: 'Modifier' }).click();
    await nameInput(page).fill(renamed);
    await nameInput(page).press('Enter');
    await expect(row(page, renamed)).toBeVisible();
    await expect(row(watcher, renamed)).toBeVisible();

    // Suppression avec cascade : un programme y est rattaché (créé par l'API).
    const program = await createProgramApi(api, 'Etab', domain);
    expect((await api.get(`/api/programs/${program.id}`)).ok()).toBe(true);
    await expect(row(page, renamed)).toContainText(`${domain} · 1 programme`);
    await row(page, renamed).getByRole('button', { name: 'Supprimer' }).click();
    const confirm = confirmationPopup(page, "Supprimer l'établissement");
    await expect(confirm).toContainText(`Supprimer « ${renamed} » ?`);
    await expect(confirm).toContainText('Ses 1 programme(s) et tout leur contenu');
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(row(page, renamed)).toBeVisible();
    await row(page, renamed).getByRole('button', { name: 'Supprimer' }).click();
    await confirm.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(row(page, renamed)).toHaveCount(0);
    await expect(row(watcher, renamed)).toHaveCount(0); // WS establishment:deleted

    // Cascade : le programme rattaché n'existe plus.
    expect((await api.get(`/api/programs/${program.id}`)).ok()).toBe(false);
  } finally {
    await deleteByDomain(api, domain);
    await close();
  }
});

test('un non-Gardien n’a ni « Gérer les établissements » ni « Créer un programme »', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.padmin);

  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ajouter un programme' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^↪ Rejoindre un programme/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Gérer les établissements/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Créer un programme/ })).toHaveCount(0);

  await close();
});
