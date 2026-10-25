import { expect, test, type Page } from './fixtures';
import { PROGRAM_NAME, ROLE_ACCOUNTS, createEnrolledUser, sessionAs } from './helpers';

// Feedback de cours (MCP) sur le cours de test MAT115. Pas de clé LLM dans la pile E2E :
// mcp-service produit une analyse de repli déterministe. Les analyses s'empilent dans
// l'historique d'un run à l'autre : on vérifie la NOUVELLE ligne, pas un historique vide.
const COURSE_CODE = 'MAT115';

/** Clic droit sur le sélecteur de cours → menu contextuel « Actions du cours … ». */
async function openCourseContextMenu(page: Page) {
  await page.goto('/home');
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  await page
    .getByRole('navigation', { name: 'Cours' })
    .getByRole('button', { name: COURSE_CODE, exact: true })
    .click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `Actions du cours ${COURSE_CODE}` });
  await expect(menu).toBeVisible();
  return menu;
}

/** Lignes de l'historique (nom accessible = date + « n forces · m points à améliorer »). */
const historyRows = (page: Page) =>
  page.getByRole('button', { name: /\d+ forces? · \d+ points? à améliorer$/ });

test('enseignant : lancer une analyse MCP et consulter le bilan', async ({ browser, baseURL }) => {
  const { storageState } = await sessionAs(baseURL!, ROLE_ACCOUNTS.prof);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  const menu = await openCourseContextMenu(page);
  await menu.getByRole('menuitem', { name: 'Feedback du cours' }).click();
  await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toBeVisible();
  await expect(page.getByText(`Feedback · ${COURSE_CODE}`)).toBeVisible();
  await expect(page.getByText('HISTORIQUE DES ANALYSES')).toBeVisible();
  await expect(page.getByText('Chargement des analyses…')).toBeHidden();
  const before = await historyRows(page).count();

  // Lancement asynchrone (POST 202) : la fin du job est poussée par WebSocket et ajoute la
  // nouvelle analyse EN TÊTE de l'historique. La progression (role=status) est trop brève
  // avec le repli déterministe pour être observée de façon fiable.
  await page.getByRole('button', { name: 'Analyser' }).click();
  await expect(historyRows(page)).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Analyser' })).toBeEnabled();

  const newest = historyRows(page).first();
  // Le résumé est dans son propre élément (la date le précède sans séparateur dans le texte).
  const summary = await newest.getByText(/^\d+ forces? · \d+ points? à améliorer$/).textContent();
  const [, strengths, improvements] = summary!.match(/^(\d+) forces? · (\d+) points?/)!;
  await newest.click();

  // Détail : en-tête, bilan global, synthèse, 4 dimensions, onglets, sources.
  await expect(page.getByRole('heading', { name: 'Bilan MCP' })).toBeVisible();
  await expect(page.getByText('Chargement de l’analyse…')).toBeHidden();
  const detail = page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Bilan MCP' }) })
    .filter({ has: page.getByRole('tablist') })
    .last();
  await expect(detail.getByText('Bilan global du cours')).toBeVisible();
  await expect(detail.getByText(/^\d+ %$/)).toBeVisible();
  await expect(detail.getByText('SYNTHÈSE')).toBeVisible();
  await expect(detail.getByText('RÉPARTITION PAR DIMENSION')).toBeVisible();
  for (const dimension of ['Contenu', 'Engagement', 'Réussite', 'Ressenti']) {
    await expect(detail.getByText(dimension, { exact: true })).toBeVisible();
  }
  await expect(
    detail.getByText(/^Sources : \d+ quiz, \d+ messages, \d+ étudiants\.$/)
  ).toBeVisible();

  // Onglets : chacun liste ses points ; les compteurs concordent avec la ligne d'historique.
  const points = detail.getByRole('listitem');
  const strengthsTab = detail.getByRole('tab', { name: 'Points forts' });
  const improvementsTab = detail.getByRole('tab', { name: 'À améliorer' });
  await expect(strengthsTab).toHaveAttribute('aria-selected', 'true');
  await expect(points).toHaveCount(Number(strengths));

  await improvementsTab.click();
  await expect(improvementsTab).toHaveAttribute('aria-selected', 'true');
  await expect(strengthsTab).toHaveAttribute('aria-selected', 'false');
  await expect(points).toHaveCount(Number(improvements));

  const recommendationsTab = detail.getByRole('tab', { name: 'Recommandations' });
  await recommendationsTab.click();
  await expect(recommendationsTab).toHaveAttribute('aria-selected', 'true');
  await expect(points.first()).toBeVisible();

  // « Retour » ramène à l'historique.
  await page.getByRole('button', { name: 'Retour' }).click();
  await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toBeVisible();
  await expect(historyRows(page)).toHaveCount(before + 1);

  await context.close();
});

test('étudiant : pas d’accès au feedback du cours', async ({ browser, baseURL }) => {
  // Compte neuf (et non alice) : une reconnexion d'un compte partagé révoque sa session.
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();

  const menu = await openCourseContextMenu(page);
  // Seule l'action ouverte à tous reste ; on referme sans la déclencher.
  await expect(menu.getByRole('menuitem')).toHaveText(['Quitter le cours']);
  await expect(menu.getByRole('menuitem', { name: 'Feedback du cours' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await context.close();
});
