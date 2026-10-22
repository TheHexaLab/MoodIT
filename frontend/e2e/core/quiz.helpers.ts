import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { TEST_COURSE_ID } from '../setup/accounts';
import { PROGRAM_NAME, ROLE_ACCOUNTS, sessionAs } from './helpers';

/** Code du cours de test (cours 1 du seed). */
export const COURSE_CODE = 'MAT115';

/**
 * Ouvre le programme de test et s'assure que le cours MAT115 est sélectionné : le dernier cours
 * ouvert est restauré par compte, et un compte partagé a pu en ouvrir un autre entre-temps.
 */
export async function openTestCourse(page: Page) {
  await page.goto('/home');
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  const nav = page.getByRole('navigation', { name: 'Cours' });
  const picker = nav.locator('button[aria-haspopup="listbox"]');
  await expect(picker).toBeVisible();
  if ((await picker.innerText()).trim() !== COURSE_CODE) {
    await picker.click();
    await page.getByRole('option', { name: new RegExp(`^${COURSE_CODE}`) }).click();
  }
  await expect(picker).toHaveText(COURSE_CODE);
  return nav;
}

/**
 * Session de l'Enseignant du programme 1 : état de session (pour `browser.newContext`) + contexte
 * API. Une SEULE connexion par fichier : l'auth n'accepte qu'un jeton actif par compte, chaque
 * connexion révoque la précédente (les pages et l'API doivent donc partager ce même jeton).
 */
export async function profSession(baseURL: string) {
  const { storageState } = await sessionAs(baseURL, ROLE_ACCOUNTS.prof);
  const api = await request.newContext({ baseURL, storageState });
  return { storageState, api };
}

/**
 * Choisit une option d'une liste déroulante de l'éditeur (bouton aria-haspopup + listbox portée).
 * Réessaie : le menu se referme au moindre défilement du corps du popup, qui peut encore s'animer
 * (changement de hauteur) juste après l'ouverture d'une vue.
 */
export async function pickOption(page: Page, control: string, option: string) {
  const button = page.getByRole('button', { name: control, exact: true });
  await expect(async () => {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    await page.getByRole('option', { name: option, exact: true }).click({ timeout: 2_000 });
  }).toPass();
  await expect(button).toHaveText(option);
}

/** Question telle qu'envoyée par l'éditeur (POST /api/courses/{id}/quizzes). */
export interface QuestionPayload {
  qType: 'true_false' | 'single_choice' | 'multiple_choice' | 'ordering' | 'matching' | 'coding';
  prompt: string;
  totalScore: number;
  answers?: { content: string; isCorrect: boolean }[];
  dragItems?: { content: string; correctOrder: number; groupName?: string | null }[];
  language?: { id: number; name: string };
  startCode?: string;
  testCases?: { name: string; harnessCode: string; weight: number }[];
}

/** Id du langage Python (seul installé dans le Piston de la pile E2E). */
export async function pythonLanguage(api: APIRequestContext) {
  const res = await api.get('/api/languages');
  expect(res.ok()).toBe(true);
  const languages = (await res.json()) as { id: number; name: string }[];
  const python = languages.find((l) => l.name === 'Python');
  expect(python, 'langage Python').toBeDefined();
  return { id: python!.id, name: python!.name };
}

/**
 * Crée un quiz complet dans MAT115 par l'API (même payload que l'éditeur) : pour les tests côté
 * étudiant qui n'ont pas à repasser par l'éditeur. Renvoie l'id du quiz.
 */
export async function createQuizApi(
  api: APIRequestContext,
  quiz: { title: string; isPublished?: boolean; allowRetry?: boolean; questions: QuestionPayload[] }
): Promise<number> {
  const res = await api.post(`/api/courses/${TEST_COURSE_ID}/quizzes`, {
    data: {
      title: quiz.title,
      isPublished: quiz.isPublished ?? true,
      isDaily: false,
      allowRetry: quiz.allowRetry ?? false,
      questions: quiz.questions.map((q, i) => ({ ...q, orderIndex: i })),
    },
  });
  expect(res.ok(), `création du quiz : HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

/**
 * Supprime (nettoyage) les quiz de MAT115 dont le titre contient `marker`. Avec `baseURL`, rouvre
 * une session prof si le jeton de `api` a été révoqué entre-temps.
 */
export async function deleteQuizzesMatching(
  api: APIRequestContext,
  marker: string,
  baseURL?: string
): Promise<void> {
  const res = await api.get(`/api/courses/${TEST_COURSE_ID}/quizzes/manage`);
  if (!res.ok()) {
    // Jeton révoqué (le compte prof est partagé) : une nouvelle session pour ne rien laisser traîner.
    if (res.status() !== 401 || !baseURL) return;
    const fresh = await profSession(baseURL);
    await deleteQuizzesMatching(fresh.api, marker);
    await fresh.api.dispose();
    return;
  }
  const quizzes = (await res.json()) as { id: number; title: string }[];
  for (const q of quizzes.filter((x) => x.title.includes(marker))) {
    await api.delete(`/api/quizzes/${q.id}`);
  }
}

/**
 * Glisse `source` sur `target` par Pointer Events (souris), en plusieurs étapes : les composants
 * repèrent la cible via elementFromPoint à chaque pointermove. Le survol initial attend que la
 * source soit stable (les popups s'ouvrent avec une animation d'échelle).
 *
 * Chaque étape laisse React rendre avant la suivante (flushReactUpdates) : le réordonnancement
 * déplace l'élément « à l'index de la ligne survolée » dans l'état courant, en supposant que le
 * DOM reflète déjà ce dernier. Sans rendu intermédiaire (WebKit traite les 10 pas en ~10 ms),
 * deux événements de suite sur la même ligne le renvoient d'où il vient.
 */
export async function pointerDrag(page: Page, source: Locator, target: Locator) {
  await source.hover();
  const from = await center(source);
  await page.mouse.down();
  await page.mouse.move(from.x + 2, from.y + 2, { steps: 2 });
  const start = { x: from.x + 2, y: from.y + 2 };
  const to = await center(target);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      start.x + ((to.x - start.x) * i) / steps,
      start.y + ((to.y - start.y) * i) / steps
    );
    await flushReactUpdates(page);
  }
  await page.mouse.up();
}

/**
 * Laisse React appliquer les mises à jour d'état issues des `pointermove` AVANT le relâchement.
 * React les traite en priorité « continue » : rendu reporté à une tâche de son ordonnanceur
 * (MessageChannel), puis effets passifs (ex. la ref d'ordre lue au `pointerup`) dans une seconde
 * tâche. Sur WebKit, Playwright enchaîne `mouse.up` quelques ms après le dernier `mouse.move`,
 * avant ces tâches : les composants lisent alors un ordre périmé et ne persistent rien (Chromium
 * et Firefox laissent passer les tâches entre deux commandes). On enchaîne des allers-retours
 * MessageChannel (même source de tâches que React, donc FIFO) jusqu'à ce qu'un cycle n'observe
 * plus aucune mutation du DOM : ce cycle, posté après le commit, passe aussi après ses effets.
 */
async function flushReactUpdates(page: Page) {
  await page.evaluate(async () => {
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const tick = () =>
      new Promise<void>((resolve) => {
        const { port1, port2 } = new MessageChannel();
        port1.onmessage = () => resolve();
        port2.postMessage(null);
      });
    try {
      for (let i = 0; i < 20; i++) {
        const before = mutations;
        await tick();
        await tick();
        if (mutations === before) return;
      }
    } finally {
      observer.disconnect();
    }
  });
}

/** Centre de la boîte d'un élément visible. */
async function center(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'élément visible').not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}
