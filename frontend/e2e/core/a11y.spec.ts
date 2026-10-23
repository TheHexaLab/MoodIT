import { expect, test, type Page } from './fixtures';
import { TEST_COURSE_ID, TEST_PASSWORD, TEST_PROGRAM_ID } from '../setup/accounts';
import {
  FORUM_NAME,
  PROGRAM_NAME,
  createEnrolledUser,
  mainContent,
  newUser,
  uniqueSuffix,
} from './helpers';
import {
  SEED_ESTABLISHMENT,
  clickCourseMenu,
  clickProgramMenu,
  confirmationPopup,
  enrollApi,
  escapeRegExp,
  freshAccount,
  openHome,
  openUserMenu,
  programButton,
} from './admin.helpers';
import {
  SIX_TYPES,
  THEMES,
  auditScreen,
  createGuardianAccount,
  createProgramFixture,
  createSixTypeQuiz,
  enrolledStudent,
  expectTheme,
  seedTheme,
  setThemeInDb,
  type ProgramFixture,
} from './a11y.helpers';

// Audit axe-core (WCAG 2.0/2.1 A et AA) de chaque écran et popup, en thème clair ET sombre.
// Chaque écran est audité par une assertion douce : un écran fautif n'empêche pas l'audit des
// suivants, et toutes les violations sont tracées (`A11Y|…`) pour l'inventaire. Les violations
// « serious » / « critical » connues font échouer ces tests : ils sont marqués `test.fail` avec la
// liste des règles en cause, à retirer quand l'application sera corrigée.

const CHANNEL_NAME = 'Discussion — Mathématiques pour ingénieurs I';

/** Fixture partagée : programme + cours neufs, Administrateur neuf, quiz aux 6 types. */
let fixture: ProgramFixture;
let quizTitle: string;

test.beforeAll(async ({ baseURL }) => {
  fixture = await createProgramFixture(baseURL!);
  quizTitle = `Quiz a11y ${uniqueSuffix()}`;
  await createSixTypeQuiz(fixture.admin.api, fixture.course.id, quizTitle);
});

test.afterAll(async () => {
  await fixture?.cleanup();
});

/** Publie un sujet dans le forum ouvert et y répond (la réponse à son propre sujet est permise). */
async function publishThreadWithReply(page: Page, title: string) {
  await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
  await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
  await page.getByRole('textbox', { name: 'Éditeur Markdown' }).fill(`Corps **gras** de ${title}`);
  await page.getByRole('button', { name: 'Publier' }).click();
  const card = mainContent(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Répondre', exact: true }).first().click();
  const composer = card.getByRole('textbox', { name: 'Éditeur Markdown' });
  await composer.fill(`Réponse à ${title}`);
  await composer.press('Control+Enter');
  await expect(card.getByText(`Réponse à ${title}`, { exact: true })).toBeVisible();
}

for (const theme of THEMES) {
  test(`pages d’authentification (${theme})`, async ({ browser, baseURL }) => {
    test.fail(
      true,
      '#109 a11y : button-name (.eye-btn du login, .light-dark-btn sur login/forgot/reset/verify) + color-contrast en clair (liens teal, sous-titres, pied de page)'
    );
    const { user } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext();
    await seedTheme(context, theme);
    const page = await context.newPage();

    await page.goto('/login');
    await expectTheme(page, theme);
    await auditScreen(page, '/login', theme);

    await page.goto('/register');
    await auditScreen(page, '/register', theme);

    await page.goto('/forgot-password');
    await auditScreen(page, '/forgot-password', theme);
    // /reset-password n'est accessible qu'après « mot de passe oublié » (état de navigation).
    await page.getByPlaceholder('exemple@usherbrooke.ca').fill(newUser().email);
    await page.getByRole('button', { name: 'Envoyer le code →' }).click();
    await expect(page.getByRole('heading', { name: 'Réinitialiser le mot de passe' })).toBeVisible();
    await auditScreen(page, '/reset-password', theme);

    // /verify-code en mode 2FA, après un login réel.
    await page.goto('/login');
    await page.getByPlaceholder('exemple@gmail.com').fill(user.email);
    await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter →' }).click();
    await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
    await auditScreen(page, '/verify-code (2FA)', theme);

    await context.close();
  });

  test(`accueil, canal, forum, menu du compte et popups de l’étudiant (${theme})`, async ({
    browser,
    baseURL,
  }) => {
    test.fail(
      true,
      '#109 a11y : aria-roles (rôles inventés du canal et du forum), aria-required-attr (separator sans aria-valuenow), aria-prohibited-attr (aria-label sur div .appIcon), label-content-name-mismatch (pastille programme, bouton compte), aria-required-children (menu du compte), list (canal), scrollable-region-focusable (blocs de code), color-contrast'
    );
    // Compte neuf sans abonnement : accueil vide d'abord, puis abonné au programme de test.
    const student = await freshAccount(baseURL!);
    await setThemeInDb(baseURL!, student.storageState, theme);
    const { context, page } = await openHome(browser, student.storageState);
    const main = mainContent(page);
    await expect(main.getByRole('heading', { name: 'Bienvenue sur MoodIT' })).toBeVisible();
    await expectTheme(page, theme);
    await auditScreen(page, 'accueil vide (Bienvenue)', theme);

    // « Ajouter un programme » : choix, puis les deux étapes de « Rejoindre un programme ».
    await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ajouter un programme' })).toBeVisible();
    await auditScreen(page, 'popup Ajouter un programme', theme);
    await page.getByRole('button', { name: /^↪ Rejoindre un programme/ }).click();
    await expect(page.getByPlaceholder('Rechercher un établissement…')).toBeVisible();
    await auditScreen(page, 'popup Rejoindre un programme : établissements', theme);
    await page
      .getByRole('button', { name: new RegExp(`^${escapeRegExp(SEED_ESTABLISHMENT)} `) })
      .click();
    await expect(page.getByPlaceholder('Rechercher un programme…')).toBeVisible();
    await auditScreen(page, 'popup Rejoindre un programme : programmes', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByPlaceholder('Rechercher un programme…')).toHaveCount(0);

    // Abonnement par l'API (le parcours UI est couvert par subscription.spec.ts).
    await enrollApi(student.api, TEST_PROGRAM_ID, [TEST_COURSE_ID]);
    await student.api.dispose();
    await page.reload();
    await programButton(page, PROGRAM_NAME).click();
    await expect(main.getByRole('heading', { name: 'Aucun canal sélectionné' })).toBeVisible();
    await auditScreen(page, 'accueil avec programme', theme);

    await clickProgramMenu(page, PROGRAM_NAME, 'Rejoindre des cours');
    await expect(page.getByRole('heading', { name: 'Rejoindre des cours' })).toBeVisible();
    await auditScreen(page, 'popup Rejoindre des cours', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Rejoindre des cours' })).toHaveCount(0);

    await page.getByRole('button', { name: CHANNEL_NAME }).click();
    await expect(
      main.getByRole('textbox', { name: `Envoyer un message dans ${CHANNEL_NAME}` })
    ).toBeVisible();
    await auditScreen(page, 'canal', theme);

    await page.getByRole('button', { name: FORUM_NAME }).click();
    await expect(main.getByRole('button', { name: '+ Nouveau sujet' })).toBeVisible();
    await publishThreadWithReply(page, `Sujet a11y ${theme} ${uniqueSuffix()}`);
    await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
    await expect(page.getByRole('heading', { name: 'Nouveau post' })).toBeVisible();
    await auditScreen(page, 'forum (sujet, réponse, composeur ouvert)', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();

    await openUserMenu(page);
    await auditScreen(page, 'menu du compte', theme);
    await page.getByRole('menuitem', { name: 'Modifier le profil' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeVisible();
    await auditScreen(page, 'popup Modifier le profil', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeHidden();

    // Confirmation, puis ErrorPopup provoquée par une panne injectée sur le DELETE.
    await clickCourseMenu(page, 'MAT115', 'Quitter le cours');
    await expect(page.getByRole('heading', { name: 'Quitter le cours ?' })).toBeVisible();
    await auditScreen(page, 'popup de confirmation (Quitter le cours ?)', theme);
    await page.route('**/api/courses/*/users/*', (route) => route.fulfill({ status: 500 }));
    await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    await expect(page.getByText('Impossible de quitter le cours. Réessaie.')).toBeVisible();
    await auditScreen(page, 'ErrorPopup', theme);
    await page.getByRole('button', { name: 'Fermer' }).click();
    await expect(page.getByText('Impossible de quitter le cours. Réessaie.')).toBeHidden();
    await page.unroute('**/api/courses/*/users/*');
    // Le cours est toujours suivi (l'échec n'a rien changé).
    await expect(
      page.getByRole('navigation', { name: 'Cours' }).getByRole('button', { name: 'MAT115' })
    ).toBeVisible();

    await context.close();
  });

  test(`quiz de l’étudiant : chaque type de question, résumé et revue (${theme})`, async ({
    browser,
    baseURL,
  }) => {
    test.fail(
      true,
      '#109 a11y : aria-roles (div role=markdown-container), aria-required-attr (separator), aria-prohibited-attr (.appIcon), label-content-name-mismatch, color-contrast (barème, badge, libellés)'
    );
    const student = await enrolledStudent(baseURL!, fixture);
    await setThemeInDb(baseURL!, student.storageState, theme);
    await student.api.dispose();
    const { context, page } = await openHome(browser, student.storageState);
    const main = mainContent(page);
    await programButton(page, fixture.program.name).click();
    await page.getByRole('button', { name: quizTitle }).click();
    await expect(main).toContainText('Question 1 sur 6');
    await expectTheme(page, theme);

    for (const [i, [type, prompt]] of SIX_TYPES.entries()) {
      // L'énoncé est rendu en Markdown : les accents graves du code en ligne disparaissent.
      await expect(main).toContainText(prompt.replace(/`/g, ''));
      await auditScreen(page, `quiz : question ${type}`, theme);
      if (i < SIX_TYPES.length - 1) await main.getByRole('button', { name: 'Suivant' }).click();
    }

    // Soumission (202) puis correction asynchrone (Piston pour la question de code).
    await main.getByRole('button', { name: 'Soumettre' }).click();
    await expect(main.getByRole('heading', { name: `${quizTitle} — terminé !` })).toBeVisible({
      timeout: 60_000,
    });
    await auditScreen(page, 'quiz : résumé', theme);
    await main.getByRole('button', { name: 'Revoir mes réponses' }).click();
    await expect(main.getByRole('button', { name: 'Retour au résumé' })).toBeVisible();
    await auditScreen(page, 'quiz : revue des réponses', theme);

    await context.close();
  });

  test(`popups d’édition : sections, éditeur de quiz, cours, programme, rôles, MCP (${theme})`, async ({
    browser,
    baseURL,
  }) => {
    test.fail(
      true,
      '#109 a11y : label (champ de nom des sections, réponses Vrai/Faux, poids du harnais), button-name (poubelle des rôles), nested-interactive (puce de programme de « Modifier le cours »), aria-roles (barre Markdown), aria-required-attr, aria-prohibited-attr, label-content-name-mismatch, color-contrast'
    );
    await setThemeInDb(baseURL!, fixture.admin.storageState, theme);
    const { context, page } = await openHome(browser, fixture.admin.storageState);
    const nav = page.getByRole('navigation', { name: 'Cours' });
    await programButton(page, fixture.program.name).click();
    await expect(nav.getByRole('button', { name: fixture.course.code, exact: true })).toBeVisible();
    await expectTheme(page, theme);

    // Sections (canaux) : liste puis formulaire d'ajout ; fermeture par « ✕ » (sans nom accessible).
    await nav.getByRole('button', { name: 'Modifier la section CANAUX' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toBeVisible();
    await auditScreen(page, 'popup Modifier les canaux', theme);
    await page.getByRole('button', { name: '+ Ajouter un canal' }).click();
    await expect(page.getByRole('heading', { name: 'Nouveau canal' })).toBeVisible();
    await auditScreen(page, 'popup Modifier les canaux : ajout', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await page.getByRole('button', { name: '✕' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les canaux' })).toHaveCount(0);

    // Éditeur de quiz : liste, formulaire, une question de chaque type, harnais, test, confirmation.
    await nav.getByRole('button', { name: 'Modifier la section QUIZ' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
    await auditScreen(page, 'éditeur de quiz : liste', theme);
    await page.locator('[data-reorder-id]').filter({ hasText: quizTitle }).click();
    await page.getByRole('button', { name: `Modifier ${quizTitle}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
    await auditScreen(page, 'éditeur de quiz : formulaire du quiz', theme);
    for (const [i, [type]] of SIX_TYPES.entries()) {
      await page.getByRole('button', { name: 'Modifier la question' }).nth(i).click();
      await expect(page.getByRole('heading', { name: 'Modifier la question' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Type de question' })).toHaveText(type);
      await auditScreen(page, `éditeur de quiz : question ${type}`, theme);
      if (type === 'Code') {
        await page.getByRole('button', { name: 'Gérer' }).click();
        await expect(page.getByRole('heading', { name: 'Harnais de test' })).toBeVisible();
        await auditScreen(page, 'éditeur de quiz : harnais de test', theme);
        await page.getByRole('button', { name: 'Annuler' }).click();
        await expect(page.getByRole('heading', { name: 'Modifier la question' })).toBeVisible();
      }
      if (i === 0) {
        await page.getByRole('button', { name: 'Tester', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Tester la question' })).toBeVisible();
        await auditScreen(page, 'éditeur de quiz : tester la question', theme);
        await page.getByRole('button', { name: 'Retour' }).click();
        await expect(page.getByRole('heading', { name: 'Modifier la question' })).toBeVisible();
      }
      await page.getByRole('button', { name: 'Annuler' }).click();
      await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Supprimer la question' }).first().click();
    const confirm = confirmationPopup(page, 'Supprimer la question ?');
    await expect(confirm).toBeVisible();
    await auditScreen(page, 'éditeur de quiz : confirmation de suppression', theme);
    // Deux « Annuler » à l'écran (formulaire du quiz derrière) : celui de la confirmation.
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Supprimer la question ?' })).toHaveCount(0);
    // « Annuler » du quiz jette tout, puis fermeture de l'éditeur.
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
    await page.getByRole('button', { name: 'Fermer' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeHidden();

    // Cours et programme.
    await clickProgramMenu(page, fixture.program.name, 'Ajouter un cours');
    await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toBeVisible();
    await auditScreen(page, 'popup Ajouter un cours', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Ajouter un cours' })).toHaveCount(0);

    await clickCourseMenu(page, fixture.course.code, 'Modifier le cours');
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toBeVisible();
    await auditScreen(page, 'popup Modifier le cours', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le cours' })).toHaveCount(0);

    await clickProgramMenu(page, fixture.program.name, 'Modifier le programme');
    await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toBeVisible();
    await auditScreen(page, 'popup Modifier le programme', theme);
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le programme' })).toHaveCount(0);

    // Rôles : liste, puis recherche d'un candidat.
    await clickProgramMenu(page, fixture.program.name, 'Gérer les rôles');
    await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toBeVisible();
    await auditScreen(page, 'popup Gestion des rôles', theme);
    await page.getByRole('button', { name: '+ Ajouter' }).first().click();
    await expect(page.getByPlaceholder('Rechercher un utilisateur…')).toBeVisible();
    await auditScreen(page, 'popup Gestion des rôles : ajout', theme);
    await page.getByRole('button', { name: '✕' }).click();
    await expect(page.getByRole('heading', { name: 'Gestion des rôles' })).toHaveCount(0);

    // MCP : gestion, puis bilan d'une analyse (repli déterministe, poussé par WebSocket).
    await clickCourseMenu(page, fixture.course.code, 'Feedback du cours');
    await expect(page.getByRole('heading', { name: 'Gestion MCP' })).toBeVisible();
    await expect(page.getByText('Chargement des analyses…')).toBeHidden();
    await auditScreen(page, 'popup Gestion MCP', theme);
    const historyRows = page.getByRole('button', { name: /\d+ forces? · \d+ points? à améliorer$/ });
    const before = await historyRows.count();
    await page.getByRole('button', { name: 'Analyser' }).click();
    await expect(historyRows).toHaveCount(before + 1, { timeout: 30_000 });
    await historyRows.first().click();
    await expect(page.getByRole('heading', { name: 'Bilan MCP' })).toBeVisible();
    await expect(page.getByText('Chargement de l’analyse…')).toBeHidden();
    await auditScreen(page, 'popup Bilan MCP', theme);
    await page.getByRole('button', { name: '✕' }).click(); // croix sans aria-label
    await expect(page.getByRole('heading', { name: 'Bilan MCP' })).toHaveCount(0);

    await context.close();
  });

  test(`popups du gardien : établissements, créer un programme, journal d’audit, administrateurs (${theme})`, async ({
    browser,
    baseURL,
  }) => {
    test.fail(
      true,
      '#109 a11y : button-name (poubelles de « Gérer les administrateurs »), aria-required-children (journal d’audit), aria-required-attr, aria-prohibited-attr, label-content-name-mismatch, color-contrast'
    );
    // Gardien NEUF : le compte gardien du bootstrap est partagé et sa session unique serait
    // révoquée par toute connexion concurrente pendant le parcours.
    const guardian = await createGuardianAccount(baseURL!);
    await setThemeInDb(baseURL!, guardian.storageState, theme);
    const { context, page } = await openHome(browser, guardian.storageState);
    try {
      await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
      await expectTheme(page, theme);

      await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
      await page.getByRole('button', { name: /^⚙ Gérer les établissements/ }).click();
      await expect(page.getByRole('heading', { name: 'Gérer les établissements' })).toBeVisible();
      await auditScreen(page, 'popup Gérer les établissements', theme);
      await page.getByRole('button', { name: '+ Ajouter un établissement' }).click();
      await expect(page.getByRole('heading', { name: 'Ajouter un établissement' })).toBeVisible();
      await auditScreen(page, 'popup Ajouter un établissement', theme);
      await page.getByRole('button', { name: 'Annuler' }).click();
      await expect(page.getByRole('heading', { name: 'Ajouter un établissement' })).toHaveCount(0);
      await page.getByRole('button', { name: '✕' }).click(); // croix de l'en-tête (sans aria-label)
      await expect(page.getByRole('heading', { name: 'Gérer les établissements' })).toHaveCount(0);

      await page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click();
      await page.getByRole('button', { name: /^\+ Créer un programme/ }).click();
      await expect(page.getByRole('heading', { name: 'Créer un programme' })).toBeVisible();
      await auditScreen(page, 'popup Créer un programme', theme);
      await page.getByRole('button', { name: 'Annuler' }).click();
      await expect(page.getByRole('heading', { name: 'Créer un programme' })).toHaveCount(0);

      await (await openUserMenu(page)).getByRole('menuitem', { name: 'Journalisation' }).click();
      await expect(page.getByRole('heading', { name: "Journal d'audit" })).toBeVisible();
      await expect(page.getByRole('group', { name: "Journal d'audit" })).toBeVisible();
      await auditScreen(page, "popup Journal d'audit", theme);
      await page.getByRole('button', { name: 'Fermer' }).click();
      await expect(page.getByRole('heading', { name: "Journal d'audit" })).toHaveCount(0);

      await (await openUserMenu(page))
        .getByRole('menuitem', { name: 'Gérer les administrateurs' })
        .click();
      await expect(page.getByRole('heading', { name: 'Gérer les administrateurs' })).toBeVisible();
      await auditScreen(page, 'popup Gérer les administrateurs', theme);
      await page.getByRole('button', { name: '✕' }).click();
      await expect(page.getByRole('heading', { name: 'Gérer les administrateurs' })).toHaveCount(0);
    } finally {
      await context.close();
      await guardian.cleanup();
    }
  });
}
