import { expect, test, type Page, type Route } from './fixtures';
import { PROGRAM_NAME, ROLE_ACCOUNTS, createEnrolledUser, mainContent } from './helpers';
import {
  E2E_ESTABLISHMENT,
  PROGRAM_COHORT,
  clickCourseMenu,
  clickProgramMenu,
  confirmationPopup,
  courseSelector,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  escapeRegExp,
  establishmentId,
  freshAccount,
  openHome,
  openUserMenu,
  programButton,
  roleId,
  sessionFor,
} from './admin.helpers';
import { pickOption } from './quiz.helpers';
import {
  FAULTS,
  addTrueFalseQuizApi,
  apiFor,
  asGardien,
  courseNav,
  createFixture,
  deleteFixture,
  errorPopup,
  expectErrorAndClose,
  injectFault,
  member,
  openProgram,
  sidebarItem,
  underFaultsThenRecover,
  type Fixture,
} from './faults.helpers';
import { uniqueSuffix } from './helpers';

// Chemins d'erreur : chaque action qui a un message d'échec est jouée sous une panne serveur
// (HTTP 500) puis une coupure réseau (requête interrompue), injectées par `page.route`. On
// vérifie le message, que rien n'est perdu (saisie conservée, état annulé proprement) et que
// l'action aboutit une fois la route rétablie. Tout se passe dans un programme / cours de test
// créés par l'API, avec des comptes neufs : le seed et les comptes partagés ne bougent pas.

const SAVE_ERROR = "Échec de l'enregistrement. Réessaie.";

let fx: Fixture;
let quizId: number;
let quizTitle: string;

test.beforeAll(async ({ baseURL }) => {
  fx = await createFixture(baseURL!, 'Err');
  quizTitle = `Quiz pannes ${uniqueSuffix()}`;
  quizId = await asGardien(baseURL!, (api) => addTrueFalseQuizApi(api, fx.course.id, quizTitle));
});

test.afterAll(async ({ baseURL }) => {
  await deleteFixture(baseURL!, fx);
});

/** Nom du formulaire de section (champ sans label ni placeholder, cf. inventaire). */
const sectionNameField = (page: Page) =>
  page.locator('input[type="text"]:not([aria-label]):not([placeholder])');
const editorRow = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ hasText: new RegExp(`^⠿\\s*${name}$`) });

test('profil : échec de l’enregistrement, saisie conservée, puis succès', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const { page } = await openHome(browser, storageState);
  await (await openUserMenu(page)).getByRole('menuitem', { name: 'Modifier le profil' }).click();
  const heading = page.getByRole('heading', { name: 'Modifier le profil' });
  const firstName = page.getByRole('textbox', { name: 'Prénom', exact: true });
  await firstName.fill('Panne');

  await underFaultsThenRecover(
    page,
    '**/api/me',
    'PATCH',
    () => page.getByRole('button', { name: 'Enregistrer' }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      // Le popup reste ouvert avec la saisie.
      await expect(heading).toBeVisible();
      await expect(firstName).toHaveValue('Panne');
    }
  );
  await expect(heading).toBeHidden();
  const account = page.getByRole('button', { name: 'Compte utilisateur' });
  await expect(account).toContainText('Panne E2E');
  await page.reload();
  await expect(account).toContainText('Panne E2E');
});

test('créer un programme : échec puis succès (admin global neuf)', async ({ browser, baseURL }) => {
  const admin = await freshAccount(baseURL!);
  await admin.api.dispose();
  const adminRole = await asGardien(baseURL!, async (api) => {
    const id = await roleId(api, 'Administrateur', 'global');
    const res = await api.post('/api/roles/global/change', {
      data: { type: 'assign', roleId: id, userId: admin.user.id },
    });
    expect(res.ok(), `promotion : HTTP ${res.status()}`).toBe(true);
    return id;
  });
  const code = `E${uniqueSuffix()}`.toUpperCase();
  const name = `E2E Panne ${code}`;
  const { page } = await openHome(browser, admin.storageState);

  try {
    await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
    await page.getByRole('button', { name: /^\+ Créer un programme/ }).click();
    await page.getByText('Sélectionner un établissement').click();
    await page.getByRole('button', { name: E2E_ESTABLISHMENT }).click();
    await page.getByRole('textbox', { name: 'Code du programme' }).fill(code);
    await page.getByRole('textbox', { name: 'Nom du programme' }).fill(name);
    await page.getByRole('textbox', { name: 'Cohorte' }).fill('Promo panne');

    await underFaultsThenRecover(
      page,
      '**/api/establishments/programs',
      'POST',
      () => page.getByRole('button', { name: 'Créer', exact: true }).click(),
      async () => {
        await expectErrorAndClose(page, SAVE_ERROR);
        await expect(page.getByRole('heading', { name: 'Créer un programme' })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Nom du programme' })).toHaveValue(name);
        await expect(page.getByRole('textbox', { name: 'Cohorte' })).toHaveValue('Promo panne');
      }
    );
    await expect(programButton(page, name)).toBeVisible();
    await page.reload();
    await expect(programButton(page, name)).toBeVisible();
  } finally {
    await asGardien(baseURL!, async (api) => {
      const est = await establishmentId(api);
      const programs = (await (await api.get(`/api/establishments/${est}/programs`)).json()) as {
        id: number;
        code: string;
      }[];
      const created = programs.find((p) => p.code === code);
      if (created) await deleteProgramApi(api, created.id);
      await api.post('/api/roles/global/change', {
        data: { type: 'unassign', roleId: adminRole, userId: admin.user.id },
      });
    });
  }
});

test('créer un cours : échec puis succès (enseignant)', async ({ browser, baseURL }) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const { page } = await openProgram(browser, teacher.storageState, fx.program);
  const code = `K${uniqueSuffix()}`.toUpperCase();
  const title = `Cours panne ${code}`;
  let courseId: number | undefined;
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/programs/courses') && res.request().method() === 'POST' && res.ok()) {
      courseId = ((await res.json()) as { id: number }).id;
    }
  });

  try {
    await clickProgramMenu(page, fx.program.name, 'Ajouter un cours');
    await page.getByText('Sélectionner un établissement').click();
    await page.getByRole('button', { name: E2E_ESTABLISHMENT }).click();
    await page.getByText('Sélectionner des programmes').click();
    await page
      .getByRole('button', { name: new RegExp(`^${fx.program.code} ${escapeRegExp(fx.program.name)}`) })
      .click();
    await page.getByRole('textbox', { name: 'Code du cours' }).fill(code);
    await page.getByRole('textbox', { name: 'Titre du cours' }).fill(title);

    await underFaultsThenRecover(
      page,
      '**/api/programs/courses',
      'POST',
      () => page.getByRole('button', { name: 'Sauvegarder' }).click(),
      async () => {
        await expectErrorAndClose(page, SAVE_ERROR);
        await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Titre du cours' })).toHaveValue(title);
        await expect(page.getByRole('button', { name: `Retirer ${fx.program.name}` }).first()).toBeVisible();
      }
    );
    await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toHaveCount(0);
    // Créé et inscrit : le cours est dans le sélecteur.
    await courseSelector(page, fx.course.code).click();
    await expect(page.getByRole('listbox').getByRole('option', { name: `${code} ${title}` })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(courseId).toBeDefined();
  } finally {
    if (courseId !== undefined) await asGardien(baseURL!, (api) => deleteCourseApi(api, courseId!));
  }
});

test('modifier le cours et le programme : échec puis succès (administrateur du programme)', async ({
  browser,
  baseURL,
}) => {
  const admin = await member(baseURL!, fx, 'Administrateur');
  const { page } = await openProgram(browser, admin.storageState, fx.program);
  const picker = page.getByRole('listbox');
  const newTitle = `${fx.course.title} (panne)`;

  // Cours : titre modifié, PATCH en panne puis rétabli.
  await courseSelector(page, fx.course.code).click();
  await picker.getByRole('button', { name: `Modifier le cours ${fx.course.code}` }).click();
  const titleField = page.getByRole('textbox', { name: 'Titre du cours' });
  await titleField.fill(newTitle);
  await underFaultsThenRecover(
    page,
    `**/api/courses/${fx.course.id}`,
    'PATCH',
    () => page.getByRole('button', { name: 'Enregistrer' }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toBeVisible();
      await expect(titleField).toHaveValue(newTitle);
    }
  );
  await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toHaveCount(0);
  await courseSelector(page, fx.course.code).click();
  await expect(picker.getByRole('option', { name: `${fx.course.code} ${newTitle}` })).toBeVisible();
  await page.keyboard.press('Escape');

  // Programme : cohorte modifiée (le nom reste : les autres tests le cherchent dans le rail).
  await clickProgramMenu(page, fx.program.name, 'Modifier le programme');
  const cohort = page.getByRole('textbox', { name: 'Cohorte' });
  await expect(cohort).toHaveValue(PROGRAM_COHORT);
  await cohort.fill('Promo rétablie');
  await underFaultsThenRecover(
    page,
    `**/api/programs/${fx.program.id}`,
    'PATCH',
    () => page.getByRole('button', { name: 'Enregistrer' }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toBeVisible();
      await expect(cohort).toHaveValue('Promo rétablie');
    }
  );
  await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toHaveCount(0);
  // Persisté côté serveur.
  const api = await apiFor(baseURL!, admin.storageState);
  const program = (await (await api.get(`/api/programs/${fx.program.id}`)).json()) as {
    cohort: string;
  };
  expect(program.cohort).toBe('Promo rétablie');
  await api.dispose();
});

test('rejoindre un programme puis ses cours : échecs de chargement et d’enregistrement', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const { page } = await openHome(browser, storageState);
  const main = mainContent(page);

  // Rejoindre le programme : l'enregistrement échoue, la sélection reste cochée, puis réussit.
  await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
  await page.getByRole('button', { name: /^↪ Rejoindre un programme/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${escapeRegExp(E2E_ESTABLISHMENT)} `) }).click();
  await page.getByPlaceholder('Rechercher un programme…').fill(fx.program.name);
  // Ligne = code + nom + cohorte (la cohorte a pu être modifiée par un autre test du fichier) ;
  // la pastille du rail, elle, s'appelle juste « nom » (sans suite).
  const row = page.getByRole('button', { name: new RegExp(`${escapeRegExp(fx.program.name)} `) });
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await underFaultsThenRecover(
    page,
    '**/api/programs/users',
    'POST',
    () => page.getByRole('button', { name: 'Enregister' }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(row).toHaveAttribute('aria-pressed', 'true');
    }
  );
  await expect(programButton(page, fx.program.name)).toBeVisible();
  await programButton(page, fx.program.name).click();
  await expect(main.getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();

  // Rejoindre des cours : la liste ne se charge pas (« Réessayer »), puis l'inscription échoue.
  for (const fault of FAULTS) {
    const restore = await injectFault(page, `**/api/programs/${fx.program.id}/courses`, fault, 'GET');
    await clickProgramMenu(page, fx.program.name, 'Rejoindre des cours');
    await expect(page.getByText('Échec du chargement des cours. Réessaie.')).toBeVisible();
    await restore();
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByRole('button', { name: new RegExp(fx.course.title) })).toBeVisible();
    await page.getByRole('button', { name: 'Annuler' }).click();
  }
  await clickProgramMenu(page, fx.program.name, 'Rejoindre des cours');
  const courseRow = page.getByRole('button', { name: new RegExp(fx.course.title) });
  await courseRow.click();
  await expect(courseRow).toHaveAttribute('aria-pressed', 'true');
  await underFaultsThenRecover(
    page,
    '**/api/courses/users',
    'POST',
    () => page.getByRole('button', { name: 'Rejoindre', exact: true }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(courseRow).toHaveAttribute('aria-pressed', 'true');
    }
  );
  await expect(courseSelector(page, fx.course.code)).toBeVisible();
  await page.reload();
  await programButton(page, fx.program.name).click();
  await expect(courseSelector(page, fx.course.code)).toBeVisible();
});

test('quitter le cours puis le programme : « Impossible de … Réessaie. » puis succès', async ({
  browser,
  baseURL,
}) => {
  const student = await member(baseURL!, fx);
  const { page } = await openProgram(browser, student.storageState, fx.program);
  const main = mainContent(page);

  await underFaultsThenRecover(
    page,
    `**/api/courses/${fx.course.id}/users/*`,
    'DELETE',
    async () => {
      await clickCourseMenu(page, fx.course.code, 'Quitter le cours');
      await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    },
    async () => {
      await expectErrorAndClose(page, 'Impossible de quitter le cours. Réessaie.');
      await expect(courseSelector(page, fx.course.code)).toBeVisible(); // toujours inscrit
    }
  );
  await expect(main.getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();

  await underFaultsThenRecover(
    page,
    `**/api/programs/${fx.program.id}/users/*`,
    'DELETE',
    async () => {
      await clickProgramMenu(page, fx.program.name, 'Quitter le programme');
      await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    },
    async () => {
      await expectErrorAndClose(page, 'Impossible de quitter le programme. Réessaie.');
      await expect(programButton(page, fx.program.name)).toBeVisible();
    }
  );
  await expect(programButton(page, fx.program.name)).toHaveCount(0);
  await expect(main.getByRole('heading', { name: 'Bienvenue sur MoodIT' })).toBeVisible();
  await page.reload();
  await expect(programButton(page, fx.program.name)).toHaveCount(0);
});

test('supprimer le cours puis le programme : « Impossible de … Réessaie. » puis succès', async ({
  browser,
  baseURL,
}) => {
  // Programme et cours jetables, un admin global neuf (seul rôle qui supprime un programme).
  const admin = await freshAccount(baseURL!);
  const { program, course, adminRole } = await asGardien(baseURL!, async (api) => {
    const program = await createProgramApi(api, 'Suppr');
    const course = await createCourseApi(api, [program.id], 'SU');
    const adminRole = await roleId(api, 'Administrateur', 'global');
    const res = await api.post('/api/roles/global/change', {
      data: { type: 'assign', roleId: adminRole, userId: admin.user.id },
    });
    expect(res.ok()).toBe(true);
    return { program, course, adminRole };
  });
  await enrollApi(admin.api, program.id, [course.id]);
  await admin.api.dispose();
  const { page } = await openProgram(browser, admin.storageState, program);
  const main = mainContent(page);

  try {
    await underFaultsThenRecover(
      page,
      `**/api/courses/${course.id}`,
      'DELETE',
      async () => {
        await clickCourseMenu(page, course.code, 'Supprimer le cours');
        await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
      },
      async () => {
        await expectErrorAndClose(page, 'Impossible de supprimer le cours. Réessaie.');
        await expect(courseSelector(page, course.code)).toBeVisible();
      }
    );
    await expect(main.getByRole('heading', { name: "Ce programme n'a pas de cours" })).toBeVisible();

    await underFaultsThenRecover(
      page,
      `**/api/programs/${program.id}`,
      'DELETE',
      async () => {
        await clickProgramMenu(page, program.name, 'Supprimer le programme');
        await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
      },
      async () => {
        await expectErrorAndClose(page, 'Impossible de supprimer le programme. Réessaie.');
        await expect(programButton(page, program.name)).toBeVisible();
      }
    );
    await expect(programButton(page, program.name)).toHaveCount(0);
    await asGardien(baseURL!, async (api) => {
      expect((await api.get(`/api/programs/${program.id}`)).ok()).toBe(false);
    });
  } finally {
    await asGardien(baseURL!, async (api) => {
      await deleteCourseApi(api, course.id);
      await deleteProgramApi(api, program.id);
      await api.post('/api/roles/global/change', {
        data: { type: 'unassign', roleId: adminRole, userId: admin.user.id },
      });
    });
  }
});

test('sections : création en panne (saisie conservée) et suppression annulée', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const { page } = await openProgram(browser, teacher.storageState, fx.program);
  const name = `panne-${uniqueSuffix()}`;
  const sectionsUrl = `**/api/courses/${fx.course.id}/sections`;

  await courseNav(page).getByRole('button', { name: 'Modifier la section CANAUX' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toBeVisible();
  await page.getByRole('button', { name: '+ Ajouter un canal' }).click();
  await sectionNameField(page).fill(name);
  await underFaultsThenRecover(
    page,
    sectionsUrl,
    'PATCH',
    () => page.getByRole('button', { name: 'Enregistrer' }).click(),
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(page.getByRole('heading', { name: 'Nouveau canal' })).toBeVisible();
      await expect(sectionNameField(page)).toHaveValue(name);
      await expect(editorRow(page, name)).toHaveCount(0);
    }
  );
  await expect(editorRow(page, name)).toBeVisible();
  await expect(sidebarItem(page, name)).toBeVisible();

  // Suppression : l'optimiste est annulé (la ligne revient) tant que la panne dure.
  const deleteIcon = () => editorRow(page, name).locator('> div').last().locator('svg').nth(1);
  await underFaultsThenRecover(
    page,
    sectionsUrl,
    'PATCH',
    async () => {
      await deleteIcon().click();
      await expect(page.getByRole('heading', { name: 'Supprimer un canal ?' })).toBeVisible();
      await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    },
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(editorRow(page, name)).toBeVisible();
      await expect(sidebarItem(page, name)).toBeVisible();
    }
  );
  await expect(editorRow(page, name)).toHaveCount(0);
  await expect(sidebarItem(page, name)).toHaveCount(0);
  await page.reload();
  await programButton(page, fx.program.name).click();
  await expect(sidebarItem(page, fx.channelName)).toBeVisible();
  await expect(sidebarItem(page, name)).toHaveCount(0);
});

test('rôles : attribution en panne (optimiste annulé) et membres introuvables', async ({
  browser,
  baseURL,
}) => {
  const admin = await member(baseURL!, fx, 'Administrateur');
  const target = await member(baseURL!, fx);
  const { page } = await openProgram(browser, admin.storageState, fx.program);
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /^Enseignant · \d+$/ }) });
  const memberRow = section.getByRole('listitem').filter({ hasText: target.user.email });

  await clickProgramMenu(page, fx.program.name, 'Gérer les rôles');
  await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toBeVisible();
  await underFaultsThenRecover(
    page,
    '**/api/roles/change',
    'POST',
    async () => {
      // Le sélecteur se referme à chaque choix : on le rouvre si besoin (« + Ajouter » bascule).
      const search = page.getByPlaceholder('Rechercher un utilisateur…');
      if (!(await search.isVisible())) await section.getByRole('button', { name: '+ Ajouter' }).click();
      await search.fill(target.user.email);
      await section.getByRole('button', { name: new RegExp(target.user.email) }).click();
    },
    async () => {
      await expectErrorAndClose(page, SAVE_ERROR);
      await expect(memberRow).toHaveCount(0); // rollback de l'ajout optimiste
    }
  );
  await expect(memberRow).toBeVisible();
  await page.reload();
  await clickProgramMenu(page, fx.program.name, 'Gérer les rôles');
  await expect(memberRow).toBeVisible();
  await page.getByRole('button', { name: '✕' }).click();

  // Chargement des membres en panne : popup d'erreur, « Fermer » referme tout ; puis OK.
  for (const fault of FAULTS) {
    const restore = await injectFault(page, `**/api/programs/${fx.program.id}/users`, fault, 'GET');
    await clickProgramMenu(page, fx.program.name, 'Gérer les rôles');
    await expectErrorAndClose(page, 'Impossible de charger les membres du programme. Réessaie.');
    await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toHaveCount(0);
    await restore();
  }
  await clickProgramMenu(page, fx.program.name, 'Gérer les rôles');
  await expect(memberRow).toBeVisible();
});

test('établissements : chargement, création et suppression en panne (gardien)', async ({
  browser,
  baseURL,
}) => {
  const suffix = uniqueSuffix();
  const name = `Établissement panne ${suffix}`;
  const domain = `panne${suffix}.e2e-test.ca`;
  const { api, page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const row = page.getByRole('listitem').filter({ hasText: new RegExp(`^${escapeRegExp(name)}`) });
  let createdId: number | undefined;
  page.on('response', async (res) => {
    if (res.url().endsWith('/api/establishments') && res.request().method() === 'POST' && res.ok()) {
      createdId = ((await res.json()) as { id: number }).id;
    }
  });

  try {
    await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
    // Liste introuvable : erreur, on reste sur le menu ; rétabli, la vue s'ouvre.
    for (const fault of FAULTS) {
      const restore = await injectFault(page, '**/api/establishments', fault, 'GET');
      await page.getByRole('button', { name: /^⚙ Gérer les établissements/ }).click();
      await expectErrorAndClose(page, 'Échec du chargement. Vérifie ta connexion et réessaie.');
      await expect(page.getByRole('heading', { name: 'Ajouter un programme' })).toBeVisible();
      await restore();
    }
    await page.getByRole('button', { name: /^⚙ Gérer les établissements/ }).click();
    await expect(page.getByRole('heading', { name: 'Gérer les établissements' })).toBeVisible();

    await page.getByRole('button', { name: '+ Ajouter un établissement' }).click();
    const nameInput = page.getByPlaceholder("Nom de l'établissement");
    const domainInput = page.getByPlaceholder('Domaine courriel (ex. usherbrooke.ca)');
    await nameInput.fill(name);
    await domainInput.fill(domain);
    await underFaultsThenRecover(
      page,
      '**/api/establishments',
      'POST',
      () => page.getByRole('button', { name: 'Créer', exact: true }).click(),
      async () => {
        await expectErrorAndClose(page, SAVE_ERROR);
        await expect(page.getByRole('heading', { name: 'Ajouter un établissement' })).toBeVisible();
        await expect(nameInput).toHaveValue(name);
        await expect(domainInput).toHaveValue(domain);
      }
    );
    await expect(row).toContainText(`${domain} · Aucun programme`);
    expect(createdId).toBeDefined();

    await underFaultsThenRecover(
      page,
      `**/api/establishments/${createdId}`,
      'DELETE',
      async () => {
        await row.getByRole('button', { name: 'Supprimer' }).click();
        await confirmationPopup(page, "Supprimer l'établissement")
          .getByRole('button', { name: 'Supprimer', exact: true })
          .click();
      },
      async () => {
        await expectErrorAndClose(page, SAVE_ERROR);
        await expect(row).toBeVisible();
      }
    );
    await expect(row).toHaveCount(0);
    expect((await api.get(`/api/establishments/${createdId}`)).ok()).toBe(false);
  } finally {
    if (createdId !== undefined) await api.delete(`/api/establishments/${createdId}`);
    await close();
  }
});

test('chat : historique introuvable, « Réessayer » recharge une fois la route rétablie', async ({
  browser,
  baseURL,
}) => {
  const student = await member(baseURL!, fx);
  const text = `Message chat panne ${uniqueSuffix()}`;
  const api = await apiFor(baseURL!, student.storageState);
  const sent = await api.post('/api/forums/messages', {
    data: { forumId: fx.channelId, parentPostId: null, content: text, clientMessageId: uniqueSuffix() },
  });
  expect(sent.ok()).toBe(true);
  await api.dispose();
  const { page } = await openProgram(browser, student.storageState, fx.program);
  const main = mainContent(page);

  for (const fault of FAULTS) {
    const restore = await injectFault(page, new RegExp(`/api/forums/${fx.channelId}/messages\\?`), fault, 'GET');
    await page.reload();
    await programButton(page, fx.program.name).click();
    await sidebarItem(page, fx.channelName).click();
    await expect(main.getByText('Impossible de charger les messages. Réessayez.')).toBeVisible();
    await expect(main.getByText(text)).toHaveCount(0);
    await restore();
    await main.getByRole('button', { name: 'Réessayer' }).click();
    await expect(main.getByText(text)).toBeVisible();
    // Le canal reste utilisable : le composeur est là.
    await expect(main.getByRole('textbox', { name: `Envoyer un message dans ${fx.channelName}` })).toBeVisible();
  }
});

test('forum : sujets puis réponses introuvables, « Réessayer » après rétablissement', async ({
  browser,
  baseURL,
}) => {
  const student = await member(baseURL!, fx);
  const title = `Sujet panne ${uniqueSuffix()}`;
  const answer = `Réponse panne ${uniqueSuffix()}`;
  const api = await apiFor(baseURL!, student.storageState);
  const post = async (content: string, t: string | null, parent: number | null) => {
    const res = await api.post('/api/forums/posts', {
      data: { forumId: fx.forumId, parentPostId: parent, content, title: t, clientPostId: uniqueSuffix() },
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { id: number }).id;
  };
  const threadId = await post(`Corps de ${title}`, title, null);
  await post(answer, null, threadId);
  await api.dispose();
  const { page } = await openProgram(browser, student.storageState, fx.program);
  const main = mainContent(page);
  const card = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

  for (const fault of FAULTS) {
    const restoreThreads = await injectFault(page, new RegExp(`/api/forums/${fx.forumId}/posts\\?`), fault, 'GET');
    await page.reload();
    await programButton(page, fx.program.name).click();
    await sidebarItem(page, fx.forumName).click();
    await expect(main.getByText('Impossible de charger les sujets. Réessayez.')).toBeVisible();
    await restoreThreads();
    await main.getByRole('button', { name: 'Réessayer' }).click();
    await expect(card).toBeVisible();

    // Réponses (chargement paresseux au dépliage) : erreur de branche puis « Réessayer ».
    const restoreReplies = await injectFault(page, `**/api/forums/${fx.forumId}/posts/${threadId}/replies`, fault, 'GET');
    await card.getByRole('button', { name: 'Déplier les réponses' }).first().click();
    await expect(card.getByText('Impossible de charger les réponses.')).toBeVisible();
    await expect(card.getByText(answer, { exact: true })).toHaveCount(0);
    await restoreReplies();
    await card.getByRole('button', { name: 'Réessayer' }).click();
    await expect(card.getByText(answer, { exact: true })).toBeVisible();
  }
});

test('quiz : chargement impossible puis « Réessayer »', async ({ browser, baseURL }) => {
  const student = await member(baseURL!, fx);
  const { page } = await openProgram(browser, student.storageState, fx.program);
  const main = mainContent(page);

  for (const fault of FAULTS) {
    const restore = await injectFault(page, new RegExp(`/api/quizzes/${quizId}$`), fault, 'GET');
    await page.reload();
    await programButton(page, fx.program.name).click();
    await sidebarItem(page, quizTitle).click();
    await expect(main.getByText('Impossible de charger le quiz. Réessayez.')).toBeVisible();
    await restore();
    await main.getByRole('button', { name: 'Réessayer' }).click();
    await expect(main).toContainText('Question 1 sur 1');
    await expect(main).toContainText('Le ciel est bleu.');
  }
});

test('quiz : soumission impossible, « Réessayer » aboutit une fois la route rétablie', async ({
  browser,
  baseURL,
}) => {
  const student = await member(baseURL!, fx);
  const { page } = await openProgram(browser, student.storageState, fx.program);
  const main = mainContent(page);
  await sidebarItem(page, quizTitle).click();
  await expect(main).toContainText('Question 1 sur 1');
  const answer = main.getByRole('button', { name: 'Vrai', exact: true });
  await answer.click();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  const url = `**/api/quizzes/${quizId}/submissions`;
  const popup = errorPopup(page, 'Soumission impossible');

  // Panne serveur : « Fermer » ramène à la passation, réponse conservée.
  const restoreServer = await injectFault(page, url, 'server', 'POST');
  await main.getByRole('button', { name: 'Soumettre' }).click();
  await expect(popup).toContainText('La soumission a échoué. Réessayez.');
  await popup.getByRole('button', { name: 'Fermer' }).click();
  await expect(popup).toBeHidden();
  await expect(answer).toHaveAttribute('aria-pressed', 'true');
  await restoreServer();

  // Coupure réseau : « Réessayer » du popup renvoie la tentative, qui aboutit.
  const restoreNetwork = await injectFault(page, url, 'network', 'POST');
  await main.getByRole('button', { name: 'Soumettre' }).click();
  await expect(popup).toContainText('La soumission a échoué. Réessayez.');
  await restoreNetwork();
  await popup.getByRole('button', { name: 'Réessayer' }).click();
  await expect(main.getByRole('heading', { name: `${quizTitle} — terminé !` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main).toContainText('1 / 1 points');
});

test('éditeur de quiz : enregistrement en panne (formulaire conservé) puis succès', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const { page } = await openProgram(browser, teacher.storageState, fx.program);
  const title = `Quiz éditeur panne ${uniqueSuffix()}`;
  const api = await apiFor(baseURL!, teacher.storageState);

  try {
    await courseNav(page).getByRole('button', { name: 'Modifier la section QUIZ' }).click();
    await page.getByRole('button', { name: 'Créer un quiz' }).click();
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Question de panne');
    await pickOption(page, 'Type de question', 'Vrai/Faux');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Nouveau quiz' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Titre' }).fill(title);

    await underFaultsThenRecover(
      page,
      `**/api/courses/${fx.course.id}/quizzes`,
      'POST',
      () => page.getByRole('button', { name: 'Créer', exact: true }).click(),
      async () => {
        await expectErrorAndClose(page, "L'enregistrement a échoué. Réessayez.");
        await expect(page.getByRole('heading', { name: 'Nouveau quiz' })).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Titre' })).toHaveValue(title);
        await expect(page.getByText('Question de panne')).toBeVisible();
      }
    );
    await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
    const res = await api.get(`/api/courses/${fx.course.id}/quizzes/manage`);
    const titles = ((await res.json()) as { title: string }[]).map((q) => q.title);
    expect(titles).toContain(title);
  } finally {
    const res = await api.get(`/api/courses/${fx.course.id}/quizzes/manage`);
    if (res.ok()) {
      for (const q of (await res.json()) as { id: number; title: string }[]) {
        if (q.title === title) await api.delete(`/api/quizzes/${q.id}`);
      }
    }
    await api.dispose();
  }
});

test('éditeur de quiz : l’évaluation du code échoue puis « Réessayer » corrige', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const { page } = await openProgram(browser, teacher.storageState, fx.program);

  await courseNav(page).getByRole('button', { name: 'Modifier la section QUIZ' }).click();
  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Écris `solution(a, b)` qui renvoie a + b.');
  await pickOption(page, 'Type de question', 'Code');
  await expect(page.getByRole('button', { name: 'Langage' })).toHaveText('Python');
  await page.getByRole('textbox', { name: 'Code de départ' }).fill('def solution(a, b):\n    return 0\n');
  await page.getByRole('button', { name: 'Gérer' }).click();
  await page.getByRole('button', { name: '+ Ajouter un harnais' }).click();
  await page.getByPlaceholder('Nom du cas (ex. Cas nominal)').fill('Somme');
  await page.getByRole('textbox', { name: 'Code du harnais 1' }).fill('return solution(2, 3) == 5');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('button', { name: 'Tester', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tester la question' })).toBeVisible();
  await page
    .getByRole('textbox', { name: 'Éditeur de code (Python)' })
    .fill('def solution(a, b):\n    return a + b\n');

  const popup = errorPopup(page);
  const restoreServer = await injectFault(page, '**/exec/evaluate', 'server', 'POST');
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(popup).toContainText("L'évaluation du code a échoué. Réessayez.");
  await popup.getByRole('button', { name: 'Fermer' }).click();
  await expect(popup).toBeHidden();
  // Le code saisi n'est pas perdu.
  await expect(page.getByRole('textbox', { name: 'Éditeur de code (Python)' })).toHaveValue(/return a \+ b/);
  await restoreServer();

  const restoreNetwork = await injectFault(page, '**/exec/evaluate', 'network', 'POST');
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(popup).toContainText("L'évaluation du code a échoué. Réessayez.");
  await restoreNetwork();
  await popup.getByRole('button', { name: 'Réessayer' }).click();
  await expect(page.getByText('Résultat des tests')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('+1/1', { exact: true })).toBeVisible();
  // Rien n'est persisté : on ferme sans créer.
  await page.getByRole('button', { name: 'Fermer' }).click();
});

test('MCP : historique, lancement et détail en panne, puis rétablis', async ({ browser, baseURL }) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const { page } = await openProgram(browser, teacher.storageState, fx.program);
  const analysesUrl = `**/mcp/courses/${fx.course.id}/analyses`;
  const rows = page.getByRole('button', { name: /\d+ forces? · \d+ points? à améliorer$/ });

  // Historique introuvable → « Réessayer » une fois rétabli.
  for (const fault of FAULTS) {
    const restore = await injectFault(page, analysesUrl, fault, 'GET');
    await clickCourseMenu(page, fx.course.code, 'Feedback du cours');
    await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toBeVisible();
    await expect(page.getByText('Échec du chargement des analyses. Réessaie.')).toBeVisible();
    await restore();
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByText('Échec du chargement des analyses. Réessaie.')).toHaveCount(0);
    await expect(page.getByText('Chargement des analyses…')).toBeHidden();
    await page.getByRole('button', { name: '✕' }).click();
    await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toHaveCount(0);
  }

  // Lancement : le POST échoue → message, bouton de nouveau actif ; rétabli → nouvelle analyse.
  await clickCourseMenu(page, fx.course.code, 'Feedback du cours');
  await expect(page.getByText('Chargement des analyses…')).toBeHidden();
  const before = await rows.count();
  await underFaultsThenRecover(
    page,
    analysesUrl,
    'POST',
    () => page.getByRole('button', { name: 'Analyser' }).click(),
    async () => {
      await expectErrorAndClose(page, 'L’analyse n’a pas pu être générée.');
      await expect(page.getByRole('button', { name: 'Analyser' })).toBeEnabled();
      await expect(rows).toHaveCount(before);
    }
  );
  await expect(rows).toHaveCount(before + 1, { timeout: 30_000 });

  // Détail introuvable → « Réessayer » affiche le bilan.
  for (const fault of FAULTS) {
    const restore = await injectFault(page, '**/mcp/analyses/*', fault, 'GET');
    await rows.first().click();
    await expect(page.getByText('Échec du chargement de l’analyse. Réessaie.')).toBeVisible();
    await restore();
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByText('Bilan global du cours')).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(rows.first()).toBeVisible();
  }
});

test('journal d’audit : chargement en panne puis « Réessayer » (gardien)', async ({
  browser,
  baseURL,
}) => {
  const { page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const heading = page.getByRole('heading', { name: "Journal d'audit" });
  const message = 'Échec du chargement du journal. Réessaie.';

  // Panne serveur : « Fermer » referme le journal.
  const restoreServer = await injectFault(page, /\/api\/audit-logs\?/, 'server', 'GET');
  await (await openUserMenu(page)).getByRole('menuitem', { name: 'Journalisation' }).click();
  await expectErrorAndClose(page, message);
  await expect(heading).toHaveCount(0);
  await restoreServer();

  // Coupure réseau : « Réessayer » recharge une fois la route rétablie.
  const restoreNetwork = await injectFault(page, /\/api\/audit-logs\?/, 'network', 'GET');
  await (await openUserMenu(page)).getByRole('menuitem', { name: 'Journalisation' }).click();
  await expect(errorPopup(page)).toContainText(message);
  await restoreNetwork();
  await errorPopup(page).getByRole('button', { name: 'Réessayer' }).click();
  await expect(errorPopup(page)).toBeHidden();
  await expect(heading).toBeVisible();
  // Des entrées sont listées (au moins celles créées par cette suite).
  await expect(page.getByRole('listitem').getByRole('button').first()).toBeVisible();
  await close();
});

test('programmes et cours : chargement impossible puis « Réessayer »', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const { page } = await openHome(browser, storageState);

  for (const fault of FAULTS) {
    const restore = await injectFault(page, /\/api\/users\/\d+\/programs$/, fault, 'GET');
    await page.goto('/home');
    const retry = page.getByRole('button', { name: 'Réessayer le chargement des programmes' });
    await expect(retry).toBeVisible();
    await expect(programButton(page, PROGRAM_NAME)).toHaveCount(0);
    await restore();
    await retry.click();
    await expect(programButton(page, PROGRAM_NAME)).toBeVisible();
  }

  for (const fault of FAULTS) {
    const restore = await injectFault(page, /\/api\/users\/\d+\/programs\/\d+\/enrollments/, fault, 'GET');
    await page.goto('/home');
    await programButton(page, PROGRAM_NAME).click();
    const nav = courseNav(page);
    await expect(nav.getByText('Chargement impossible')).toBeVisible();
    await expect(nav.getByText('Impossible de charger les cours. Réessayez.')).toBeVisible();
    await restore();
    await nav.getByRole('button', { name: 'Réessayer' }).click();
    await expect(courseSelector(page, 'MAT115')).toBeVisible();
  }
});

test('un 401 d’une API renvoie à la connexion', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const { page } = await openHome(browser, storageState);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();

  const handler = (route: Route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"expiré"}' });
  await page.route('**/api/me', handler);
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: 'Se connecter →' })).toBeVisible();

  // La session (cookie) est intacte : sans la panne, /home se rouvre.
  await page.unroute('**/api/me', handler);
  await page.goto('/home');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
});
