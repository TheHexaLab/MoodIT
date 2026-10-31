import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { TEST_PROGRAM_ID } from '../setup/accounts';

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/** Cours du seed rattachés au programme de test (démo, db/demo) ; le 1 (MAT115) est déjà suivi. */
export const SECOND_COURSE = {
  id: 2,
  code: 'GIF201',
  title: 'Structures de données et algorithmes',
  channel: 'Discussion — Structures de données et algorithmes',
};

/**
 * Inscrit un compte aux cours `courseIds` du programme de test (la liste REMPLACE ses
 * inscriptions dans ce programme). Sert à avoir plusieurs cours dans le sélecteur sans en créer.
 */
export async function enrollInCourses(
  baseURL: string,
  storageState: StorageState,
  userId: number,
  courseIds: number[]
) {
  const ctx = await request.newContext({ baseURL, storageState });
  try {
    const res = await ctx.post('/api/courses/users', {
      data: { id: userId, courseIds, programId: TEST_PROGRAM_ID },
    });
    expect(res.ok(), `inscription aux cours ${courseIds} : HTTP ${res.status()}`).toBe(true);
  } finally {
    await ctx.dispose();
  }
}

/**
 * S'assure que le sélecteur de cours affiche `code` (clic, disposition desktop). Le front prend
 * `courses[0]` par défaut, or `User.enrollments` n'a pas d'`@OrderBy` : après un remplacement des
 * inscriptions (`POST /api/courses/users`), Postgres peut renvoyer GIF201 avant MAT115 — l'ordre
 * du sélecteur n'est donc pas déterministe (défaut à corriger côté core-service).
 */
export async function ensureCourse(page: Page, code: string) {
  const picker = page.getByRole('navigation', { name: 'Cours' }).locator('button[aria-haspopup="listbox"]');
  await expect(picker).toBeVisible();
  if ((await picker.innerText()).trim() !== code) {
    await picker.click();
    await page.getByRole('option', { name: new RegExp(`^${code} `) }).click();
  }
  await expect(picker).toHaveText(code);
}

/** Réglages utilisateur tels qu'envoyés à PUT /api/me/settings (blob JSON du front). */
export interface SentSettings {
  theme?: 'light' | 'dark';
  location?: { programId?: number; courseId?: number; channel?: { id: number; type: string } };
}

/**
 * Attend une sauvegarde des réglages (PUT /api/me/settings, debouncée 1 s) dont le corps
 * satisfait `accept`, et vérifie qu'elle a réussi. À appeler AVANT l'action qui la déclenche.
 */
export function settingsSaved(page: Page, accept: (s: SentSettings) => boolean) {
  return page
    .waitForResponse((res) => {
      if (!res.url().endsWith('/api/me/settings') || res.request().method() !== 'PUT') {
        return false;
      }
      try {
        return accept(JSON.parse(res.request().postData() ?? '{}') as SentSettings);
      } catch {
        return false;
      }
    })
    .then((res) => expect(res.ok(), `PUT /api/me/settings : HTTP ${res.status()}`).toBe(true));
}
