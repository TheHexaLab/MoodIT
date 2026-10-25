import { expect, test, type Page } from './fixtures';
import { PROGRAM_NAME, ROLE_ACCOUNTS, createEnrolledUser } from './helpers';
import {
  clickProgramMenu,
  expectProgramMenu,
  openHome,
  openUserMenu,
  roleId,
  sessionFor,
} from './admin.helpers';

// Attribution de rôles, toujours à des comptes NEUFS : les rôles de gardien / padmin / prof ne
// changent jamais. Le compte visé garde sa page ouverte pour vérifier que ses menus se
// re-filtrent en direct (WS program:roleChanged / user:globalRolesChanged).

/** Section d'un rôle du popup (« Enseignant · 3 ») : <section> sans nom accessible. */
const roleSection = (page: Page, role: string) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^${role} · \\d+$`) }) });
const memberRow = (page: Page, role: string, email: string) =>
  roleSection(page, role).getByRole('listitem').filter({ hasText: email });

/** « + Ajouter » sur une section, recherche du compte puis clic sur le candidat. */
async function assign(page: Page, role: string, email: string) {
  await roleSection(page, role).getByRole('button', { name: '+ Ajouter' }).click();
  await page.getByPlaceholder('Rechercher un utilisateur…').fill(email);
  await roleSection(page, role)
    .getByRole('button', { name: new RegExp(email) })
    .click();
  await expect(memberRow(page, role, email)).toBeVisible();
}

const STUDENT_MENU = ['Rejoindre des cours', 'Quitter le programme'];
const TEACHER_MENU = ['Ajouter un cours', 'Rejoindre des cours', 'Quitter le programme'];

test('l’administrateur du programme donne puis retire le rôle Enseignant ; effet en direct', async ({
  browser,
  baseURL,
}) => {
  // Compte neuf abonné au programme 1 (et à MAT115) ; sa page reste ouverte.
  const { user, storageState } = await createEnrolledUser(baseURL!);
  const target = await openHome(browser, storageState);
  await expectProgramMenu(target.page, PROGRAM_NAME, STUDENT_MENU);
  await target.page.keyboard.press('Escape');

  const admin = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.padmin);
  const page = admin.page;
  try {
    await clickProgramMenu(page, PROGRAM_NAME, 'Gérer les rôles');
    await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toBeVisible();
    await expect(memberRow(page, 'Administrateur', ROLE_ACCOUNTS.padmin)).toBeVisible();
    await expect(memberRow(page, 'Enseignant', ROLE_ACCOUNTS.prof)).toBeVisible();
    await expect(memberRow(page, 'Enseignant', user.email)).toHaveCount(0);

    await assign(page, 'Enseignant', user.email);
    // Le compte visé voit « Ajouter un cours » apparaître sans recharger.
    await expectProgramMenu(target.page, PROGRAM_NAME, TEACHER_MENU);
    await target.page.keyboard.press('Escape');

    // Retrait : la poubelle de la ligne (sans nom accessible).
    await memberRow(page, 'Enseignant', user.email).getByRole('button').click();
    await expect(memberRow(page, 'Enseignant', user.email)).toHaveCount(0);
    await expectProgramMenu(target.page, PROGRAM_NAME, STUDENT_MENU);

    // Persisté : rouvrir le popup ne montre plus le compte parmi les enseignants.
    await page.reload();
    await clickProgramMenu(page, PROGRAM_NAME, 'Gérer les rôles');
    await expect(memberRow(page, 'Enseignant', ROLE_ACCOUNTS.prof)).toBeVisible();
    await expect(memberRow(page, 'Enseignant', user.email)).toHaveCount(0);
  } finally {
    await admin.close();
    await target.context.close();
  }
});

test('un Enseignant n’a pas « Gérer les rôles »', async ({ browser, baseURL }) => {
  const { page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.prof);
  await expectProgramMenu(page, PROGRAM_NAME, TEACHER_MENU);
  await close();
});

test('administrateurs globaux : le gardien promeut un compte neuf puis le rétrograde', async ({
  browser,
  baseURL,
}) => {
  const { user, storageState } = await createEnrolledUser(baseURL!);
  const target = await openHome(browser, storageState);
  const guardian = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const { api: gardienApi, page } = guardian;

  try {
    // Avant : pas de menu d'administration pour le compte neuf.
    await openUserMenu(target.page);
    await expect(
      target.page.getByRole('menuitem', { name: 'Gérer les administrateurs' })
    ).toHaveCount(0);
    await target.page.keyboard.press('Escape');

    await (await openUserMenu(page))
      .getByRole('menuitem', { name: 'Gérer les administrateurs' })
      .click();
    await expect(page.getByRole('heading', { name: 'Gérer les administrateurs' })).toBeVisible();

    // Un Gardien ne peut pas retirer SON propre rôle Gardien : pas de poubelle sur sa ligne.
    const self = memberRow(page, 'Gardien', ROLE_ACCOUNTS.gardien);
    await expect(self).toBeVisible();
    await expect(self.getByRole('button')).toHaveCount(0);

    await assign(page, 'Administrateur', user.email);

    // Le compte promu voit « Gérer les administrateurs » apparaître en direct.
    const targetMenu = await openUserMenu(target.page);
    await expect(
      targetMenu.getByRole('menuitem', { name: 'Gérer les administrateurs' })
    ).toBeVisible();
    await targetMenu.getByRole('menuitem', { name: 'Gérer les administrateurs' }).click();
    // Admin global non Gardien : n'assigne pas Gardien et ne retire personne.
    const t = target.page;
    await expect(memberRow(t, 'Administrateur', user.email)).toBeVisible();
    await expect(
      roleSection(t, 'Administrateur').getByRole('button', { name: '+ Ajouter' })
    ).toBeVisible();
    await expect(roleSection(t, 'Gardien').getByRole('button', { name: '+ Ajouter' })).toHaveCount(
      0
    );
    await expect(memberRow(t, 'Administrateur', user.email).getByRole('button')).toHaveCount(0);
    await expect(memberRow(t, 'Gardien', ROLE_ACCOUNTS.gardien).getByRole('button')).toHaveCount(0);

    // Rétrogradation par le gardien : la liste du compte visé et son menu se mettent à jour.
    await memberRow(page, 'Administrateur', user.email).getByRole('button').click();
    await expect(memberRow(page, 'Administrateur', user.email)).toHaveCount(0);
    await expect(memberRow(t, 'Administrateur', user.email)).toHaveCount(0); // adminRoles:changed
    // … et son menu du compte perd l'entrée, sans recharger.
    await t.getByRole('button', { name: '✕' }).click();
    await openUserMenu(t);
    await expect(t.getByRole('menuitem', { name: 'Gérer les administrateurs' })).toHaveCount(0);
  } finally {
    // Filet de sécurité : un compte neuf ne doit pas rester administrateur global.
    await gardienApi.post('/api/roles/global/change', {
      data: {
        type: 'unassign',
        roleId: await roleId(gardienApi, 'Administrateur', 'global'),
        userId: user.id,
      },
    });
    await guardian.close();
    await target.context.close();
  }
});
