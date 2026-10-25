import { expect, test } from './fixtures';
import { ROLE_ACCOUNTS, uniqueSuffix, waitForPopupSettled } from './helpers';
import { openUserMenu, sessionFor } from './admin.helpers';

// Journal d'audit (Gardien). L'action tracée est la création d'un établissement unique par le
// gardien (API), supprimé en fin de test : la recherche par son nom isole l'entrée malgré les
// actions des autres specs.

test('le gardien retrouve, filtre et détaille une action dans le journal', async ({
  browser,
  baseURL,
}) => {
  const suffix = uniqueSuffix();
  const name = `Audit E2E ${suffix}`;
  const domain = `audit${suffix}.e2e-test.ca`;
  const { api, page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const created = await api.post('/api/establishments', { data: { name, domainEmail: domain } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: number };

  try {
    await (await openUserMenu(page)).getByRole('menuitem', { name: 'Journalisation' }).click();
    await expect(page.getByRole('heading', { name: "Journal d'audit" })).toBeVisible();
    const filters = page.getByRole('group', { name: "Journal d'audit" });
    await expect(filters.getByRole('button', { name: 'Tout' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // Recherche (debounce côté client) sur le nom unique. On attend la réponse FILTRÉE : l'entrée,
    // toute récente, figure déjà dans la première page non filtrée, ce qui ferait passer le test
    // avant que la recherche soit appliquée.
    const search = page.getByRole('textbox', { name: 'Rechercher (résumé, auteur, contexte)…' });
    const searched = page.waitForResponse(
      (res) => res.url().includes('/api/audit-logs') && res.url().includes(`q=${suffix}`)
    );
    await search.fill(suffix);
    await searched;
    const entry = page.getByRole('button').filter({ hasText: name });
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText(ROLE_ACCOUNTS.gardien); // auteur
    await expect(entry).toContainText('Établissement'); // badge du type

    // Filtre du bon type : l'entrée reste ; un autre type : état vide filtré.
    await filters.getByRole('button', { name: 'Établissement' }).click();
    await expect(filters.getByRole('button', { name: 'Établissement' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(filters.getByRole('button', { name: 'Tout' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await expect(entry).toHaveCount(1);
    // Chaque filtre recharge la liste : la popup change de taille et se recentre. On attend
    // qu'elle soit immobile avant le clic suivant, sinon il tombe à côté.
    await waitForPopupSettled(page);
    await filters.getByRole('button', { name: 'Quiz' }).click();
    await expect(filters.getByRole('button', { name: 'Quiz' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Aucune action ne correspond à ce filtre.')).toBeVisible();
    await waitForPopupSettled(page);
    await filters.getByRole('button', { name: 'Tout' }).click();
    await expect(entry).toHaveCount(1);

    // Détail : dépliable, avec l'identifiant de l'entité.
    await expect(entry).toHaveAttribute('aria-expanded', 'false');
    await entry.click();
    await expect(entry).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText(`Identifiant : #${id}`)).toBeVisible();
    await entry.click();
    await expect(page.getByText(`Identifiant : #${id}`)).toHaveCount(0);

    // « Effacer la recherche » vide le champ et relâche le filtre texte.
    await page.getByRole('button', { name: 'Effacer la recherche' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Effacer la recherche' })).toHaveCount(0);
    await expect(page.getByText('Aucune action ne correspond à ce filtre.')).toHaveCount(0);

    await page.getByRole('button', { name: 'Fermer' }).click();
    await expect(page.getByRole('heading', { name: "Journal d'audit" })).toHaveCount(0);
  } finally {
    await api.delete(`/api/establishments/${id}`);
    await close();
  }
});

for (const role of ['padmin', 'prof'] as const) {
  test(`pas de « Journalisation » pour un non-Gardien (${role})`, async ({ browser, baseURL }) => {
    const { api, page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS[role]);
    const menu = await openUserMenu(page);
    await expect(menu.getByRole('menuitem', { name: 'Modifier le profil' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Journalisation' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Gérer les administrateurs' })).toHaveCount(0);
    // L'API refuse aussi (le menu n'est qu'un confort d'affichage).
    expect((await api.get('/api/audit-logs')).status()).toBe(403);
    await close();
  });
}
