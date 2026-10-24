import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { storageStatePath } from '../setup/accounts';
import { PROGRAM_NAME, ROLE_ACCOUNTS, mainContent, uniqueSuffix } from './helpers';
import {
  apiAs,
  assignProgramRoleApi,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  freshAccount,
  openHome,
  programButton,
  type TestProgram,
} from './admin.helpers';

// Édition des sections CANAUX / FORUMS d'un cours (canManageContent). Pour ne rien toucher au
// cours MAT115 du seed ni aux rôles des comptes partagés, chaque test travaille dans un cours
// NEUF d'un programme de test, avec un Enseignant NEUF (rôle donné par le gardien via l'API) et
// un étudiant NEUF qui observe les changements en direct (WS section:changed).
//
// Pourquoi pas le compte `prof` : l'inscription aux cours REMPLACE les cours suivis dans le
// programme ; l'inscrire à un cours de test du programme 1 le désinscrirait de MAT115 pendant
// que d'autres specs l'utilisent.

// Sessions gardien courtes (une par étape) : le compte est partagé et sa session est unique, une
// autre spec qui s'y connecte invaliderait une session gardée toute la suite.
let program: TestProgram;
const courseIds: number[] = [];

async function asGardien<T>(baseURL: string, action: (api: APIRequestContext) => Promise<T>) {
  const api = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
  try {
    return await action(api);
  } finally {
    await api.dispose();
  }
}

test.beforeAll(async ({ baseURL }) => {
  program = await asGardien(baseURL!, (api) => createProgramApi(api, 'Sections'));
});

test.afterAll(async ({ baseURL }) => {
  await asGardien(baseURL!, async (api) => {
    for (const id of courseIds) await deleteCourseApi(api, id);
    await deleteProgramApi(api, program.id);
  });
});

/** Cours neuf + Enseignant neuf + étudiant neuf, tous deux inscrits, pages ouvertes sur le cours. */
async function setup(browser: Parameters<typeof openHome>[0], baseURL: string) {
  const teacher = await freshAccount(baseURL);
  const student = await freshAccount(baseURL);
  const course = await asGardien(baseURL, async (api) => {
    const created = await createCourseApi(api, [program.id], 'S');
    await assignProgramRoleApi(api, program.id, teacher.user.id, 'Enseignant');
    return created;
  });
  courseIds.push(course.id);
  for (const account of [teacher, student]) {
    await enrollApi(account.api, program.id, [course.id]);
    await account.api.dispose();
  }

  const t = await openHome(browser, teacher.storageState);
  const s = await openHome(browser, student.storageState);
  for (const { page } of [t, s]) {
    await programButton(page, program.name).click();
    await expect(
      mainContent(page).getByRole('heading', { name: 'Ce cours est vide' })
    ).toBeVisible();
  }
  return {
    teacher: t,
    student: s,
    close: () => Promise.all([t.context.close(), s.context.close()]),
  };
}

/** Section de la barre latérale (CANAUX, FORUMS…) et ses éléments. */
const sidebarSection = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Cours' }).getByRole('region', { name });
const sidebarItems = (page: Page, name: string) => sidebarSection(page, name).getByRole('listitem');

/**
 * Lignes du popup d'édition : seules à porter la poignée « ⠿ ». Leurs icônes crayon / poubelle
 * sont des <svg> sans rôle ni nom : on les prend par position dans le bloc d'actions.
 */
const editorRow = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ hasText: new RegExp(`^⠿\\s*${name}$`) });
const editorRows = (page: Page) => page.getByRole('listitem').filter({ hasText: /^⠿/ });
const rowAction = (page: Page, name: string, action: 'rename' | 'delete') =>
  editorRow(page, name)
    .locator('> div')
    .last()
    .locator('svg')
    .nth(action === 'rename' ? 0 : 1);

/** Champ texte (sans label ni placeholder) du formulaire d'ajout / de renommage du popup. */
const nameField = (page: Page) => page.getByRole('textbox');

test('canaux : créer, refuser un doublon, renommer, réordonner et supprimer ; vu en direct', async ({
  browser,
  baseURL,
}) => {
  const { teacher, student, close } = await setup(browser, baseURL!);
  const page = teacher.page;
  const a = `alpha-${uniqueSuffix()}`;
  const b = `beta-${uniqueSuffix()}`;

  // Création depuis l'état vide du cours ; le nom est passé en minuscules à la saisie.
  await mainContent(page).getByRole('button', { name: '+ Créer un canal' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toBeVisible();
  await page.getByRole('button', { name: '+ Ajouter un canal' }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau canal' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await nameField(page).fill(a.toUpperCase());
  await expect(nameField(page)).toHaveValue(a);
  await expect(page.getByText('Lettres minuscules, chiffres et tirets uniquement')).toBeVisible();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(editorRow(page, a)).toBeVisible();

  // Deuxième canal validé par Entrée.
  await page.getByRole('button', { name: '+ Ajouter un canal' }).click();
  await nameField(page).fill(b);
  await nameField(page).press('Enter');
  await expect(editorRows(page)).toHaveText([`⠿${a}`, `⠿${b}`]);

  // Doublon : avertissement, enregistrement bloqué ; Échap abandonne la saisie.
  await page.getByRole('button', { name: '+ Ajouter un canal' }).click();
  await nameField(page).fill(a);
  await expect(page.getByText('⚠  Ce nom existe déjà')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await nameField(page).press('Escape');
  await expect(nameField(page)).toHaveCount(0);
  await expect(editorRows(page)).toHaveCount(2);

  // L'étudiant voit les deux canaux apparaître sans recharger.
  await expect(sidebarItems(student.page, 'CANAUX')).toHaveText([a, b]);

  // Renommer : « Annuler » ne change rien, puis renommage effectif.
  await rowAction(page, a, 'rename').click();
  await expect(page.getByRole('heading', { name: 'Modifier un canal' })).toBeVisible();
  await expect(nameField(page)).toHaveValue(a);
  await nameField(page).fill(`${a}-x`);
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(editorRow(page, a)).toBeVisible();
  const renamed = `${a}-v2`;
  await rowAction(page, a, 'rename').click();
  await nameField(page).fill(renamed);
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(editorRows(page)).toHaveText([`⠿${renamed}`, `⠿${b}`]);
  await expect(sidebarItems(student.page, 'CANAUX')).toHaveText([renamed, b]);

  // Réordonner par glisser-déposer natif depuis la poignée. Le dépôt n'est relâché qu'une fois la
  // liste du popup réordonnée en direct (dragenter) : sur WebKit, Playwright enchaîne sinon le
  // dragend avant que React ait appliqué cet état, et l'ordre (lu périmé, inchangé) n'est pas
  // persisté. Deux déplacements : dragenter/dragover sont émis sur tous les moteurs.
  await editorRow(page, b).getByText('⠿').hover();
  await page.mouse.down();
  await editorRow(page, renamed).hover();
  await editorRow(page, renamed).hover();
  await expect(editorRows(page)).toHaveText([`⠿${b}`, `⠿${renamed}`]);
  await page.mouse.up();
  await expect(editorRows(page)).toHaveText([`⠿${b}`, `⠿${renamed}`]);
  await expect(sidebarItems(page, 'CANAUX')).toHaveText([b, renamed]);
  await expect(sidebarItems(student.page, 'CANAUX')).toHaveText([b, renamed]);

  // Supprimer : confirmation (« Annuler » puis « Supprimer »).
  await rowAction(page, b, 'delete').click();
  await expect(page.getByRole('heading', { name: 'Supprimer un canal ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(editorRow(page, b)).toBeVisible();
  await rowAction(page, b, 'delete').click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(editorRows(page)).toHaveText([`⠿${renamed}`]);
  await expect(sidebarItems(student.page, 'CANAUX')).toHaveText([renamed]);

  // Fermeture par « ✕ » ; l'état est persisté (rechargement).
  await page.getByRole('button', { name: '✕' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toHaveCount(0);
  await page.reload();
  await programButton(page, program.name).click();
  await expect(sidebarItems(page, 'CANAUX')).toHaveText([renamed]);

  await close();
});

test('forums : créer, renommer et supprimer par le crayon de la section ; vu en direct', async ({
  browser,
  baseURL,
}) => {
  const { teacher, student, close } = await setup(browser, baseURL!);
  const page = teacher.page;
  const name = `forum-${uniqueSuffix()}`;

  await sidebarSection(page, 'FORUMS')
    .getByRole('button', { name: 'Modifier la section FORUMS' })
    .click();
  await expect(page.getByRole('heading', { name: 'Modifier les forums' })).toBeVisible();
  await expect(page.getByText('Aucun forum pour le moment.')).toBeVisible();
  await page.getByRole('button', { name: '+ Ajouter un forum' }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau forum' })).toBeVisible();
  await nameField(page).fill(name);
  await nameField(page).press('Enter');
  await expect(editorRow(page, name)).toBeVisible();
  await expect(sidebarItems(student.page, 'FORUMS')).toHaveText([name]);

  // Renommage puis suppression enchaînés (l'id réel du forum créé doit avoir été réconcilié).
  await rowAction(page, name, 'rename').click();
  await nameField(page).fill(`${name}-v2`);
  await nameField(page).press('Enter');
  await expect(editorRow(page, `${name}-v2`)).toBeVisible();
  await expect(sidebarItems(student.page, 'FORUMS')).toHaveText([`${name}-v2`]);

  await rowAction(page, `${name}-v2`, 'delete').click();
  await expect(page.getByRole('heading', { name: 'Supprimer un forum ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(editorRows(page)).toHaveCount(0);
  await expect(sidebarSection(student.page, 'FORUMS').getByText('Aucun forum')).toBeVisible();

  // Fermeture par clic sur le fond du popup.
  await page.mouse.click(5, 5);
  await expect(page.getByRole('heading', { name: 'Modifier les forums' })).toHaveCount(0);

  await close();
});

test('un étudiant n’a pas les crayons d’édition des sections', async ({ browser }) => {
  const context = await browser.newContext({ storageState: storageStatePath('alice') });
  const page = await context.newPage();
  await page.goto('/home');
  await programButton(page, PROGRAM_NAME).click();

  const sidebar = page.getByRole('navigation', { name: 'Cours' });
  await expect(sidebarSection(page, 'CANAUX')).toBeVisible();
  for (const section of ['QUIZ', 'CANAUX', 'FORUMS']) {
    await expect(sidebarSection(page, section)).toBeVisible();
    await expect(
      sidebar.getByRole('button', { name: `Modifier la section ${section}` })
    ).toHaveCount(0);
  }

  await context.close();
});
