import { request } from '@playwright/test';
import { TEST_COURSE_ID } from '../setup/accounts';
import { expect, test, type Page } from './fixtures';
import {
  QUIZ_NAME,
  createEnrolledUser,
  mainContent,
  openCourseItem,
  uniqueSuffix,
} from './helpers';
import {
  createQuizApi,
  deleteQuizzesMatching,
  pointerDrag,
  profSession,
  pythonLanguage,
} from './quiz.helpers';

// Un quiz n'accepte qu'UNE tentative par compte : chaque exécution utilise un compte neuf.
// Questions 1 à 3 répondues juste ; 4 (remise en ordre) et 5 (association) laissées telles quelles.
test('passer un quiz et voir la correction', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const main = mainContent(page);

  await openCourseItem(page, QUIZ_NAME);
  await expect(main).toContainText('Question 1 sur 5');

  await main.getByRole('button', { name: 'Vrai', exact: true }).click();
  await main.getByRole('button', { name: 'Question 2', exact: true }).click();
  await main.getByRole('button', { name: 'Pile (stack)' }).click();
  await main.getByRole('button', { name: 'Question 3', exact: true }).click();
  await main.getByRole('button', { name: 'Python' }).click();
  await main.getByRole('button', { name: 'Java', exact: true }).click();
  await main.getByRole('button', { name: 'Question 5', exact: true }).click();
  await main.getByRole('button', { name: 'Soumettre' }).click();

  // Correction asynchrone (POST 202 puis résultat poussé par WebSocket).
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible({
    timeout: 30_000,
  });
  const detail = (type: string) => main.getByRole('button', { name: new RegExp(`^${type} `) });
  await expect(detail('Vrai/Faux')).toHaveAccessibleName(/1 \/ 1$/);
  await expect(detail('Choix unique')).toHaveAccessibleName(/1 \/ 1$/);
  await expect(detail('Choix multiple')).toHaveAccessibleName(/2 \/ 2$/);
  await expect(detail('Association')).toHaveAccessibleName(/0 \/ 2$/);

  // Le résultat est persisté : il s'affiche encore après rechargement.
  await openCourseItem(page, QUIZ_NAME);
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible();

  await context.close();
});

/** Réponses justes aux questions 1 à 3 du quiz du seed (Vrai/Faux, choix unique, multiple). */
async function answerSeedChoices(page: Page) {
  const main = mainContent(page);
  await main.getByRole('button', { name: 'Vrai', exact: true }).click();
  await main.getByRole('button', { name: 'Question 2', exact: true }).click();
  await main.getByRole('button', { name: 'Pile (stack)' }).click();
  await main.getByRole('button', { name: 'Question 3', exact: true }).click();
  await main.getByRole('button', { name: 'Python' }).click();
  await main.getByRole('button', { name: 'Java', exact: true }).click();
}

// Glisser-déposer par Pointer Events (souris) : « Remise en ordre » par la poignée, « Association »
// de la réserve vers les zones `data-zone`. Toutes les réponses justes → 8/8 ; puis revue, reprise
// (quiz du seed à reprises autorisées) et historique des tentatives.
test('glisser-déposer, revue des réponses et reprise du quiz', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const main = mainContent(page);

  await openCourseItem(page, QUIZ_NAME);
  await answerSeedChoices(page);

  // Remise en ordre : l'ordre initial est mélangé ; on remonte chaque élément à sa place.
  await main.getByRole('button', { name: 'Question 4', exact: true }).click();
  const expected = ['Prétraitement', 'Compilation', 'Assemblage', 'Édition des liens'];
  const rows = main.locator('li[data-reorder-id]');
  await expect(rows).toHaveCount(4);
  for (const [i, label] of expected.entries()) {
    if ((await rows.nth(i).innerText()).includes(label)) continue;
    const grip = rows.filter({ hasText: label }).locator('span[aria-hidden]').first();
    await pointerDrag(page, grip, rows.nth(i));
    await expect(rows.nth(i)).toContainText(label);
  }

  // Association : chaque étiquette de la réserve vers sa catégorie.
  await main.getByRole('button', { name: 'Question 5', exact: true }).click();
  const pairs = [
    ['Haskell', 'Fonctionnel'],
    ['Java', 'Orienté objet'],
    ['Prolog', 'Logique'],
    ['C', 'Impératif'],
  ];
  for (const [item, group] of pairs) {
    const chip = main.locator('[data-zone="__pool__"]').getByText(item, { exact: true });
    const zone = main.locator(`[data-zone="${group}"]`);
    await pointerDrag(page, chip, zone);
    await expect(zone).toContainText(item);
  }

  await main.getByRole('button', { name: 'Soumettre' }).click();
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main).toContainText('8 / 8 points · 5 questions parfaites sur 5');

  // Revue question par question, puis retour au résumé.
  await main.getByRole('button', { name: 'Revoir mes réponses' }).click();
  await expect(main.getByRole('button', { name: 'Retour au résumé' })).toBeVisible();
  await expect(main.getByText('1 / 1 pts', { exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Retour au résumé' }).click();
  await expect(main.getByRole('heading', { name: `${QUIZ_NAME} — terminé !` })).toBeVisible();

  // Reprise : 2e tentative incomplète (question 1 seule ; la remise en ordre, laissée dans son
  // ordre mélangé, peut rapporter un crédit partiel → score non fixé, mais < 8).
  await main.getByRole('button', { name: 'Refaire le quiz' }).click();
  await expect(main).toContainText('Question 1 sur 5');
  await main.getByRole('button', { name: 'Vrai', exact: true }).click();
  await main.getByRole('button', { name: 'Question 5', exact: true }).click();
  await main.getByRole('button', { name: 'Soumettre' }).click();
  const secondAttempt = main.getByRole('button', { name: /^#2 · \d+(\.\d)?\/8$/ });
  await expect(secondAttempt).toBeVisible({ timeout: 30_000 });
  await expect(secondAttempt).not.toHaveText('#2 · 8/8');
  await expect(main).toContainText('Tentatives');
  await expect(main).toContainText('Meilleur score : 100 %');

  // Une puce rouvre la tentative correspondante.
  await main.getByRole('button', { name: '#1 · 8/8' }).click();
  await expect(main).toContainText('8 / 8 points · 5 questions parfaites sur 5');

  await context.close();
});

// Quiz créé par le prof (API), reprises désactivées, avec une question de Code Python corrigée
// par Piston de façon asynchrone. Compte neuf : la tentative est unique.
test('question de code et tentative unique', async ({ browser, baseURL }) => {
  const { api } = await profSession(baseURL!);
  const marker = '[e2e-q]';
  await deleteQuizzesMatching(api, marker); // reliquats d'un run interrompu
  const title = `${marker} Code ${uniqueSuffix()}`;
  const startCode = 'def solution(a, b):\n    pass\n';
  try {
    const quizId = await createQuizApi(api, {
      title,
      allowRetry: false,
      questions: [
        {
          qType: 'true_false',
          prompt: 'Python est interprété.',
          totalScore: 1,
          answers: [
            { content: 'Vrai', isCorrect: true },
            { content: 'Faux', isCorrect: false },
          ],
        },
        {
          qType: 'coding',
          prompt: 'Écris `solution(a, b)` qui renvoie a + b.',
          totalScore: 2,
          language: await pythonLanguage(api),
          startCode,
          testCases: [
            { name: 'Entiers positifs', harnessCode: 'return solution(2, 3) == 5', weight: 1 },
            { name: 'Entiers négatifs', harnessCode: 'return solution(-1, -4) == -5', weight: 1 },
          ],
        },
      ],
    });

    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    const main = mainContent(page);
    await openCourseItem(page, title);
    await main.getByRole('button', { name: 'Vrai', exact: true }).click();
    await main.getByRole('button', { name: 'Suivant' }).click();

    // Solution volontairement fausse sur les négatifs : 1 harnais sur 2.
    const editor = main.getByRole('textbox', { name: 'Éditeur de code (Python)' });
    await expect(editor).toHaveValue(startCode);
    // NB : pas de print d'une valeur seule (ex. print(5)) : cf. le bogue décrit dans
    // quiz-editor.spec.ts (« un print au premier niveau… »).
    await editor.fill(
      'def solution(a, b):\n    return abs(a) + abs(b)\n\nprint("solution(2, 3) =", solution(2, 3))\n'
    );
    await main.getByRole('button', { name: 'Exécuter' }).click();
    await expect(main.getByText('Console', { exact: true })).toBeVisible();
    await expect(main.locator('pre').filter({ hasText: /^solution\(2, 3\) = 5\s*$/ })).toBeVisible({
      timeout: 30_000,
    });
    await main.getByRole('button', { name: 'Fermer la console' }).click();
    await expect(main.getByText('Console', { exact: true })).toBeHidden();

    // Soumission (202) puis correction en tâche de fond, poussée par WebSocket.
    await main.getByRole('button', { name: 'Soumettre' }).click();
    await expect(main.getByRole('heading', { name: `${title} — terminé !` })).toBeVisible({
      timeout: 60_000,
    });
    await expect(main).toContainText('2 / 3 points · 1 question parfaite sur 2');
    await expect(main.getByRole('button', { name: 'Refaire le quiz' })).toHaveCount(0);

    // Revue de la question de code : code soumis + verdict par harnais.
    await main.getByRole('button', { name: /^Code / }).click();
    await expect(main.getByText('Ta réponse')).toBeVisible();
    await expect(main.getByText('Résultat des tests')).toBeVisible();
    await expect(main.getByRole('textbox', { name: 'Éditeur de code (Python)' })).toHaveValue(
      /abs\(a\) \+ abs\(b\)/
    );
    await expect(main.getByText('Entiers positifs')).toBeVisible();
    await expect(main.getByText('Entiers négatifs')).toBeVisible();
    await expect(main.getByText('+1/2', { exact: true })).toBeVisible();
    await expect(main.getByText('−1/2', { exact: true })).toBeVisible();
    await main.getByRole('button', { name: 'Terminé' }).click();

    // Tentative consommée : au rechargement, résumé sans reprise ni soumission ; le serveur
    // refuse une 2e soumission.
    await openCourseItem(page, title);
    await expect(main.getByRole('heading', { name: `${title} — terminé !` })).toBeVisible();
    await expect(main.getByRole('button', { name: 'Refaire le quiz' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Soumettre' })).toHaveCount(0);
    const again = await page.request.post(`/api/quizzes/${quizId}/submissions`, {
      data: { quizId, answers: [] },
    });
    expect(again.status()).toBe(409);

    await context.close();
  } finally {
    await deleteQuizzesMatching(api, title, baseURL);
    await api.dispose();
  }
});

// Contrat d'API (#90) : l'éditeur et la passation n'envoient jamais ces requêtes, mais l'API les
// refuse quand même (requête fabriquée). Vérifié de bout en bout, à travers gateway et permissions.
test('API : une question à choix sans bonne réponse est refusée, à la création comme à la modification', async ({
  baseURL,
}) => {
  const { api } = await profSession(baseURL!);
  const marker = '[e2e-contrat-choix]';
  await deleteQuizzesMatching(api, marker);
  const title = `${marker} ${uniqueSuffix()}`;
  const choice = (correct: boolean) => ({
    qType: 'single_choice' as const,
    prompt: 'Capitale du Canada ?',
    totalScore: 1,
    answers: [
      { content: 'Ottawa', isCorrect: correct },
      { content: 'Toronto', isCorrect: false },
    ],
  });
  try {
    // Création refusée : 400 avec le motif, et aucun quiz créé.
    const refused = await api.post(`/api/courses/${TEST_COURSE_ID}/quizzes`, {
      data: { title, isPublished: false, isDaily: false, allowRetry: false, questions: [{ ...choice(false), orderIndex: 0 }] },
    });
    expect(refused.status()).toBe(400);
    expect(await refused.text()).toBe('Question 1 : au moins une bonne réponse doit être cochée.');
    const list = (await (await api.get(`/api/courses/${TEST_COURSE_ID}/quizzes/manage`)).json()) as { title: string }[];
    expect(list.map((q) => q.title)).not.toContain(title);

    // Modification qui décoche la dernière bonne réponse : refusée, le quiz reste intact.
    const quizId = await createQuizApi(api, { title, isPublished: false, questions: [choice(true)] });
    const edit = (await (await api.get(`/api/quizzes/${quizId}/edit`)).json()) as {
      questions: { answers: { content: string; isCorrect: boolean }[] }[];
    };
    const unchecked = {
      ...edit,
      questions: edit.questions.map((q) => ({ ...q, answers: q.answers.map((a) => ({ ...a, isCorrect: false })) })),
    };
    const update = await api.put(`/api/quizzes/${quizId}`, { data: unchecked });
    expect(update.status()).toBe(400);
    const after = (await (await api.get(`/api/quizzes/${quizId}/edit`)).json()) as typeof edit;
    expect(after.questions[0].answers.filter((a) => a.isCorrect).map((a) => a.content)).toEqual(['Ottawa']);
  } finally {
    await deleteQuizzesMatching(api, marker, baseURL);
    await api.dispose();
  }
});

test("API : une remise en ordre qui n'est pas une permutation est refusée sans consommer la tentative", async ({
  baseURL,
}) => {
  const { api } = await profSession(baseURL!);
  const marker = '[e2e-contrat-ordre]';
  await deleteQuizzesMatching(api, marker);
  const title = `${marker} ${uniqueSuffix()}`;
  try {
    const quizId = await createQuizApi(api, {
      title,
      allowRetry: false, // tentative unique : prouve que les refus ne la consomment pas
      questions: [
        {
          qType: 'ordering',
          prompt: 'Ordonne les étapes de compilation.',
          totalScore: 3,
          dragItems: [
            { content: 'Prétraitement', correctOrder: 0 },
            { content: 'Compilation', correctOrder: 1 },
            { content: 'Édition des liens', correctOrder: 2 },
          ],
        },
      ],
    });
    const { storageState } = await createEnrolledUser(baseURL!);
    const student = await request.newContext({ baseURL, storageState });
    try {
      const quiz = (await (await student.get(`/api/quizzes/${quizId}`)).json()) as {
        questions: { id: number; dragItems: { id: number }[] }[];
      };
      const q = quiz.questions[0];
      const ids = q.dragItems.map((d) => d.id);
      const submit = (order: (number | null)[]) =>
        student.post(`/api/quizzes/${quizId}/submissions`, {
          data: { quizId, answers: [{ questionId: q.id, orderedItemIds: order }] },
        });

      for (const [cas, order] of [
        ['élément en trop', [...ids, 999_999]],
        ['élément manquant', ids.slice(0, 2)],
        ['doublon', [ids[0], ids[0], ids[1]]],
        ['id null', [ids[0], null, ids[2]]],
      ] as const) {
        const res = await submit([...order]);
        expect(res.status(), cas).toBe(400);
        expect(await res.text(), cas).toBe(
          "Question 1 : l'ordre soumis doit contenir chaque élément exactement une fois."
        );
      }

      // Aucune tentative enregistrée : la soumission valide (permutation, même fausse) passe.
      expect((await (await student.get(`/api/quizzes/${quizId}/attempts`)).json()) as unknown[]).toHaveLength(0);
      expect((await submit([ids[2], ids[0], ids[1]])).status()).toBe(202);
      // Et la tentative unique s'applique toujours ensuite.
      await expect.poll(async () => (await submit([...ids])).status()).toBe(409);
    } finally {
      await student.dispose();
    }
  } finally {
    await deleteQuizzesMatching(api, marker, baseURL);
    await api.dispose();
  }
});
