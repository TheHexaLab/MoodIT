import { expect, test, type Page } from './fixtures';
import { mainContent, uniqueSuffix } from './helpers';
import { enterProgram, openHome } from './admin.helpers';
import {
  THEMES,
  auditScreen,
  createProgramFixture,
  enrolledStudent,
  expectTheme,
  setThemeInDb,
  type ProgramFixture,
} from './a11y.helpers';

// Tentatives « à revoir » (#116) : pastille « N à revoir » de l'éditeur de quiz, vue « Tentatives à
// revoir » (relance de la correction) et message de l'étudiant « Tentative transmise à votre
// enseignant », audités avec axe (WCAG 2.1 AA, clair + sombre) et parcourus dans un vrai navigateur.
//
// CE QUI EST SIMULÉ (page.route) : une tentative n'est « à revoir » qu'après plusieurs échecs SANS
// VERDICT du conteneur runner, que ni le code soumis ni un harnais ne peuvent provoquer à coup sûr
// (c'est le but de l'isolation), et les tests n'ont pas accès à la BD pour en poser une. Sont donc
// simulés : le compteur `reviewAttemptCount` de la liste des quiz (réponse réelle de
// `/quizzes/manage`, compteur réécrit), la liste `/review-attempts`, la relance POST `/regrade`
// (202) et l'historique des tentatives de l'étudiant (`/attempts`). Le reste (programme, cours,
// quiz, comptes, rôles, thème) est réel, créé par l'API pour ce fichier : le seed n'est pas touché
// et le fichier est rejouable.
//
// CE QUI N'EST PAS COUVERT PAR LES PARCOURS : la vraie relance (tentative repassée en correction,
// verdict poussé par WebSocket) — couverte côté core (QuizServiceSubmissionTest, et sur une vraie
// BD par QuizServiceSubmitIT : plafond d'échecs sans verdict, relance corrigée ou revenue à revoir).
// Le passage réel par gateway + permission-service est vérifié par le dernier test de ce fichier
// (200 / 404 pour le gestionnaire du quiz, 403 pour un étudiant), et en unitaire par
// PermissionServiceRulesTest (règles), RouteCoverageTest (une règle par route servie) et
// QuizControllerTest (codes 200 / 202 / 404 / 409 du contrôleur).

const EVA = {
  attemptId: 990_081,
  attemptNo: 2,
  studentName: 'Éva Revue',
  submittedAt: '2026-09-02T08:30:00Z',
  noVerdictFailures: 3,
};
const BOB = {
  attemptId: 990_082,
  attemptNo: 1,
  studentName: 'Bob Revue',
  submittedAt: '2026-09-03T14:05:00Z',
  noVerdictFailures: 3,
};

/** Fixture : programme + cours neufs, Administrateur neuf (gestionnaire du quiz), quiz publié. */
let fixture: ProgramFixture;
let quizTitle: string;
let quizId: number;

test.beforeAll(async ({ baseURL }) => {
  fixture = await createProgramFixture(baseURL!, 'Revue');
  quizTitle = `Quiz à revoir ${uniqueSuffix()}`;
  const res = await fixture.admin.api.post(`/api/courses/${fixture.course.id}/quizzes`, {
    data: {
      title: quizTitle,
      isPublished: true,
      isDaily: false,
      allowRetry: true,
      questions: [
        {
          qType: 'true_false',
          prompt: 'Le ciel est bleu.',
          totalScore: 1,
          orderIndex: 0,
          answers: [
            { content: 'Vrai', isCorrect: true },
            { content: 'Faux', isCorrect: false },
          ],
        },
      ],
    },
  });
  expect(res.ok(), `création du quiz : HTTP ${res.status()} ${await res.text()}`).toBe(true);
  quizId = ((await res.json()) as { id: number }).id;
});

test.afterAll(async () => {
  await fixture?.cleanup();
});

/**
 * Simule, pour le quiz de la fixture, les tentatives à revoir côté enseignant : `pending` est
 * l'état « serveur » ; la relance (202) en retire la tentative, et la liste des quiz en dérive son
 * compteur.
 */
async function simulateReviewAttempts(page: Page) {
  let pending = [EVA, BOB];
  await page.route(`**/api/courses/${fixture.course.id}/quizzes/manage`, async (route) => {
    const response = await route.fetch();
    const quizzes = (await response.json()) as { id: number }[];
    await route.fulfill({
      response,
      json: quizzes.map((q) => (q.id === quizId ? { ...q, reviewAttemptCount: pending.length } : q)),
    });
  });
  await page.route(`**/api/quizzes/${quizId}/review-attempts`, (route) =>
    route.fulfill({ json: pending })
  );
  await page.route(`**/api/quizzes/${quizId}/attempts/*/regrade`, (route) => {
    const attemptId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    pending = pending.filter((a) => a.attemptId !== attemptId);
    return route.fulfill({ status: 202 });
  });
}

for (const theme of THEMES) {
  test(`enseignant : pastille « à revoir », tentatives à revoir et relance (${theme})`, async ({
    browser,
    baseURL,
  }) => {
    await setThemeInDb(baseURL!, fixture.admin.storageState, theme);
    const { context, page } = await openHome(browser, fixture.admin.storageState);
    await simulateReviewAttempts(page);
    const nav = page.getByRole('navigation', { name: 'Cours' });
    await enterProgram(page, fixture.program.name);
    await expect(nav.getByRole('button', { name: fixture.course.code, exact: true })).toBeVisible();
    await expectTheme(page, theme);

    // Liste des quiz : la pastille porte le nombre de tentatives à revoir.
    await nav.getByRole('button', { name: 'Modifier la section Quiz' }).click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
    const badge = page.getByRole('button', { name: `2 à revoir : tentatives de ${quizTitle}` });
    await expect(badge).toHaveText('2 à revoir');
    await auditScreen(page, 'éditeur de quiz : liste avec pastille « à revoir »', theme);

    // Vue « Tentatives à revoir » : une ligne par tentative, avec son bouton de relance.
    await badge.click();
    await expect(page.getByRole('heading', { name: 'Tentatives à revoir' })).toBeVisible();
    await expect(page.getByText(EVA.studentName)).toBeVisible();
    await expect(page.getByText(BOB.studentName)).toBeVisible();
    await auditScreen(page, 'éditeur de quiz : tentatives à revoir', theme);

    // Relance acceptée (202) : la ligne disparaît, le focus passe à la ligne voisine.
    await page
      .getByRole('button', { name: `Relancer la correction de la tentative 2 de ${EVA.studentName}` })
      .click();
    await expect(page.getByText(EVA.studentName)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: `Relancer la correction de la tentative 1 de ${BOB.studentName}` })
    ).toBeFocused();

    // Retour à la liste : un « à revoir » de moins.
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(
      page.getByRole('button', { name: `1 à revoir : tentative de ${quizTitle}` })
    ).toHaveText('1 à revoir');

    // Une relecture de la liste peut encore être en vol dans la route (route.fetch) : on la
    // retire avant de fermer, sinon elle échoue sur un contexte fermé.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  });

  test(`étudiant : tentative transmise à l’enseignant (${theme})`, async ({ browser, baseURL }) => {
    const student = await enrolledStudent(baseURL!, fixture);
    await setThemeInDb(baseURL!, student.storageState, theme);
    await student.api.dispose();
    const { context, page } = await openHome(browser, student.storageState);
    // Historique simulé : une tentative corrigée, puis la dernière, à revoir.
    await page.route(`**/api/quizzes/${quizId}/attempts`, (route) =>
      route.fulfill({
        json: [
          { id: 990_091, attemptNo: 1, earned: 1, max: 1, status: 'done' },
          { id: 990_092, attemptNo: 2, earned: null, max: 1, status: 'review' },
        ],
      })
    );
    const main = mainContent(page);
    await enterProgram(page, fixture.program.name);
    await page.getByRole('button', { name: quizTitle }).click();
    await expect(main.getByText('Tentative transmise à votre enseignant', { exact: true })).toBeVisible();
    await expect(main.getByText("En attente de l'enseignant", { exact: true })).toBeVisible();
    // La barre des tentatives reste sous le message (retour aux autres tentatives).
    await expect(main.getByRole('button', { name: '#2 · à revoir' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(main.getByRole('button', { name: '#1 · 1/1' })).toBeVisible();
    await expectTheme(page, theme);
    await auditScreen(page, 'quiz : tentative transmise à l’enseignant', theme);

    await context.close();
  });
}

test('routes réelles des tentatives à revoir : gateway, permission-service puis core', async ({
  baseURL,
}) => {
  // Gestionnaire du quiz : la lecture passe (aucune tentative réellement à revoir), et la relance
  // d'une tentative inexistante atteint core, qui répond 404 (la règle ne porte que sur le quiz).
  const list = await fixture.admin.api.get(`/api/quizzes/${quizId}/review-attempts`);
  expect(list.status(), 'GET review-attempts (gestionnaire)').toBe(200);
  expect(await list.json()).toEqual([]);
  const regrade = await fixture.admin.api.post(`/api/quizzes/${quizId}/attempts/2147483647/regrade`);
  expect(regrade.status(), 'POST regrade d’une tentative inexistante (gestionnaire)').toBe(404);

  // Étudiant du cours : refusé par permission-service, sur les deux routes.
  const student = await enrolledStudent(baseURL!, fixture);
  try {
    const denied = await student.api.get(`/api/quizzes/${quizId}/review-attempts`);
    expect(denied.status(), 'GET review-attempts (étudiant)').toBe(403);
    const deniedRegrade = await student.api.post(
      `/api/quizzes/${quizId}/attempts/2147483647/regrade`
    );
    expect(deniedRegrade.status(), 'POST regrade (étudiant)').toBe(403);
  } finally {
    await student.api.dispose();
  }
});
