import { expect, test, type APIRequestContext, type Page } from './fixtures';
import { storageStatePath } from '../setup/accounts';
import { PROGRAM_NAME, ROLE_ACCOUNTS, mainContent, uniqueSuffix } from './helpers';
import {
  E2E_ESTABLISHMENT,
  SEED_ESTABLISHMENT,
  courseSelector,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  freshAccount,
  establishmentId,
  newProgramIdentity,
  clickCourseMenu,
  clickProgramMenu,
  expectCourseMenu,
  expectProgramMenu,
  openHome,
  programButton,
  sessionFor,
} from './admin.helpers';

// Gestion des programmes et des cours selon le rôle. Tout ce qui est créé ici (programmes, cours)
// a un nom/code unique et est supprimé par le test lui-même (et par l'API en filet de sécurité).
// Le programme 1 du seed n'est jamais modifié : on n'y ajoute qu'un cours de test, retiré ensuite.

/** Id d'un programme de l'établissement de test d'après son code (pour le nettoyage). */
async function programIdByCode(api: APIRequestContext, code: string) {
  const est = await establishmentId(api);
  const programs = (await (await api.get(`/api/establishments/${est}/programs`)).json()) as {
    id: number;
    code: string;
  }[];
  return programs.find((p) => p.code === code)?.id;
}

async function fillProgramForm(page: Page, values: { code: string; name: string; cohort: string }) {
  await page.getByRole('textbox', { name: 'Code du programme' }).fill(values.code);
  await page.getByRole('textbox', { name: 'Nom du programme' }).fill(values.name);
  await page.getByRole('textbox', { name: 'Cohorte' }).fill(values.cohort);
}

async function openCreateProgram(page: Page) {
  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await page.getByRole('button', { name: /^\+ Créer un programme/ }).click();
  await page.getByText('Sélectionner un établissement').click();
  await page.getByRole('button', { name: E2E_ESTABLISHMENT }).click();
}

test('le gardien crée, modifie et supprime un programme ; un abonné le voit en direct', async ({
  browser,
  baseURL,
}) => {
  const gardien = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const { api: gardienApi, page } = gardien;
  const identity = newProgramIdentity('Admin');
  const renamed = `${identity.name} renommé`;
  let programId: number | undefined;
  let watcher: Awaited<ReturnType<typeof openHome>> | undefined;

  try {
    // Création : le code est forcé en majuscules ; « Créer » n'est actif qu'une fois tout rempli.
    await openCreateProgram(page);
    await page.getByRole('button', { name: '#2DD4BF' }).click();
    await expect(page.getByRole('button', { name: '#2DD4BF' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();
    await fillProgramForm(page, {
      code: identity.code.toLowerCase(),
      name: identity.name,
      cohort: 'Promo 1',
    });
    await expect(page.getByRole('textbox', { name: 'Code du programme' })).toHaveValue(
      identity.code
    );
    await page.getByRole('button', { name: 'Créer', exact: true }).click();

    // Le créateur est abonné d'office : la pastille apparaît (et survit au rechargement).
    await expect(programButton(page, identity.name)).toBeVisible();
    programId = await programIdByCode(gardienApi, identity.code);
    expect(programId).toBeDefined();
    await page.reload();
    await expect(programButton(page, identity.name)).toBeVisible();

    // Doublon de code dans le même établissement : message inline, création bloquée.
    await openCreateProgram(page);
    await fillProgramForm(page, { code: identity.code, name: 'Doublon', cohort: 'X' });
    await expect(page.getByText('Ce code existe déjà dans cet établissement')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Créer un programme' })).toHaveCount(0);

    // Un abonné (compte neuf) garde la page ouverte pour voir les changements en direct.
    const subscriber = await freshAccount(baseURL!);
    await enrollApi(subscriber.api, programId!);
    await subscriber.api.dispose();
    watcher = await openHome(browser, subscriber.storageState);
    await expect(programButton(watcher.page, identity.name)).toBeVisible();

    // Modification : formulaire pré-rempli, puis renommage.
    await clickProgramMenu(page, identity.name, 'Modifier le programme');
    const nameField = page.getByRole('textbox', { name: 'Nom du programme' });
    await expect(nameField).toHaveValue(identity.name);
    await expect(page.getByRole('textbox', { name: 'Cohorte' })).toHaveValue('Promo 1');
    await nameField.fill(renamed);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(programButton(page, renamed)).toBeVisible();
    await expect(programButton(watcher.page, renamed)).toBeVisible(); // WS program:updated

    // Suppression (admin global) : « Annuler » d'abord, puis confirmation.
    await clickProgramMenu(page, renamed, 'Supprimer le programme');
    await expect(page.getByRole('heading', { name: 'Supprimer le programme ?' })).toBeVisible();
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(programButton(page, renamed)).toBeVisible();
    await clickProgramMenu(page, renamed, 'Supprimer le programme');
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(programButton(page, renamed)).toHaveCount(0);
    await expect(programButton(watcher.page, renamed)).toHaveCount(0); // WS program:deleted
    await expect(
      mainContent(watcher.page).getByRole('heading', { name: 'Bienvenue sur MoodIT' })
    ).toBeVisible();
    expect(await programIdByCode(gardienApi, identity.code)).toBeUndefined();
  } finally {
    if (programId !== undefined) await deleteProgramApi(gardienApi, programId);
    await watcher?.context.close();
    await gardien.close();
  }
});

test('l’administrateur du programme 1 ouvre « Modifier le programme » pré-rempli (sans enregistrer)', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.padmin);

  await expectProgramMenu(page, PROGRAM_NAME, [
    'Ajouter un cours',
    'Modifier le programme',
    'Gérer les rôles',
    'Rejoindre des cours',
    'Quitter le programme',
  ]); // pas « Supprimer le programme » : réservé aux admins globaux

  await clickProgramMenu(page, PROGRAM_NAME, 'Modifier le programme');
  await expect(page.getByRole('textbox', { name: 'Nom du programme' })).toHaveValue(PROGRAM_NAME);
  await expect(page.getByRole('textbox', { name: 'Code du programme' })).toHaveValue('GIN');
  // Programme partagé par toutes les specs : on vérifie le formulaire mais on annule.
  await page.getByRole('textbox', { name: 'Nom du programme' }).fill('Ne pas enregistrer');
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toHaveCount(0);
  await expect(programButton(page, PROGRAM_NAME)).toBeVisible();

  await close();
});

test('l’enseignant ajoute, modifie et supprime un cours du programme 1', async ({
  browser,
  baseURL,
}) => {
  const prof = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.prof);
  const { api: profApi, page } = prof;
  const code = `C${uniqueSuffix()}`.toUpperCase();
  const title = `Cours E2E ${code}`;
  let courseId: number | undefined;
  page.on('response', async (res) => {
    if (
      res.url().endsWith('/api/programs/courses') &&
      res.request().method() === 'POST' &&
      res.ok()
    ) {
      courseId = ((await res.json()) as { id: number }).id;
    }
  });

  try {
    // Un Enseignant gère le contenu mais pas les rôles ni le programme lui-même.
    await expectProgramMenu(page, PROGRAM_NAME, [
      'Ajouter un cours',
      'Rejoindre des cours',
      'Quitter le programme',
    ]);
    await clickProgramMenu(page, PROGRAM_NAME, 'Ajouter un cours');
    await expect(page.getByText("Choisis d'abord un établissement")).toBeVisible();
    await page.getByText('Sélectionner un établissement').click();
    await page.getByRole('button', { name: SEED_ESTABLISHMENT }).click();
    await page.getByText('Sélectionner des programmes').click();
    await page.getByRole('button', { name: new RegExp(`^GIN ${PROGRAM_NAME}`) }).click();
    await expect(
      page.getByRole('button', { name: `Retirer ${PROGRAM_NAME}` }).first()
    ).toBeVisible();
    await page.getByRole('textbox', { name: 'Code du cours' }).fill(code.toLowerCase());
    await expect(page.getByRole('textbox', { name: 'Code du cours' })).toHaveValue(code);
    await page.getByRole('textbox', { name: 'Titre du cours' }).fill(title);
    await page.getByRole('button', { name: 'Sauvegarder' }).click();
    await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toHaveCount(0);
    // L'id (nettoyage en `finally`) est posé par le gestionnaire `response`, asynchrone : l'attendre.
    await expect.poll(() => courseId, { message: 'id du cours créé (réponse POST)' }).toBeDefined();

    // Le cours apparaît dans le sélecteur ; on l'ouvre : il est vide. Le programme est ouvert
    // explicitement : le test ne doit pas dépendre du dernier emplacement enregistré du compte.
    await programButton(page, PROGRAM_NAME).click();
    const sidebar = page.getByRole('navigation', { name: 'Cours' });
    await sidebar.getByRole('button', { name: 'MAT115', exact: true }).click();
    const picker = page.getByRole('listbox');
    await picker.getByRole('option', { name: `${code} ${title}` }).click();
    await expect(courseSelector(page, code)).toBeVisible();
    const main = mainContent(page);
    await expect(main.getByRole('heading', { name: 'Ce cours est vide' })).toBeVisible();
    for (const action of ['+ Créer un canal', '+ Créer un Quiz', '+ Créer un Forum']) {
      await expect(main.getByRole('button', { name: action })).toBeVisible();
    }

    // Modification par le crayon du sélecteur.
    await courseSelector(page, code).click();
    await picker.getByRole('button', { name: `Modifier le cours ${code}` }).click();
    await expect(page.getByRole('textbox', { name: 'Titre du cours' })).toHaveValue(title);
    await page.getByRole('textbox', { name: 'Titre du cours' }).fill(`${title} v2`);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toHaveCount(0);
    await courseSelector(page, code).click();
    await expect(picker.getByRole('option', { name: `${code} ${title} v2` })).toBeVisible();
    await page.keyboard.press('Escape');

    // Menu contextuel du cours : actions de gestion, puis suppression confirmée.
    await expectCourseMenu(page, code, [
      'Modifier le cours',
      'Feedback du cours',
      'Supprimer le cours',
      'Quitter le cours',
    ]);
    await clickCourseMenu(page, code, 'Supprimer le cours');
    await expect(page.getByRole('heading', { name: 'Supprimer le cours ?' })).toBeVisible();
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(courseSelector(page, code)).toHaveCount(0);
    await expect(courseSelector(page, 'MAT115')).toBeVisible();
    await courseSelector(page, 'MAT115').click();
    await expect(picker.getByRole('option', { name: new RegExp(`^${code} `) })).toHaveCount(0);
  } finally {
    if (courseId !== undefined) await deleteCourseApi(profApi, courseId);
    await prof.close();
  }
});

test('un étudiant n’a que « Rejoindre des cours » et « Quitter » dans les menus contextuels', async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: storageStatePath('alice') });
  const page = await context.newPage();
  await page.goto('/home');

  // Menu du programme : aucune action de gestion. On ne clique sur rien (compte partagé).
  await expectProgramMenu(page, PROGRAM_NAME, ['Rejoindre des cours', 'Quitter le programme']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Menu du cours : seulement « Quitter le cours » ; et pas de crayon dans le sélecteur.
  // Sélection explicite du programme : sur une BD neuve, alice n'a pas de dernier emplacement
  // enregistré, donc aucun cours n'est ouvert au chargement.
  await programButton(page, PROGRAM_NAME).click();
  await expectCourseMenu(page, 'MAT115', ['Quitter le cours']);
  await page.keyboard.press('Escape');
  await courseSelector(page, 'MAT115').click();
  await expect(page.getByRole('listbox').getByRole('option', { name: /^MAT115 / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modifier le cours MAT115' })).toHaveCount(0);
  await expect(
    page.getByRole('listbox').getByRole('button', { name: 'Ajouter un cours' })
  ).toHaveCount(0);

  await context.close();
});
