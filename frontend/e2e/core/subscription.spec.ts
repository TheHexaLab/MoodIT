import { expect, test, type Page } from './fixtures';
import { ROLE_ACCOUNTS, createEnrolledUser, mainContent } from './helpers';
import {
  E2E_ESTABLISHMENT,
  apiAs,
  courseSelector,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  PROGRAM_COHORT,
  deleteProgramApi,
  escapeRegExp,
  clickCourseMenu,
  clickProgramMenu,
  expectProgramMenu,
  openHome,
  programButton,
  type TestProgram,
  courseTile,
} from './admin.helpers';

// Abonnements d'un compte NEUF (aucun programme au départ) à des programmes créés pour la suite :
// rejoindre / quitter un programme et ses cours, par le rail, les menus contextuels et les
// états vides. Les programmes sont créés par l'API (gardien) et supprimés en fin de suite.

let program: TestProgram;
let course: { id: number; code: string; title: string };
let emptyProgram: TestProgram;

// Une connexion gardien par étape (préparation / nettoyage) : sa session est unique et partagée
// avec les autres specs, la garder ouverte toute la suite l'exposerait à une invalidation.
test.beforeAll(async ({ baseURL }) => {
  const gardien = await apiAs(baseURL!, ROLE_ACCOUNTS.gardien);
  program = await createProgramApi(gardien, 'Abo');
  course = await createCourseApi(gardien, [program.id]);
  emptyProgram = await createProgramApi(gardien, 'Vide');
  await gardien.dispose();
});

test.afterAll(async ({ baseURL }) => {
  const gardien = await apiAs(baseURL!, ROLE_ACCOUNTS.gardien);
  await deleteCourseApi(gardien, course.id);
  await deleteProgramApi(gardien, program.id);
  await deleteProgramApi(gardien, emptyProgram.id);
  await gardien.dispose();
});

const joinPopupPrograms = (page: Page) => page.getByPlaceholder('Rechercher un programme…');

/** Popup « Rejoindre un programme » déjà ouvert : choisit l'établissement de test et filtre. */
async function pickTestProgram(page: Page, name: string) {
  await page
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(E2E_ESTABLISHMENT)} `) })
    .click();
  await joinPopupPrograms(page).fill(name);
  return programRow(page, name);
}

/** Ligne du programme dans le popup : pastille + nom + cohorte. */
const programRow = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`${escapeRegExp(name)} ${PROGRAM_COHORT}$`) });

/** Après l'adhésion à un NOUVEAU programme, le choix de ses cours s'enchaîne : on le referme. */
async function dismissCoursesPopup(page: Page) {
  await expect(page.getByRole('heading', { name: 'Rejoindre des cours' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('heading', { name: 'Rejoindre des cours' })).toHaveCount(0);
}

/** Ouvre « Ajouter un programme » → « Rejoindre un programme » et cible un programme de test. */
async function openJoinProgram(page: Page, name: string) {
  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await page.getByRole('button', { name: /^↪ Rejoindre un programme/ }).click();
  return pickTestProgram(page, name);
}

async function freshUserHome(browser: Parameters<typeof openHome>[0], baseURL: string) {
  const { storageState } = await createEnrolledUser(baseURL, undefined, { enroll: false });
  return openHome(browser, storageState);
}

test('rejoindre un programme depuis l’accueil puis rejoindre et quitter un cours', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshUserHome(browser, baseURL!);
  const main = mainContent(page);

  // Compte neuf : Accueil, puis adhésion par le bouton de la barre, directement sur les programmes
  // de son établissement.
  await expect(main.getByRole('heading', { name: /^Bonjour/ })).toBeVisible();
  await page.getByRole('button', { name: 'Rejoindre un programme', exact: true }).click();
  await joinPopupPrograms(page).fill(program.name);
  const row = programRow(page, program.name);
  await expect(row).toHaveAttribute('aria-pressed', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Enregistrer' }).click();

  // Le choix des cours s'enchaîne.
  await page.getByPlaceholder('Rechercher un cours…').fill(course.code);
  const courseRow = page.getByRole('dialog').getByRole('button', { name: new RegExp(course.title) });
  await courseRow.click();
  await expect(courseRow).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click();
  await courseTile(page, course.code).click();
  await expect(courseSelector(page, course.code)).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Ce cours est vide' })).toBeVisible();

  // La sélection REMPLACE l'ensemble : décocher le cours = le quitter.
  await clickProgramMenu(page, program.name, 'Rejoindre des cours');
  await expect(courseRow).toHaveAttribute('aria-pressed', 'true'); // déjà inscrit : pré-coché
  await courseRow.click();
  await expect(courseRow).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click();
  await expect(courseTile(page, course.code)).toHaveCount(0);

  // Ré-inscription par « Rejoindre un cours », sous le programme dans la barre.
  await page.getByRole('button', { name: `Rejoindre un cours : ${program.name}` }).click();
  await courseRow.click();
  await page.getByRole('button', { name: 'Rejoindre', exact: true }).click();
  await courseTile(page, course.code).click();
  await expect(courseSelector(page, course.code)).toBeVisible();

  // « Quitter le cours » (menu contextuel du titre) : « Annuler » ne fait rien, « Quitter » oui.
  await clickCourseMenu(page, course.code, 'Quitter le cours');
  await expect(page.getByRole('heading', { name: 'Quitter le cours ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('heading', { name: 'Quitter le cours ?' })).toHaveCount(0);
  await expect(courseSelector(page, course.code)).toBeVisible();

  await clickCourseMenu(page, course.code, 'Quitter le cours');
  await page.getByRole('button', { name: 'Quitter', exact: true }).click();
  await expect(main.getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();

  // Persisté côté serveur : toujours sans cours après rechargement (l'URL reste sur le programme).
  await page.reload();
  await expect(main.getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();

  await context.close();
});

test('un programme sans cours propose « Rejoindre un cours » sans rien à rejoindre', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshUserHome(browser, baseURL!);
  const row = await openJoinProgram(page, emptyProgram.name);
  await row.click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();

  // Le choix des cours s'enchaîne : vide. La barre le propose aussi sous le programme.
  await expect(page.getByText('Aucun cours à rejoindre dans ce programme')).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await page.getByRole('button', { name: `Rejoindre un cours : ${emptyProgram.name}` }).click();
  await expect(page.getByText('Aucun cours à rejoindre dans ce programme')).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByPlaceholder('Rechercher un cours…')).toHaveCount(0);

  await context.close();
});

test('« Annuler » ne change pas les abonnements ; décocher un programme désabonne', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshUserHome(browser, baseURL!);

  // Cocher puis annuler : aucun abonnement.
  const row = await openJoinProgram(page, program.name);
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(joinPopupPrograms(page)).toHaveCount(0);
  await expect(programButton(page, program.name)).toHaveCount(0);

  // Abonnement réel.
  await (await openJoinProgram(page, program.name)).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await dismissCoursesPopup(page);
  await expect(programButton(page, program.name)).toBeVisible();

  // Rouvrir : le programme suivi est pré-coché ; le décocher puis enregistrer = désabonnement.
  const again = await openJoinProgram(page, program.name);
  await expect(again).toHaveAttribute('aria-pressed', 'true');
  await again.click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(programButton(page, program.name)).toHaveCount(0);

  await page.reload();
  await expect(
    mainContent(page).getByRole('heading', { name: /^Bonjour/ })
  ).toBeVisible();
  await expect(programButton(page, program.name)).toHaveCount(0);

  await context.close();
});

test('quitter un programme par son menu contextuel (avec confirmation)', async ({
  browser,
  baseURL,
}) => {
  const { context, page } = await freshUserHome(browser, baseURL!);
  await (await openJoinProgram(page, program.name)).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await dismissCoursesPopup(page);
  await expect(programButton(page, program.name)).toBeVisible();

  // Un étudiant n'a que les deux actions communes à tous.
  await expectProgramMenu(page, program.name, ['Rejoindre des cours', 'Quitter le programme']);

  await clickProgramMenu(page, program.name, 'Quitter le programme');
  await expect(page.getByRole('heading', { name: 'Quitter le programme ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('heading', { name: 'Quitter le programme ?' })).toHaveCount(0);
  await expect(programButton(page, program.name)).toBeVisible();

  await clickProgramMenu(page, program.name, 'Quitter le programme');
  await page.getByRole('button', { name: 'Quitter', exact: true }).click();
  await expect(programButton(page, program.name)).toHaveCount(0);
  await expect(
    mainContent(page).getByRole('heading', { name: /^Bonjour/ })
  ).toBeVisible();

  await page.reload();
  await expect(programButton(page, program.name)).toHaveCount(0);

  await context.close();
});
