import { expect, test, type APIRequestContext, type Browser, type Page } from './fixtures';
import { createEnrolledUser, mainContent, uniqueSuffix } from './helpers';
import {
  createQuizApi,
  deleteQuizzesMatching,
  openTestCourse,
  pickOption,
  pointerDrag,
  profSession,
  type QuestionPayload,
} from './quiz.helpers';

// Éditeur de quiz (Enseignant du programme 1) sur le cours MAT115. Chaque quiz créé porte le
// marqueur MARKER + un suffixe unique ; ils sont supprimés en fin de fichier (et ceux d'un run
// interrompu au début), sans jamais toucher au quiz du seed.
const MARKER = '[e2e-qe]';
const quizTitle = (label: string) => `${MARKER} ${label} ${uniqueSuffix()}`;

// Une seule session « prof » pour tout le fichier (cf. profSession) ; les étudiants sont des
// comptes neufs (createEnrolledUser) pour ne dépendre d'aucune session partagée.
let api: APIRequestContext;
let profState: Awaited<ReturnType<typeof profSession>>['storageState'];

test.beforeAll(async ({ baseURL }) => {
  ({ api, storageState: profState } = await profSession(baseURL!));
  await deleteQuizzesMatching(api, MARKER);
});

// Le compte prof est partagé : si une autre exécution s'y est connectée entre deux tests, notre
// jeton a été révoqué → on rouvre une session plutôt que d'échouer sur /login.
test.beforeEach(async ({ baseURL }) => {
  if ((await api.get('/api/me')).ok()) return;
  await api.dispose();
  ({ api, storageState: profState } = await profSession(baseURL!));
});

test.afterAll(async ({ baseURL }) => {
  await deleteQuizzesMatching(api, MARKER, baseURL);
  await api.dispose();
});

async function profPage(browser: Browser) {
  const context = await browser.newContext({ storageState: profState });
  return context.newPage();
}

/** Page d'un étudiant neuf inscrit au cours de test. */
async function studentPage(browser: Browser, baseURL: string) {
  const { storageState } = await createEnrolledUser(baseURL);
  const context = await browser.newContext({ storageState });
  return context.newPage();
}

/** Ouvre « Modifier les quiz » depuis le crayon de la section QUIZ. */
async function openEditor(page: Page) {
  const nav = await openTestCourse(page);
  await nav.getByRole('button', { name: 'Modifier la section QUIZ' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
}

/** Ligne d'un quiz dans la liste de l'éditeur (lignes sans rôle : repérées par data-reorder-id). */
const quizRow = (page: Page, title: string) =>
  page.locator('[data-reorder-id]').filter({ hasText: title });

/**
 * Saisit l'énoncé de la question et vérifie qu'il est pris. Sous WebKit, un `fill` lancé juste
 * après l'affichage de la vue « question » peut être perdu (le champ reste vide, #165) : on
 * relit la valeur et on ressaisit tant qu'elle n'est pas là.
 */
async function fillPrompt(page: Page, prompt: string) {
  const field = page.getByRole('textbox', { name: 'Éditeur Markdown' });
  await expect(async () => {
    await field.fill(prompt);
    await expect(field).toHaveValue(prompt, { timeout: 1_000 });
  }).toPass();
}

/** Ouvre « Nouvelle question », saisit l'énoncé, le type et le barème. */
async function startQuestion(page: Page, type: string, prompt: string, points: number) {
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle question' })).toBeVisible();
  await fillPrompt(page, prompt);
  if (type !== 'Choix unique') await pickOption(page, 'Type de question', type);
  await expect(page.getByRole('button', { name: 'Type de question' })).toHaveText(type);
  await page.getByRole('spinbutton', { name: 'Points' }).fill(String(points));
}

// Champs de réponse : nommés « Réponse 1 », « Réponse 2 »… (aria-label, #109).
const answerFields = (page: Page) => page.getByRole('textbox', { name: /^Réponse \d+$/ });
const elementFields = (page: Page) => page.getByRole('textbox', { name: 'Élément…' });
const categoryFields = (page: Page) => page.getByRole('textbox', { name: 'Catégorie' });
const addButton = (page: Page) => page.getByRole('button', { name: 'Ajouter', exact: true });
const testButton = (page: Page) => page.getByRole('button', { name: 'Tester', exact: true });

/** Question Code Python : code de départ + un harnais (le harnais RENVOIE un booléen). */
async function fillCodingQuestion(page: Page, startCode: string, harness: string) {
  await expect(page.getByRole('button', { name: 'Langage' })).toHaveText('Python');
  await page.getByRole('textbox', { name: 'Code de départ' }).fill(startCode);
  await page.getByRole('button', { name: 'Gérer' }).click();
  await expect(page.getByRole('heading', { name: 'Harnais de test' })).toBeVisible();
  await page.getByRole('button', { name: '+ Ajouter un harnais' }).click();
  await page.getByPlaceholder('Nom du cas (ex. Cas nominal)').fill('Somme de deux entiers');
  await page.getByRole('textbox', { name: 'Code du harnais 1' }).fill(harness);
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle question' })).toBeVisible();
  await expect(page.getByText('1 harnais', { exact: true })).toBeVisible();
}

const START_CODE = 'def solution(a, b):\n    return 0\n';
const HARNESS = 'return solution(2, 3) == 5';

test('créer un quiz avec les 6 types : publié visible chez l’étudiant, brouillon non', async ({
  browser,
  baseURL,
}) => {
  const published = quizTitle('Tous les types');
  const draft = quizTitle('Brouillon');
  const page = await profPage(browser);
  await openEditor(page);

  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  await expect(page.getByRole('heading', { name: 'Nouveau quiz' })).toBeVisible();

  // Titre et interrupteurs saisis APRÈS les questions : ils sont perdus au retour de l'éditeur de
  // question (bogue couvert par le test « méta conservées » plus bas).
  await startQuestion(page, 'Vrai/Faux', 'Le ciel est bleu.', 1);
  await addButton(page).click();

  await startQuestion(page, 'Choix unique', 'Capitale du Canada ?', 2);
  await answerFields(page).nth(0).fill('Ottawa');
  await answerFields(page).nth(1).fill('Toronto');
  await addButton(page).click();

  await startQuestion(page, 'Choix multiple', 'Nombres pairs ?', 1);
  await page.getByRole('button', { name: '+ Ajouter une réponse' }).click();
  await answerFields(page).nth(0).fill('2');
  await answerFields(page).nth(1).fill('3');
  await answerFields(page).nth(2).fill('4');
  await page.getByRole('button', { name: 'Marquer comme correcte' }).nth(2).click();
  await addButton(page).click();

  await startQuestion(page, 'Remise en ordre', 'Ordonne du plus petit au plus grand.', 2);
  await page.getByRole('button', { name: '+ Ajouter un élément' }).click();
  await elementFields(page).nth(0).fill('Un');
  await elementFields(page).nth(1).fill('Deux');
  await elementFields(page).nth(2).fill('Trois');
  await addButton(page).click();

  await startQuestion(page, 'Association', 'Associe chaque animal.', 2);
  await elementFields(page).nth(0).fill('Chat');
  await categoryFields(page).nth(0).fill('Mammifère');
  await elementFields(page).nth(1).fill('Aigle');
  await categoryFields(page).nth(1).fill('Oiseau');
  await addButton(page).click();

  await startQuestion(page, 'Code', 'Écris `solution(a, b)` qui renvoie a + b.', 3);
  await fillCodingQuestion(page, START_CODE, HARNESS);
  await addButton(page).click();

  // 1 + 2 + 1 + 2 + 2 + 3 : total recalculé à chaque ajout.
  await expect(page.getByRole('heading', { name: 'Nouveau quiz' })).toBeVisible();
  await expect(page.getByText('11 pts', { exact: true })).toBeVisible();
  for (const type of [
    'Vrai/Faux',
    'Choix unique',
    'Choix multiple',
    'Remise en ordre',
    'Association',
    'Code',
  ]) {
    await expect(page.getByText(type, { exact: true })).toBeVisible();
  }

  await page.getByRole('textbox', { name: 'Titre' }).fill(published);
  const publish = page.getByRole('switch', { name: 'Publié' });
  await expect(publish).toHaveAttribute('aria-checked', 'false');
  await publish.click();
  await expect(publish).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  // Enregistré : le formulaire passe en mode édition du quiz persisté.
  await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();

  // Second quiz, laissé en brouillon.
  await page.getByRole('button', { name: 'Retour' }).click();
  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  await startQuestion(page, 'Vrai/Faux', 'Brouillon pas encore prêt.', 1);
  await addButton(page).click();
  await page.getByRole('textbox', { name: 'Titre' }).fill(draft);
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
  await page.getByRole('button', { name: 'Retour' }).click();

  // Liste de l'éditeur : les deux quiz, avec leur statut et leur nombre de questions.
  await expect(quizRow(page, published)).toContainText('Publié');
  await expect(quizRow(page, published)).toContainText('6 questions');
  await expect(quizRow(page, draft)).toContainText('Brouillon');
  await expect(quizRow(page, draft)).toContainText('1 questions');
  await page.getByRole('button', { name: 'Fermer' }).click();
  await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeHidden();

  // Barre latérale d'un étudiant : quiz publiés seulement.
  const student = await studentPage(browser, baseURL!);
  const quizSection = (await openTestCourse(student)).getByRole('region', { name: 'QUIZ' });
  await expect(quizSection.getByRole('button', { name: published })).toBeVisible();
  await expect(quizSection.getByRole('button', { name: draft })).toHaveCount(0);
  await quizSection.getByRole('button', { name: published }).click();
  await expect(mainContent(student)).toContainText('Question 1 sur 6');
  await expect(mainContent(student)).toContainText('Le ciel est bleu.');
  await student.context().close();
  await page.context().close();
});

test('validations de l’éditeur de question', async ({ browser }) => {
  const page = await profPage(browser);
  await openEditor(page);
  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  // Pas de titre : création impossible.
  await expect(page.getByRole('button', { name: 'Créer', exact: true })).toBeDisabled();

  // Choix unique : énoncé, 2 réponses non vides, une bonne réponse.
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(addButton(page)).toBeDisabled();
  await fillPrompt(page, 'Question de validation');
  await expect(addButton(page)).toBeDisabled(); // réponses vides
  await answerFields(page).nth(0).fill('A');
  await answerFields(page).nth(1).fill('B');
  await expect(addButton(page)).toBeEnabled();
  await expect(testButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Supprimer la réponse' }).nth(1).click();
  await expect(addButton(page)).toBeDisabled(); // moins de 2 réponses
  await expect(testButton(page)).toBeDisabled();
  await page.getByRole('button', { name: '+ Ajouter une réponse' }).click();
  await answerFields(page).nth(1).fill('B');
  await expect(addButton(page)).toBeEnabled();
  // Barème vide : invalide.
  await page.getByRole('spinbutton', { name: 'Points' }).fill('');
  await expect(addButton(page)).toBeDisabled();
  await page.getByRole('spinbutton', { name: 'Points' }).fill('1');
  await expect(addButton(page)).toBeEnabled();

  // Choix multiple : au moins une bonne réponse (le changement de type repart à vide).
  await pickOption(page, 'Type de question', 'Choix multiple');
  await answerFields(page).nth(0).fill('A');
  await answerFields(page).nth(1).fill('B');
  await expect(addButton(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Marquer comme correcte' }).nth(0).click(); // décoche
  await expect(addButton(page)).toBeDisabled(); // aucune bonne réponse
  await page.getByRole('button', { name: 'Marquer comme correcte' }).nth(1).click();
  await expect(addButton(page)).toBeEnabled();

  // Remise en ordre : au moins 2 éléments remplis.
  await pickOption(page, 'Type de question', 'Remise en ordre');
  await elementFields(page).nth(0).fill('Premier');
  await expect(addButton(page)).toBeDisabled();
  await elementFields(page).nth(1).fill('Second');
  await expect(addButton(page)).toBeEnabled();
  await page.getByRole('button', { name: "Supprimer l'élément" }).nth(1).click();
  await expect(addButton(page)).toBeDisabled();

  // Association : élément ET catégorie pour chaque ligne.
  await pickOption(page, 'Type de question', 'Association');
  await elementFields(page).nth(0).fill('Chat');
  await elementFields(page).nth(1).fill('Aigle');
  await categoryFields(page).nth(0).fill('Mammifère');
  await expect(addButton(page)).toBeDisabled(); // 2e catégorie manquante
  await categoryFields(page).nth(1).fill('Oiseau');
  await expect(addButton(page)).toBeEnabled();

  // Code : au moins un harnais, chacun nommé.
  await pickOption(page, 'Type de question', 'Code');
  await expect(page.getByText('0 harnais', { exact: true })).toBeVisible();
  await expect(addButton(page)).toBeDisabled();
  await expect(testButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Gérer' }).click();
  const saveHarness = page.getByRole('button', { name: 'Enregistrer' });
  await expect(saveHarness).toBeDisabled(); // aucun harnais
  await page.getByRole('button', { name: '+ Ajouter un harnais' }).click();
  await expect(saveHarness).toBeDisabled(); // harnais sans nom
  await page.getByPlaceholder('Nom du cas (ex. Cas nominal)').fill('Cas nominal');
  await expect(saveHarness).toBeEnabled();
  await page.getByRole('button', { name: 'Supprimer le harnais' }).click();
  await expect(saveHarness).toBeDisabled();
  // « Annuler » du harnais : retour à la question, toujours sans harnais.
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByText('0 harnais', { exact: true })).toBeVisible();
  await expect(addButton(page)).toBeDisabled();

  // Rien n'est persisté : on ferme sans créer.
  await page.getByRole('button', { name: 'Fermer' }).click();
});

test('tester une question : correction locale et évaluation du code par Piston', async ({
  browser,
}) => {
  const page = await profPage(browser);
  await openEditor(page);
  await page.getByRole('button', { name: 'Créer un quiz' }).click();

  // Non-code : correction locale.
  await startQuestion(page, 'Vrai/Faux', 'Deux et deux font quatre.', 1);
  await testButton(page).click();
  await expect(page.getByRole('heading', { name: 'Tester la question' })).toBeVisible();
  await expect(page.getByText('Prévisualisation : réponds comme un étudiant')).toBeVisible();
  await page.getByRole('button', { name: 'Vrai', exact: true }).click();
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByText('1 / 1 pts', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await page.getByRole('button', { name: 'Faux', exact: true }).click();
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByText('0 / 1 pts', { exact: true })).toBeVisible();
  // Retour : le brouillon de la question est conservé.
  await page.getByRole('button', { name: 'Retour' }).click();
  await expect(page.getByRole('heading', { name: 'Nouvelle question' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Éditeur Markdown' })).toHaveValue(
    'Deux et deux font quatre.'
  );

  // Code : exécution (POST /exec/run) puis évaluation des harnais (POST /exec/evaluate).
  await pickOption(page, 'Type de question', 'Code');
  await fillCodingQuestion(page, START_CODE, HARNESS);
  await testButton(page).click();
  await expect(page.getByRole('heading', { name: 'Tester la question' })).toBeVisible();
  const code = page.getByRole('textbox', { name: 'Éditeur de code (Python)' });
  await expect(code).toHaveValue(START_CODE);

  await code.fill('print("bonjour depuis piston")\ndef solution(a, b):\n    return a + b\n');
  await page.getByRole('button', { name: 'Exécuter' }).click();
  await expect(page.getByText('Console', { exact: true })).toBeVisible();
  // Sortie dans la console (bloc <pre> distinct de la coloration du code, qui contient le print).
  await expect(page.locator('pre').filter({ hasText: /^bonjour depuis piston\s*$/ })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Fermer la console' }).click();
  await expect(page.getByText('Console', { exact: true })).toBeHidden();

  // Bonne solution : le harnais réussit.
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByText('Résultat des tests')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Somme de deux entiers')).toBeVisible();
  await expect(page.getByText('+1/1', { exact: true })).toBeVisible();
  await expect(page.getByText('1 / 1 pts', { exact: true })).toBeVisible();

  // Mauvaise solution (code de départ, renvoie 0) : le harnais échoue.
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(code).toHaveValue(START_CODE);
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByText('−1/1', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('0 / 1 pts', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Fermer' }).click();
});

// Garde (execution-service, assemblage Python) : le noteur lit les réponses RPC du processus
// étudiant ligne à ligne ; un print de PREMIER NIVEAU dont la sortie est du JSON valide (ex. « 5 »)
// ne doit pas être pris pour une réponse RPC (autrefois : exception → TOUS les harnais échouaient,
// même pour une solution juste). Attendu : le harnais réussit.
test('évaluation du code : un print au premier niveau ne fausse pas la correction', async ({
  browser,
}) => {
  const page = await profPage(browser);
  await openEditor(page);
  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  await startQuestion(page, 'Code', 'Écris `solution(a, b)` qui renvoie a + b.', 1);
  await fillCodingQuestion(page, START_CODE, HARNESS);
  await testButton(page).click();
  await page
    .getByRole('textbox', { name: 'Éditeur de code (Python)' })
    .fill('def solution(a, b):\n    return a + b\n\nprint(solution(2, 3))\n');
  await page.getByRole('button', { name: 'Corriger' }).click();
  await expect(page.getByText('Résultat des tests')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('+1/1', { exact: true })).toBeVisible({ timeout: 2_000 });
  await page.context().close();
});

/** Deux questions Vrai/Faux, pour les tests d'édition. */
const twoQuestions = (first: string, second: string): QuestionPayload[] =>
  [first, second].map((prompt) => ({
    qType: 'true_false',
    prompt,
    totalScore: 1,
    answers: [
      { content: 'Vrai', isCorrect: true },
      { content: 'Faux', isCorrect: false },
    ],
  }));

test('modifier un quiz, annuler, supprimer une question puis le quiz', async ({ browser }) => {
  const title = quizTitle('À modifier');
  const renamed = `${title} (v2)`;
  await createQuizApi(api, {
    title,
    questions: twoQuestions('Première question', 'Seconde question'),
  });
  const page = await profPage(browser);
  await openEditor(page);

  // Modifier : titre + énoncé de la 1re question, suppression de la 2e, puis « Enregistrer ».
  await quizRow(page, title).click();
  await page.getByRole('button', { name: `Modifier ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
  await page.getByRole('button', { name: 'Modifier la question' }).nth(0).click();
  await expect(page.getByRole('heading', { name: 'Modifier la question' })).toBeVisible();
  await fillPrompt(page, 'Première question modifiée');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Première question modifiée')).toBeVisible();
  // Titre modifié après le passage par l'éditeur de question (cf. test « méta conservées »).
  await page.getByRole('textbox', { name: 'Titre' }).fill(renamed);
  await page.getByRole('button', { name: 'Supprimer la question' }).nth(1).click();
  await expect(page.getByRole('heading', { name: 'Supprimer la question ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.getByText('Seconde question')).toBeHidden();
  await expect(page.getByText('1 pts', { exact: true }).first()).toBeVisible();
  // On attend la réponse de l'enregistrement avant « Retour », comme un utilisateur qui voit
  // l'indicateur : tant qu'elle n'est pas arrivée, la session est encore « modifiée » et le
  // retour demande confirmation (garde de fermeture, #145).
  const saved = page.waitForResponse(
    (res) => res.request().method() === 'PUT' && /\/api\/quizzes\/\d+$/.test(res.url())
  );
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  expect((await saved).ok(), 'quiz enregistré par le serveur').toBe(true);
  await page.getByRole('button', { name: 'Retour' }).click();
  await expect(quizRow(page, renamed)).toContainText('1 questions');

  // « Annuler » jette toutes les modifications de la session.
  await page.getByRole('button', { name: `Modifier ${renamed}`, exact: true }).click();
  await page.getByRole('textbox', { name: 'Titre' }).fill(`${title} (jeté)`);
  await page.getByRole('button', { name: 'Supprimer la question' }).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(page.getByText('Première question modifiée')).toBeHidden();
  await page.getByRole('button', { name: 'Annuler' }).click();
  await expect(quizRow(page, renamed)).toContainText('1 questions');
  await expect(quizRow(page, `${title} (jeté)`)).toHaveCount(0);

  // Persisté côté serveur : rouvert après rechargement.
  await page.reload();
  await openEditor(page);
  await page.getByRole('button', { name: `Modifier ${renamed}`, exact: true }).click();
  await expect(page.getByText('Première question modifiée')).toBeVisible();
  await expect(page.getByText('Seconde question')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retour' }).click();

  // Supprimer le quiz (confirmation).
  await quizRow(page, renamed).click();
  await page.getByRole('button', { name: `Supprimer ${renamed}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Supprimer le quiz ?' })).toBeVisible();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(quizRow(page, renamed)).toHaveCount(0);
  const res = await api.get('/api/courses/1/quizzes/manage');
  const titles = ((await res.json()) as { title: string }[]).map((q) => q.title);
  expect(titles).not.toContain(renamed);
});

// Garde : le titre et les interrupteurs saisis dans « Nouveau quiz » / « Modifier le quiz » sont
// conservés quand on ouvre l'éditeur de question puis revient (QuizFormBody est démonté ; ses méta
// sont gardées en mémoire par QuizEditor via onStashMeta).
test('les méta du quiz survivent à l’ajout d’une question', async ({ browser }) => {
  const page = await profPage(browser);
  await openEditor(page);
  await page.getByRole('button', { name: 'Créer un quiz' }).click();
  await page.getByRole('textbox', { name: 'Titre' }).fill('Titre saisi en premier');
  await page.getByRole('switch', { name: 'Publié' }).click();
  await startQuestion(page, 'Vrai/Faux', 'Une question.', 1);
  await addButton(page).click();
  await expect(page.getByRole('heading', { name: 'Nouveau quiz' })).toBeVisible();
  await expect(page.getByText('Une question.')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Publié' })).toHaveAttribute(
    'aria-checked',
    'true',
    {
      timeout: 2_000,
    }
  );
  await expect(page.getByRole('textbox', { name: 'Titre' })).toHaveValue('Titre saisi en premier', {
    timeout: 2_000,
  });
  await page.context().close();
});

test('réordonner les quiz par glisser-déposer (poignée)', async ({ browser }) => {
  const first = quizTitle('Ordre A');
  const second = quizTitle('Ordre B');
  await createQuizApi(api, { title: first, isPublished: false, questions: twoQuestions('a', 'b') });
  await createQuizApi(api, {
    title: second,
    isPublished: false,
    questions: twoQuestions('a', 'b'),
  });
  const page = await profPage(browser);
  await openEditor(page);

  const order = async () => {
    const res = await api.get('/api/courses/1/quizzes/manage');
    const titles = ((await res.json()) as { title: string }[]).map((q) => q.title);
    return [titles.indexOf(first), titles.indexOf(second)];
  };
  const [a, b] = await order();
  expect(a).toBeLessThan(b);

  // La poignée (span aria-hidden, Pointer Events) est le premier enfant de la ligne.
  const grip = quizRow(page, second).locator('> span').first();
  await pointerDrag(page, grip, quizRow(page, first));

  await expect.poll(order).toEqual([b, a]);
  // L'ordre persisté se retrouve à la réouverture.
  await page.reload();
  await openEditor(page);
  const rows = page.locator('[data-reorder-id]');
  await expect(rows.filter({ hasText: second })).toBeVisible();
  const texts = await rows.allInnerTexts();
  expect(texts.findIndex((t) => t.includes(second))).toBeLessThan(
    texts.findIndex((t) => t.includes(first))
  );
});

test('temps réel : l’étudiant voit la mise à jour puis la suppression du quiz ouvert', async ({
  browser,
  baseURL,
}) => {
  const title = quizTitle('Direct');
  await createQuizApi(api, {
    title,
    isPublished: true,
    questions: twoQuestions('Énoncé initial', 'Autre question'),
  });

  const student = await studentPage(browser, baseURL!);
  const studentNav = await openTestCourse(student);
  await studentNav.getByRole('button', { name: title }).click();
  const studentMain = mainContent(student);
  await expect(studentMain).toContainText('Énoncé initial');

  const page = await profPage(browser);
  await openEditor(page);
  await page.getByRole('button', { name: `Modifier ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Modifier la question' }).nth(0).click();
  await fillPrompt(page, 'Énoncé mis à jour en direct');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();

  // quiz:updated : la vue ouverte se recharge sans action de l'étudiant.
  await expect(studentMain).toContainText('Énoncé mis à jour en direct');

  // quiz:deleted : la vue se ferme et le quiz quitte la barre latérale.
  await page.getByRole('button', { name: 'Retour' }).click();
  await page.getByRole('button', { name: `Supprimer ${title}`, exact: true }).click();
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
  await expect(studentMain.getByRole('heading', { name: 'Aucun canal sélectionné' })).toBeVisible();
  await expect(studentNav.getByRole('button', { name: title })).toHaveCount(0);
  await student.context().close();
  await page.context().close();
});

test('un étudiant n’a pas accès à l’éditeur de quiz', async ({ browser, baseURL }) => {
  const student = await studentPage(browser, baseURL!);
  const studentQuiz = (await openTestCourse(student)).getByRole('region', { name: 'QUIZ' });
  await expect(studentQuiz.getByRole('button', { name: 'QUIZ', exact: true })).toBeVisible();
  await expect(studentQuiz.getByRole('button', { name: 'Modifier la section QUIZ' })).toHaveCount(
    0
  );
  await student.context().close();

  // Témoin : l'Enseignant, lui, a le crayon.
  const page = await profPage(browser);
  const profNav = await openTestCourse(page);
  await expect(profNav.getByRole('button', { name: 'Modifier la section QUIZ' })).toBeVisible();
  await page.context().close();
});
