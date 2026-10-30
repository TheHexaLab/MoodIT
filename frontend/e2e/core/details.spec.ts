import { expect, test, type Locator, type Page } from './fixtures';
import { TEST_PASSWORD } from '../setup/accounts';
import {
  MAIL_DOMAIN,
  createEnrolledUser,
  enterCode,
  mainContent,
  readCodeFromMail,
  uniqueSuffix,
} from './helpers';
import {
  courseSelector,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  freshAccount,
  openHome,
  openUserMenu,
  programButton,
  roleId,
  assignProgramRoleApi,
} from './admin.helpers';
import { pointerDrag } from './quiz.helpers';
import {
  addTrueFalseQuizApi,
  apiFor,
  asGardien,
  countMails,
  courseNav,
  createFixture,
  deleteFixture,
  member,
  openProgram,
  postMessageApi,
  sidebarItem,
  type Fixture,
} from './faults.helpers';

// Derniers trous de couverture : barre Markdown complète, validations des pages de mot de
// passe oublié, longueurs maximales, quiz du jour, réordonnancement des questions, propagation
// temps réel des cours, renvoi du code après le délai serveur, retour en ligne. Tout se passe
// dans un programme / cours de test créés par l'API avec des comptes neufs.

let fx: Fixture;

test.beforeAll(async ({ baseURL }) => {
  fx = await createFixture(baseURL!, 'Det');
});

test.afterAll(async ({ baseURL }) => {
  await deleteFixture(baseURL!, fx);
});

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Mise en forme Markdown' });
const editor = (page: Page) => page.getByRole('textbox', { name: 'Éditeur Markdown' });

/** Clique un outil de la barre puis tape `text` (le curseur est placé par l'outil). */
async function tool(page: Page, name: string, text: string) {
  await toolbar(page).getByRole('button', { name, exact: true }).click();
  await expect(editor(page)).toBeFocused(); // l'outil rend le focus (après un rAF)
  await page.keyboard.type(text);
}

/** Ouvre un menu de la barre (« Titre », « Bloc de code »), choisit `item`, puis tape `text`. */
async function menuTool(page: Page, name: string, item: string, text: string) {
  await toolbar(page).getByRole('button', { name, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(text);
}

/** Nouvelle ligne à la fin du contenu. */
async function newLine(page: Page) {
  await editor(page).press('End');
  await editor(page).press('Enter');
}

/** Vérifie le rendu Markdown (aperçu ou sujet publié) de `markdownBody`. */
async function expectRendered(root: Locator) {
  await expect(root.locator('em', { hasText: /^ital$/ })).toBeVisible();
  await expect(root.locator('code', { hasText: /^inline$/ })).toBeVisible();
  const link = root.getByRole('link', { name: 'lien' });
  await expect(link).toHaveAttribute('href', 'https://exemple.test');
  await expect(root.locator('ul > li', { hasText: /^puce$/ })).toBeVisible();
  await expect(root.locator('ol > li', { hasText: /^num$/ })).toBeVisible();
  await expect(root.locator('blockquote', { hasText: 'cit' })).toBeVisible();
  // Les niveaux Markdown sont décalés d'un cran (le h1 est réservé au titre de la page).
  await expect(root.getByRole('heading', { level: 2, name: 'Grand' })).toBeVisible();
  await expect(root.getByRole('heading', { level: 3, name: 'Section' })).toBeVisible();
  await expect(root.getByRole('heading', { level: 4, name: 'Entete' })).toBeVisible();
  await expect(root.getByRole('heading', { level: 5, name: 'Petit' })).toBeVisible();
  const block = root.locator('[data-role="code-block"]');
  await expect(block.locator('[data-role="code-lang"]')).toHaveText('python');
  await expect(block.locator('pre')).toContainText('print(1)');
}

const MARKDOWN_BODY = [
  '*ital*',
  '`inline`',
  '[lien](https://exemple.test)',
  '- puce',
  '1. num',
  '> cit',
  '# Grand',
  '## Section',
  '### Entete',
  '#### Petit',
  '```python',
  'print(1)',
  '```',
].join('\n');

test('forum : toute la barre Markdown, rendu dans l’aperçu puis une fois publié ; titre limité à 128', async ({
  browser,
  baseURL,
}) => {
  const student = await member(baseURL!, fx);
  const { page } = await openProgram(browser, student.storageState, fx.program);
  await sidebarItem(page, fx.forumName).click();
  const main = mainContent(page);
  const title = `Sujet Markdown ${uniqueSuffix()}`;
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();

  // Titre : 128 caractères au plus (le surplus est ignoré à la saisie).
  const titleBox = page.getByRole('textbox', { name: 'Titre du sujet' });
  await titleBox.fill('t'.repeat(130));
  await expect(titleBox).toHaveValue('t'.repeat(128));
  await titleBox.fill(title);

  // Chaque outil insère sa syntaxe autour du curseur / en tête de ligne.
  await editor(page).click();
  await tool(page, 'Italique', 'ital');
  await expect(editor(page)).toHaveValue('*ital*');
  await newLine(page);
  await tool(page, 'Code en ligne', 'inline');
  await newLine(page);
  await tool(page, 'Lien', 'lien');
  await expect(editor(page)).toHaveValue('*ital*\n`inline`\n[lien](url)');
  // Le « url » de substitution est sélectionné au clavier puis remplacé (seules les adresses
  // http(s), /, # ou mailto sont rendues en lien).
  await editor(page).press('End');
  await editor(page).press('ArrowLeft');
  for (let i = 0; i < 3; i++) await editor(page).press('Shift+ArrowLeft');
  await page.keyboard.type('https://exemple.test');
  await expect(editor(page)).toHaveValue('*ital*\n`inline`\n[lien](https://exemple.test)');
  await newLine(page);
  await tool(page, 'Liste à puces', 'puce');
  await newLine(page);
  await tool(page, 'Liste numérotée', 'num');
  await newLine(page);
  await tool(page, 'Citation', 'cit');
  await newLine(page);
  await menuTool(page, 'Titre', 'Titre', 'Grand');
  await newLine(page);
  await menuTool(page, 'Titre', 'Sous-titre', 'Section');
  await newLine(page);
  await menuTool(page, 'Titre', 'En-tête', 'Entete');
  await newLine(page);
  await menuTool(page, 'Titre', 'Petite en-tête', 'Petit');
  await newLine(page);
  await menuTool(page, 'Bloc de code', 'Python', 'print(1)');
  await expect(editor(page)).toHaveValue(MARKDOWN_BODY);

  // Aperçu : rendu HTML ; la barre est inactive pendant l'aperçu.
  const preview = toolbar(page).getByRole('button', { name: 'Aperçu' });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect(toolbar(page).getByRole('button', { name: 'Gras' })).toBeDisabled();
  await expectRendered(page.locator('[data-role="preview"]'));
  await preview.click();
  await expect(editor(page)).toHaveValue(MARKDOWN_BODY);

  // Publié : même rendu dans la carte du sujet, et persisté (rechargement).
  await page.getByRole('button', { name: 'Publier' }).click();
  const card = main.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expectRendered(card);
  await page.reload();
  await programButton(page, fx.program.name).click();
  await sidebarItem(page, fx.forumName).click();
  await expectRendered(card);
});

test('mot de passe oublié : validations, réinitialisation et longueur maximale', async ({
  page,
  baseURL,
}) => {
  const { user } = await createEnrolledUser(baseURL!, MAIL_DOMAIN);
  const newPassword = 'Nouv3au-Passw0rd!';

  await page.goto('/forgot-password');
  const send = page.getByRole('button', { name: 'Envoyer le code →' });
  await send.click();
  await expect(page.getByText('L’adresse e-mail est requise')).toBeVisible();
  // « a@b » passe la validation native du navigateur mais pas celle de la page.
  await page.getByPlaceholder('exemple@usherbrooke.ca').fill('a@b');
  await send.click();
  await expect(page.getByText('Format d’e-mail invalide')).toBeVisible();
  await page.getByPlaceholder('exemple@usherbrooke.ca').fill(user.email);
  await send.click();
  await expect(page.getByRole('heading', { name: 'Réinitialiser le mot de passe' })).toBeVisible();

  // Code absent, mot de passe faible, confirmation différente : refusés côté client.
  const reset = page.getByRole('button', { name: 'Réinitialiser →' });
  const passwords = page.getByPlaceholder('••••••••••');
  await reset.click();
  await expect(page.getByText('⚠ Le code doit contenir 6 chiffres')).toBeVisible();
  await enterCode(page, await readCodeFromMail(user.email, 'Réinitialisation du mot de passe'));
  await passwords.nth(0).fill('abc');
  await reset.click();
  await expect(page.getByText('⚠ Mot de passe trop faible')).toBeVisible();
  // 128 caractères au plus.
  await passwords.nth(0).fill('a'.repeat(130));
  await expect(passwords.nth(0)).toHaveValue('a'.repeat(128));
  await passwords.nth(0).fill(newPassword);
  await passwords.nth(1).fill(`${newPassword}x`);
  await reset.click();
  await expect(page.getByText('⚠ Les mots de passe ne correspondent pas')).toBeVisible();

  await passwords.nth(1).fill(newPassword);
  await reset.click();
  await expect(page.getByRole('heading', { name: 'Mot de passe réinitialisé ✅' })).toBeVisible();
  await page.getByRole('link', { name: 'Se connecter →' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Le nouveau mot de passe est bien celui du compte.
  const old = await page.request.post('/auth/login', { data: { email: user.email, password: TEST_PASSWORD } });
  expect(old.ok()).toBe(false);
  const fresh = await page.request.post('/auth/login', { data: { email: user.email, password: newPassword } });
  expect(fresh.ok()).toBe(true);
});

test('profil : prénom et nom limités à 128 caractères', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!, undefined, { enroll: false });
  const { page } = await openHome(browser, storageState);
  await (await openUserMenu(page)).getByRole('menuitem', { name: 'Modifier le profil' }).click();
  for (const field of ['Prénom', 'Nom']) {
    const box = page.getByRole('textbox', { name: field, exact: true });
    await box.fill('x'.repeat(130));
    await expect(box).toHaveValue('x'.repeat(128));
  }
  await page.getByRole('button', { name: 'Annuler' }).click();
});

/** Ligne d'un quiz dans la liste de l'éditeur. */
const quizRow = (page: Page, title: string) => page.locator('[data-reorder-id]').filter({ hasText: title });
/** Éclair « quiz du jour » d'une ligne (tracé de l'icône) : plein (`currentColor`) si actif, vide sinon. */
const bolt = (row: Locator, on: boolean) =>
  row.locator(`svg[fill="${on ? 'currentColor' : 'none'}"]:has(path[d^="M13 2"])`);

async function openQuizEditor(page: Page) {
  await courseNav(page).getByRole('button', { name: 'Modifier la section QUIZ' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
}

test('quiz du jour : éclair dans l’éditeur, en-tête « Quiz du jour » chez l’étudiant', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const api = await apiFor(baseURL!, teacher.storageState);
  const daily = `Quotidien ${uniqueSuffix()}`;
  const regular = `Ordinaire ${uniqueSuffix()}`;
  const dailyId = await addTrueFalseQuizApi(api, fx.course.id, daily, { isDaily: true });
  const regularId = await addTrueFalseQuizApi(api, fx.course.id, regular);

  try {
    const { page } = await openProgram(browser, teacher.storageState, fx.program);
    await openQuizEditor(page);
    await expect(bolt(quizRow(page, daily), true)).toHaveCount(1);
    await expect(bolt(quizRow(page, regular), false)).toHaveCount(1);

    // L'interrupteur du formulaire reflète l'état, et le bascule : l'ordinaire devient quotidien.
    await quizRow(page, regular).click();
    await page.getByRole('button', { name: `Modifier ${regular}`, exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Quiz du jour' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    // Enregistré : retour à la liste des quiz (#201).
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
    await expect(bolt(quizRow(page, regular), true)).toHaveCount(1);
    await page.getByRole('button', { name: 'Fermer' }).click();

    // Étudiant : l'en-tête remplace le titre par « Quiz du jour » pour les deux.
    const student = await member(baseURL!, fx);
    const s = await openProgram(browser, student.storageState, fx.program);
    const header = mainContent(s.page).locator('header').first();
    await sidebarItem(s.page, daily).click();
    await expect(header).toContainText('Quiz du jour');
    await expect(header).not.toContainText(daily);
    await sidebarItem(s.page, regular).click();
    await expect(header).toContainText('Quiz du jour');
  } finally {
    await api.delete(`/api/quizzes/${dailyId}`);
    await api.delete(`/api/quizzes/${regularId}`);
    await api.dispose();
  }
});

test('réordonner les questions d’un quiz par la poignée, persisté et vu par l’étudiant', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const api = await apiFor(baseURL!, teacher.storageState);
  const title = `Ordre questions ${uniqueSuffix()}`;
  const quizId = await addTrueFalseQuizApi(api, fx.course.id, title, {
    prompts: ['Première question', 'Seconde question'],
  });

  try {
    const { page } = await openProgram(browser, teacher.storageState, fx.program);
    await openQuizEditor(page);
    await quizRow(page, title).click();
    await page.getByRole('button', { name: `Modifier ${title}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
    const rows = page.locator('[data-reorder-id]');
    await expect(rows).toHaveText([/Première question/, /Seconde question/]);

    // La poignée (span aria-hidden, Pointer Events) est le premier enfant de la ligne.
    await pointerDrag(page, rows.nth(1).locator('> span').first(), rows.nth(0));
    await expect(rows).toHaveText([/Seconde question/, /Première question/]);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible(); // enregistré (#201)

    // Persisté : l'ordre (orderIndex) côté serveur, et la question 1 de l'étudiant.
    const edit = (await (await api.get(`/api/quizzes/${quizId}/edit`)).json()) as {
      questions: { prompt: string; orderIndex: number }[];
    };
    const prompts = [...edit.questions].sort((a, b) => a.orderIndex - b.orderIndex).map((q) => q.prompt);
    expect(prompts).toEqual(['Seconde question', 'Première question']);

    const student = await member(baseURL!, fx);
    const s = await openProgram(browser, student.storageState, fx.program);
    await sidebarItem(s.page, title).click();
    await expect(mainContent(s.page)).toContainText('Question 1 sur 2');
    await expect(mainContent(s.page)).toContainText('Seconde question');
  } finally {
    await api.delete(`/api/quizzes/${quizId}`);
    await api.dispose();
  }
});

test('quiz:reordered : l’étudiant voit le nouvel ordre des quiz sans recharger', async ({
  browser,
  baseURL,
}) => {
  const teacher = await member(baseURL!, fx, 'Enseignant');
  const api = await apiFor(baseURL!, teacher.storageState);
  const first = `Ordre A ${uniqueSuffix()}`;
  const second = `Ordre B ${uniqueSuffix()}`;
  const ids = [
    await addTrueFalseQuizApi(api, fx.course.id, first),
    await addTrueFalseQuizApi(api, fx.course.id, second),
  ];

  try {
    const student = await member(baseURL!, fx);
    const s = await openProgram(browser, student.storageState, fx.program);
    const quizButtons = courseNav(s.page).getByRole('region', { name: 'QUIZ' }).getByRole('button');
    const order = async () => {
      const names = await quizButtons.allInnerTexts();
      return [names.findIndex((n) => n.includes(first)), names.findIndex((n) => n.includes(second))];
    };
    await expect(sidebarItem(s.page, second)).toBeVisible();
    const [a, b] = await order();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(b);

    const { page } = await openProgram(browser, teacher.storageState, fx.program);
    await openQuizEditor(page);
    await pointerDrag(page, quizRow(page, second).locator('> span').first(), quizRow(page, first));
    // WS quiz:reordered : la barre latérale de l'étudiant se réordonne.
    await expect.poll(order).toEqual([b, a]);
    await s.page.reload();
    await programButton(s.page, fx.program.name).click();
    await expect(sidebarItem(s.page, second)).toBeVisible();
    await expect.poll(order).toEqual([b, a]);
  } finally {
    for (const id of ids) await api.delete(`/api/quizzes/${id}`);
    await api.dispose();
  }
});

/** Compte neuf promu administrateur global (seul à pouvoir rattacher un cours à d'autres programmes). */
async function globalAdmin(baseURL: string) {
  const account = await freshAccount(baseURL);
  const role = await asGardien(baseURL, async (api) => {
    const id = await roleId(api, 'Administrateur', 'global');
    const res = await api.post('/api/roles/global/change', {
      data: { type: 'assign', roleId: id, userId: account.user.id },
    });
    expect(res.ok()).toBe(true);
    return id;
  });
  return {
    ...account,
    demote: () =>
      asGardien(baseURL, async (api) => {
        await api.post('/api/roles/global/change', {
          data: { type: 'unassign', roleId: role, userId: account.user.id },
        });
      }),
  };
}

/** Ids des cours rattachés à un programme (API). */
async function coursesOf(baseURL: string, programId: number): Promise<number[]> {
  return asGardien(baseURL, async (api) => {
    const data = (await (await api.get(`/api/programs/${programId}/courses`)).json()) as {
      courses: { id: number }[];
    };
    return data.courses.map((c) => c.id);
  });
}

// Garde (core-service) : PATCH /api/courses/{id} doit persister `programIds` (autrefois appliqué
// sur `Course.programs`, côté INVERSE de la relation, donc ignoré). Attendu : le cours apparaît
// dans les cours du second programme.
test('« Modifier le cours » : rattacher le cours à un second programme', async ({ browser, baseURL }) => {
  const other = await asGardien(baseURL!, (api) => createProgramApi(api, 'Det2'));
  const admin = await globalAdmin(baseURL!);
  await enrollApi(admin.api, fx.program.id, [fx.course.id]);
  await enrollApi(admin.api, other.id);
  await admin.api.dispose();

  try {
    const { page } = await openProgram(browser, admin.storageState, fx.program);
    await courseSelector(page, fx.course.code).click();
    await page.getByRole('listbox').getByRole('button', { name: `Modifier le cours ${fx.course.code}` }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Retirer ${fx.program.name}` }).first()).toBeVisible();
    // Ouvrir le sélecteur : clic dans la zone des puces, à droite d'elles. Seule la croix d'une
    // puce est un bouton « Retirer » : zone = grand-parent (croix → puce → zone).
    const tags = page.getByRole('button', { name: `Retirer ${fx.program.name}` }).first().locator('xpath=../..');
    const box = (await tags.boundingBox())!;
    await tags.click({ position: { x: box.width - 8, y: box.height / 2 } });
    await page.getByPlaceholder('Rechercher un programme…').fill(other.name);
    await page.getByRole('button', { name: new RegExp(`${other.code} ${other.name}`) }).click();
    await expect(page.getByRole('button', { name: `Retirer ${other.name}` }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toHaveCount(0);

    // Persisté : le cours est maintenant dans les deux programmes.
    await expect.poll(() => coursesOf(baseURL!, other.id), { timeout: 5_000 }).toContain(fx.course.id);
    expect(await coursesOf(baseURL!, fx.program.id)).toContain(fx.course.id);
  } finally {
    await asGardien(baseURL!, async (api) => {
      // Remet le cours dans son seul programme d'origine, puis supprime le programme jetable.
      await api.patch(`/api/courses/${fx.course.id}`, { data: { programIds: [fx.program.id] } });
      await deleteProgramApi(api, other.id);
    });
    await admin.demote();
  }
});

// Garde (frontend) : UpdateCoursePopup ne recevait que `programIds: [activeProgramId]`
// (Dashboard.tsx). Un cours rattaché à deux programmes, ouvert depuis l'un d'eux, doit afficher
// les deux (le popup charge les programmes rattachés via loadProgramIds).
test('« Modifier le cours » : les programmes rattachés sont pré-remplis', async ({ browser, baseURL }) => {
  const other = await asGardien(baseURL!, (api) => createProgramApi(api, 'Det3'));
  // Cours créé d'emblée dans les deux programmes (POST /api/programs/courses, qui rattache bien).
  const course = await asGardien(baseURL!, (api) => createCourseApi(api, [fx.program.id, other.id], 'D3'));
  const admin = await globalAdmin(baseURL!);
  await enrollApi(admin.api, fx.program.id, [fx.course.id, course.id]);
  await enrollApi(admin.api, other.id);
  await admin.api.dispose();

  try {
    expect(await coursesOf(baseURL!, other.id)).toContain(course.id);
    const { page } = await openProgram(browser, admin.storageState, fx.program);
    await courseSelector(page, fx.course.code).click();
    await page.getByRole('option', { name: new RegExp(`^${course.code} `) }).click();
    await courseSelector(page, course.code).click();
    await page.getByRole('listbox').getByRole('button', { name: `Modifier le cours ${course.code}` }).click();
    await expect(page.getByRole('button', { name: `Retirer ${fx.program.name}` }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: `Retirer ${other.name}` }).first()).toBeVisible({
      timeout: 3_000,
    });
  } finally {
    await asGardien(baseURL!, async (api) => {
      await deleteCourseApi(api, course.id);
      await deleteProgramApi(api, other.id);
    });
    await admin.demote();
  }
});

test('course:edited / course:deleted : un second inscrit voit la modification puis la disparition', async ({
  browser,
  baseURL,
}) => {
  // Cours jetable du programme de test ; enseignant et étudiant neufs inscrits aux deux cours.
  const course = await asGardien(baseURL!, (api) => createCourseApi(api, [fx.program.id], 'CE'));
  const [teacher, student] = await Promise.all([freshAccount(baseURL!), freshAccount(baseURL!)]);
  for (const account of [teacher, student]) {
    await enrollApi(account.api, fx.program.id, [fx.course.id, course.id]);
    await account.api.dispose();
  }
  await asGardien(baseURL!, (api) => assignProgramRoleApi(api, fx.program.id, teacher.user.id, 'Enseignant'));
  const newCode = `${course.code}X`;
  const newTitle = `${course.title} (édité)`;

  try {
    // L'étudiant ouvre le cours jetable.
    const s = await openProgram(browser, student.storageState, fx.program);
    await courseSelector(s.page, fx.course.code).click();
    await s.page.getByRole('option', { name: new RegExp(`^${course.code} `) }).click();
    await expect(courseSelector(s.page, course.code)).toBeVisible();

    const { page } = await openProgram(browser, teacher.storageState, fx.program);
    await courseSelector(page, fx.course.code).click();
    await page.getByRole('option', { name: new RegExp(`^${course.code} `) }).click();
    await courseSelector(page, course.code).click();
    await page.getByRole('listbox').getByRole('button', { name: `Modifier le cours ${course.code}` }).click();
    await page.getByRole('textbox', { name: 'Code du cours' }).fill(newCode);
    await page.getByRole('textbox', { name: 'Titre du cours' }).fill(newTitle);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(courseSelector(page, newCode)).toBeVisible();

    // WS course:edited : le sélecteur de l'étudiant change de code et l'option porte le titre.
    await expect(courseSelector(s.page, newCode)).toBeVisible();
    await courseSelector(s.page, newCode).click();
    await expect(s.page.getByRole('option', { name: `${newCode} ${newTitle}` })).toBeVisible();
    await s.page.keyboard.press('Escape');

    // WS course:deleted : le cours quitte le sélecteur de l'étudiant, qui retombe sur l'autre.
    await courseSelector(page, newCode).click({ button: 'right' });
    await page.getByRole('menu', { name: `Actions du cours ${newCode}` }).getByRole('menuitem', { name: 'Supprimer le cours' }).click();
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(courseSelector(page, fx.course.code)).toBeVisible();
    await expect(courseSelector(s.page, fx.course.code)).toBeVisible();
    await courseSelector(s.page, fx.course.code).click();
    await expect(s.page.getByRole('option', { name: new RegExp(`^${newCode} `) })).toHaveCount(0);
    await expect(s.page.getByRole('option', { name: new RegExp(`^${fx.course.code} `) })).toBeVisible();
  } finally {
    await asGardien(baseURL!, (api) => deleteCourseApi(api, course.id));
  }
});

test('« Renvoyer » sur /reset-password : un second courriel après le délai serveur de 60 s', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { user } = await createEnrolledUser(baseURL!, MAIL_DOMAIN);
  const subject = 'Réinitialisation du mot de passe';

  await page.goto('/forgot-password');
  await page.getByPlaceholder('exemple@usherbrooke.ca').fill(user.email);
  await page.getByRole('button', { name: 'Envoyer le code →' }).click();
  await expect(page.getByRole('heading', { name: 'Réinitialiser le mot de passe' })).toBeVisible();
  await expect.poll(() => countMails(user.email, subject), { timeout: 15_000 }).toBe(1);

  // Renvoi immédiat : message générique (anti-énumération) et compte à rebours de 60 s ; le
  // serveur, lui, n'envoie rien avant la fin de SON délai (compté depuis le premier envoi).
  const resend = page.getByRole('button', { name: /^Renvoyer/ });
  await resend.click();
  await expect(page.getByText('Si un compte existe, un nouveau code a été envoyé.')).toBeVisible();
  await expect(resend).toHaveText(/^Renvoyer \(\d+s\)$/);
  await expect(resend).toBeDisabled();

  await expect.poll(() => resend.textContent(), { timeout: 75_000, intervals: [1_000] }).toBe('Renvoyer');
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(page.getByText('Si un compte existe, un nouveau code a été envoyé.')).toBeVisible();
  // Exactement deux courriels : le premier renvoi (trop tôt) n'en a pas produit.
  await expect.poll(() => countMails(user.email, subject), { timeout: 15_000 }).toBe(2);
  const code = await readCodeFromMail(user.email, subject);
  expect(code).toMatch(/^\d{6}$/);
});

test('retour en ligne : un message envoyé pendant la coupure apparaît ensuite', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const reader = await member(baseURL!, fx);
  const author = await member(baseURL!, fx);
  const { context, page } = await openProgram(browser, reader.storageState, fx.program);
  await sidebarItem(page, fx.channelName).click();
  const main = mainContent(page);
  const composer = main.getByRole('textbox', { name: `Envoyer un message dans ${fx.channelName}` });
  await expect(composer).toBeVisible();
  const offlineText = `Pendant la coupure ${uniqueSuffix()}`;
  const backText = `De retour ${uniqueSuffix()}`;

  await context.setOffline(true);
  const api = await apiFor(baseURL!, author.storageState);
  await postMessageApi(api, fx.channelId, offlineText);
  await api.dispose();
  // Seul Chromium coupe aussi la WebSocket déjà ouverte en mode hors ligne (Firefox et WebKit
  // la laissent passer) : la vérification « rien n'arrive pendant la coupure » n'a de sens que là.
  if (browserName === 'chromium') await expect(main.getByText(offlineText)).toHaveCount(0);

  // Reconnexion : le message manqué arrive, et le canal est de nouveau utilisable.
  await context.setOffline(false);
  await expect(main.getByText(offlineText)).toBeVisible({ timeout: 45_000 });
  await composer.fill(backText);
  await composer.press('Enter');
  await expect(main.getByText(backText)).toBeVisible();
  // L'envoi est optimiste : le message s'affiche AVANT la réponse du POST. On attend donc qu'il
  // soit persisté (sinon la lecture peut précéder l'écriture et le test échoue par instants).
  const check = await apiFor(baseURL!, author.storageState);
  await expect
    .poll(
      async () => {
        const res = await check.get(`/api/forums/${fx.channelId}/messages?limit=5`);
        return ((await res.json()) as { content: string }[]).map((m) => m.content);
      },
      { message: 'message envoyé après la reconnexion persisté', timeout: 15_000 }
    )
    .toContain(backText);
  await check.dispose();
});
