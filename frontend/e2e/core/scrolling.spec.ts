import { expect, test, type Locator } from './fixtures';
import { ROLE_ACCOUNTS, mainContent, uniqueSuffix } from './helpers';
import { clickProgramMenu, openUserMenu, sessionFor } from './admin.helpers';
import {
  apiFor,
  createFixture,
  deleteFixture,
  member,
  openProgram,
  postMessageApi,
  postThreadApi,
  sidebarItem,
  type Fixture,
} from './faults.helpers';

// Défilements infinis. Les données sont créées par l'API, en quantité juste au-dessus d'une
// page, dans un cours NEUF d'un programme de test (jamais dans MAT115) ; on vérifie à chaque
// fois que la page suivante s'ajoute dans le bon ordre et sans doublon.

let fx: Fixture;

test.beforeAll(async ({ baseURL }) => {
  fx = await createFixture(baseURL!, 'Scroll');
});

test.afterAll(async ({ baseURL }) => {
  await deleteFixture(baseURL!, fx);
});

/** Numéro à deux chiffres, pour des libellés qui se trient naturellement. */
const nn = (i: number) => String(i).padStart(2, '0');

/** Défile un conteneur jusqu'en haut (`'top'`) ou en bas (`'bottom'`) pour déclencher le chargement. */
const scrollTo = (container: Locator, edge: 'top' | 'bottom') =>
  container.evaluate((el, where) => {
    el.scrollTop = where === 'top' ? 0 : el.scrollHeight;
  }, edge);

function expectOrderedUnique(texts: string[], expected: string[]) {
  expect(new Set(texts).size, 'aucun doublon').toBe(texts.length);
  expect(texts).toEqual(expected);
}

test('chat : remonter charge la page précédente (30 par page), ordre chronologique, sans doublon', async ({
  browser,
  baseURL,
}) => {
  const author = await member(baseURL!, fx);
  const tag = uniqueSuffix();
  const label = (i: number) => `Défilement ${tag} ${nn(i)}`;
  const api = await apiFor(baseURL!, author.storageState);
  for (let i = 1; i <= 35; i++) await postMessageApi(api, fx.channelId, label(i));
  await api.dispose();

  const reader = await member(baseURL!, fx);
  const { page } = await openProgram(browser, reader.storageState, fx.program);
  await sidebarItem(page, fx.channelName).click();
  const main = mainContent(page);
  const messages = main.getByRole('paragraph').filter({ hasText: new RegExp(`^Défilement ${tag} \\d\\d$`) });
  const list = main.locator('ul').first();

  // Première page : les 30 plus récents, du plus ancien (06) au plus récent (35).
  await expect(messages).toHaveCount(30);
  await expect(messages.first()).toHaveText(label(6));
  await expect(messages.last()).toHaveText(label(35));

  // Remonter en haut : la page précédente se place AVANT, l'ordre reste chronologique.
  await scrollTo(list, 'top');
  await expect(messages).toHaveCount(35);
  expectOrderedUnique(
    await messages.allTextContents(),
    Array.from({ length: 35 }, (_, i) => label(i + 1))
  );
  // Il n'y a plus rien à charger : remonter encore ne change rien.
  await scrollTo(list, 'top');
  await expect(messages).toHaveCount(35);
});

test('forum : descendre charge les sujets suivants (20 par page) ; réponses chargées au dépliage', async ({
  browser,
  baseURL,
}) => {
  const author = await member(baseURL!, fx);
  const tag = uniqueSuffix();
  const title = (i: number) => `Sujet défilement ${tag} ${nn(i)}`;
  const api = await apiFor(baseURL!, author.storageState);
  const ids: number[] = [];
  for (let i = 1; i <= 25; i++) ids.push(await postThreadApi(api, fx.forumId, `Corps ${i}`, title(i)));
  // Trois réponses au sujet le plus récent (chargées paresseusement au dépliage).
  const replies = [1, 2, 3].map((i) => `Réponse ${tag} ${i}`);
  for (const content of replies) await postThreadApi(api, fx.forumId, content, null, ids[24]);
  await api.dispose();

  const reader = await member(baseURL!, fx);
  const { page } = await openProgram(browser, reader.storageState, fx.program);
  await sidebarItem(page, fx.forumName).click();
  const main = mainContent(page);
  const titles = main.getByRole('heading', { level: 2 }).filter({ hasText: new RegExp(`^Sujet défilement ${tag}`) });
  const body = main.locator('[role="body"]');

  // Première page : les 20 plus récents (25 → 06).
  await expect(titles).toHaveCount(20);
  await expect(titles.first()).toHaveText(title(25));
  await expect(titles.last()).toHaveText(title(6));

  await scrollTo(body, 'bottom');
  await expect(titles).toHaveCount(25);
  expectOrderedUnique(
    await titles.allTextContents(),
    Array.from({ length: 25 }, (_, i) => title(25 - i))
  );
  await scrollTo(body, 'bottom');
  await expect(titles).toHaveCount(25);

  // Réponses : absentes du DOM tant que le fil n'est pas déplié, puis une requête les apporte.
  await scrollTo(body, 'top');
  const card = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title(25), exact: true }) });
  await expect(card.getByRole('button', { name: 'Déplier les réponses' })).toHaveText('3 réponses');
  await expect(main.getByText(replies[0], { exact: true })).toHaveCount(0);
  const loaded = page.waitForResponse(
    (res) => res.url().endsWith(`/api/forums/${fx.forumId}/posts/${ids[24]}/replies`) && res.ok()
  );
  await card.getByRole('button', { name: 'Déplier les réponses' }).click();
  await loaded;
  for (const content of replies) await expect(card.getByText(content, { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Replier les réponses' })).toHaveText('3 réponses');
});

test('rôles : les candidats se chargent 10 par 10 au défilement', async ({ browser, baseURL }) => {
  // 12 membres neufs sans rôle + l'administrateur (candidat aussi : il n'est pas Enseignant),
  // en plus des membres créés par les autres tests de ce fichier (tous sans rôle Enseignant) :
  // le total attendu est lu par l'API.
  const admin = await member(baseURL!, fx, 'Administrateur');
  const emails: string[] = [admin.user.email];
  for (let i = 0; i < 12; i++) emails.push((await member(baseURL!, fx)).user.email);
  const api = await apiFor(baseURL!, admin.storageState);
  const members = (await (await api.get(`/api/programs/${fx.program.id}/users`)).json()) as unknown[];
  await api.dispose();
  const total = members.length;
  expect(total).toBeGreaterThanOrEqual(13);

  const { page } = await openProgram(browser, admin.storageState, fx.program);
  await clickProgramMenu(page, fx.program.name, 'Gérer les rôles');
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /^Enseignant · \d+$/ }) });
  await section.getByRole('button', { name: '+ Ajouter' }).click();
  const picker = section.locator('header ul');
  const candidates = picker.getByRole('button');

  // Première page (10), puis une page de plus à chaque arrivée en bas, jusqu'au total.
  await expect(candidates).toHaveCount(10);
  for (let loaded = 10, pageIndex = 1; loaded < total; pageIndex++) {
    const nextPage = page.waitForResponse(
      (res) => res.url().includes('/role-candidates?') && res.url().includes(`page=${pageIndex}`)
    );
    await scrollTo(picker, 'bottom');
    expect((await nextPage).ok()).toBe(true);
    loaded = Math.min(loaded + 10, total);
    await expect(candidates).toHaveCount(loaded);
  }

  // Tous les membres y sont, une seule fois ; le dernier lot incomplet clôt le défilement.
  const shown = await candidates.allTextContents();
  expect(new Set(shown).size).toBe(total);
  for (const email of emails) expect(shown.some((t) => t.includes(email))).toBe(true);
  await scrollTo(picker, 'bottom');
  await expect(candidates).toHaveCount(total);
});

test('journal d’audit : 30 entrées par page, pages suivantes au défilement', async ({
  browser,
  baseURL,
}) => {
  const tag = uniqueSuffix();
  const { api, page, close } = await sessionFor(browser, baseURL!, ROLE_ACCOUNTS.gardien);
  const ids: number[] = [];
  try {
    // 31 établissements créés puis supprimés : 62 entrées portant le marqueur (2 pages pleines + 2).
    for (let i = 1; i <= 31; i++) {
      const res = await api.post('/api/establishments', {
        data: { name: `Journal ${tag} ${nn(i)}`, domainEmail: `j${tag}-${nn(i)}.e2e-test.ca` },
      });
      expect(res.ok(), `création ${i} : HTTP ${res.status()}`).toBe(true);
      ids.push(((await res.json()) as { id: number }).id);
    }
    for (const id of ids) expect((await api.delete(`/api/establishments/${id}`)).ok()).toBe(true);
    ids.length = 0;

    await (await openUserMenu(page)).getByRole('menuitem', { name: 'Journalisation' }).click();
    // La recherche est debouncée : on attend la réponse FILTRÉE (sans curseur) avant de compter,
    // sinon la liste non filtrée (dont les 30 plus récentes sont justement les nôtres) ferait illusion.
    const pageOf = (cursor: boolean) =>
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/audit-logs?') &&
          res.url().includes(`q=${tag}`) &&
          res.url().includes('beforeId') === cursor
      );
    const filtered = pageOf(false);
    await page.getByRole('textbox', { name: 'Rechercher (résumé, auteur, contexte)…' }).fill(tag);
    expect((await filtered).ok()).toBe(true);
    const entries = page.getByRole('listitem').filter({ hasText: tag });
    const list = page.locator('ul').filter({ has: entries.first() });
    await expect(entries).toHaveCount(30);
    // Du plus récent au plus ancien : les suppressions (31 → 02) d'abord.
    await expect(entries.first()).toContainText(`Journal ${tag} 31 » supprimé`);
    await expect(entries.last()).toContainText(`Journal ${tag} 02 » supprimé`);

    let next = pageOf(true);
    await scrollTo(list, 'bottom');
    expect((await next).ok()).toBe(true);
    await expect(entries).toHaveCount(60);
    next = pageOf(true);
    await scrollTo(list, 'bottom');
    expect((await next).ok()).toBe(true);
    await expect(entries).toHaveCount(62);
    await expect(entries.last()).toContainText(`Journal ${tag} 01 » créé`);
    const summaries = await entries.allTextContents();
    expect(new Set(summaries).size, 'aucun doublon').toBe(62);
    // Dernier lot incomplet : plus rien ne se charge.
    await scrollTo(list, 'bottom');
    await expect(entries).toHaveCount(62);
  } finally {
    for (const id of ids) await api.delete(`/api/establishments/${id}`);
    await close();
  }
});
