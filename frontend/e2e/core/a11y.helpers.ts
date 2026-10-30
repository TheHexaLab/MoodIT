import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  request,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { ROLE_ACCOUNTS } from './helpers';
import {
  apiAs,
  assignProgramRoleApi,
  createCourseApi,
  createProgramApi,
  deleteCourseApi,
  deleteProgramApi,
  enrollApi,
  freshAccount,
  roleId,
  type TestProgram,
} from './admin.helpers';

/**
 * Aides des specs d'accessibilité (a11y, clavier, focus visible). Comme pour les specs de
 * gestion, la préparation passe par l'API : un programme + un cours NEUFS, un Administrateur de
 * programme NEUF (toutes les popups d'édition) et un quiz aux 6 types de question.
 */

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** Règles WCAG 2.0 / 2.1 niveaux A et AA (ce que l'application vise). */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Une violation axe aplatie : une ligne par élément fautif. */
export interface Violation {
  rule: string;
  impact: string;
  target: string;
  help: string;
}

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/**
 * Audit axe de la page courante. Toutes les violations sont tracées sur la sortie standard
 * (`A11Y|écran|thème|règle|impact|cible`) pour l'inventaire ; seules celles d'impact « serious »
 * ou « critical » font échouer (assertion douce : l'écran suivant est audité quand même).
 */
export async function auditScreen(page: Page, screen: string, theme: Theme): Promise<Violation[]> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const flat: Violation[] = results.violations.flatMap((v) =>
    v.nodes.map((n) => ({
      rule: v.id,
      impact: v.impact ?? 'unknown',
      target: n.target.map(String).join(' ') + contrastDetail(v.id, n.any[0]?.data),
      help: v.help,
    }))
  );
  for (const v of flat) {
    console.log(`A11Y|${screen}|${theme}|${v.rule}|${v.impact}|${v.target}`);
  }
  const blocking = flat.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  // Une ligne par écran, même sans violation : prouve que l'écran a bien été audité.
  console.log(`A11Y-SCREEN|${screen}|${theme}|${blocking.length}|${flat.length}`);
  expect
    .soft(
      blocking.map((v) => `${v.rule} [${v.impact}] ${v.target}`),
      `${screen} (${theme}) : violations axe sérieuses/critiques`
    )
    .toEqual([]);
  return blocking;
}

/** Pour `color-contrast` : couleurs et ratio mesurés, à ajuster dans les variables de thème. */
function contrastDetail(rule: string, data: unknown): string {
  if (rule !== 'color-contrast' || !data) return '';
  const d = data as { fgColor?: string; bgColor?: string; contrastRatio?: number };
  return ` (${d.fgColor} sur ${d.bgColor} : ${d.contrastRatio}:1)`;
}

/**
 * Attend la fin des animations finies (ouverture d'une popup, fermeture d'un menu…) : en plein
 * fondu, le texte est mélangé au fond et axe mesurerait un contraste transitoire. Les animations
 * infinies (spinners) sont ignorées ; 2 s au plus.
 */
async function settleAnimations(page: Page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.race([
      Promise.allSettled(finite.map((a) => a.finished)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
}

/**
 * Thème des pages PUBLIQUES (avant connexion) : le cache local `moodit-theme` est lu au
 * démarrage ; pour un compte connecté, la BD l'emporte (voir `setThemeInDb`).
 */
export async function seedTheme(context: BrowserContext, theme: Theme) {
  await context.addInitScript((t) => localStorage.setItem('moodit-theme', t), theme);
}

/** Persiste le thème d'un compte NEUF (PUT /api/me/settings) : il s'applique au chargement. */
export async function setThemeInDb(baseURL: string, storageState: StorageState, theme: Theme) {
  const api = await request.newContext({ baseURL, storageState });
  try {
    const res = await api.put('/api/me/settings', { data: { theme } });
    expect(res.ok(), `PUT /api/me/settings : HTTP ${res.status()}`).toBe(true);
  } finally {
    await api.dispose();
  }
}

/** Vérifie que le thème attendu est bien rendu (attribut `data-theme` de <html>). */
export const expectTheme = (page: Page, theme: Theme) =>
  expect(page.locator('html')).toHaveAttribute('data-theme', theme);

/**
 * Session gardien courte (le compte est partagé : une connexion par étape). Son jeton est unique :
 * si une autre spec se connecte au même moment, le nôtre est révoqué (HTTP 401) ; on se reconnecte
 * alors et on recommence l'action, deux fois au plus.
 */
export async function asGardien<T>(
  baseURL: string,
  action: (api: APIRequestContext) => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const api = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
    try {
      return await action(api);
    } catch (error) {
      if (attempt >= 3 || !String(error).includes('HTTP 401')) throw error;
    } finally {
      await api.dispose();
    }
  }
}

export interface ProgramFixture {
  program: TestProgram;
  course: { id: number; code: string; title: string };
  /** Administrateur du programme (compte neuf) : gère contenu, cours, programme et rôles. */
  admin: Awaited<ReturnType<typeof freshAccount>>;
  cleanup: () => Promise<void>;
}

/**
 * Programme + cours neufs (gardien), et un compte neuf Administrateur du programme, inscrit au
 * cours. Son client API reste ouvert (même jeton que son `storageState`).
 */
export async function createProgramFixture(baseURL: string, prefix = 'A11y'): Promise<ProgramFixture> {
  const admin = await freshAccount(baseURL);
  const { program, course } = await asGardien(baseURL, async (api) => {
    const program = await createProgramApi(api, prefix);
    const course = await createCourseApi(api, [program.id], prefix.slice(0, 2));
    await assignProgramRoleApi(api, program.id, admin.user.id, 'Administrateur');
    return { program, course };
  });
  await enrollApi(admin.api, program.id, [course.id]);
  return {
    program,
    course,
    admin,
    cleanup: async () => {
      await admin.api.dispose();
      await asGardien(baseURL, async (api) => {
        await deleteCourseApi(api, course.id);
        await deleteProgramApi(api, program.id);
      });
    },
  };
}

/**
 * Compte NEUF promu Gardien (rôle global) par le gardien du bootstrap, pour exercer ses écrans
 * sans dépendre de la session partagée (révoquée par toute connexion concurrente). `cleanup`
 * lui retire le rôle. Le compte lui-même reste (comme tout compte neuf de la suite).
 */
export async function createGuardianAccount(baseURL: string) {
  const account = await freshAccount(baseURL);
  const change = (type: 'assign' | 'unassign') =>
    asGardien(baseURL, async (api) => {
      const res = await api.post('/api/roles/global/change', {
        data: { type, roleId: await roleId(api, 'Gardien', 'global'), userId: account.user.id },
      });
      expect(res.ok(), `rôle Gardien (${type}) : HTTP ${res.status()}`).toBe(true);
    });
  await change('assign');
  return {
    ...account,
    cleanup: async () => {
      await account.api.dispose();
      await change('unassign');
    },
  };
}

/** Compte neuf (sans abonnement) inscrit au programme et au cours de la fixture. */
export async function enrolledStudent(baseURL: string, fixture: ProgramFixture) {
  const student = await freshAccount(baseURL);
  await enrollApi(student.api, fixture.program.id, [fixture.course.id]);
  return student;
}

/** Énoncés des 6 questions du quiz de test, dans l'ordre (une par type). */
export const SIX_TYPES = [
  ['Vrai/Faux', 'Le ciel est bleu.'],
  ['Choix unique', 'Capitale du Canada ?'],
  ['Choix multiple', 'Nombres pairs ?'],
  ['Remise en ordre', 'Ordonne du plus petit au plus grand.'],
  ['Association', 'Associe chaque animal à sa classe.'],
  ['Code', 'Écris `solution(a, b)` qui renvoie a + b.'],
] as const;

export const START_CODE = 'def solution(a, b):\n    return 0\n';

/**
 * Quiz publié aux 6 types de question dans le cours donné (même payload que l'éditeur). Reprises
 * autorisées, pour que le résumé propose « Refaire le quiz ».
 */
export async function createSixTypeQuiz(api: APIRequestContext, courseId: number, title: string) {
  const languages = (await (await api.get('/api/languages')).json()) as {
    id: number;
    name: string;
  }[];
  const python = languages.find((l) => l.name === 'Python');
  expect(python, 'langage Python').toBeDefined();
  const tf = (content: string, isCorrect: boolean) => ({ content, isCorrect });
  const questions = [
    { qType: 'true_false', prompt: SIX_TYPES[0][1], totalScore: 1, answers: [tf('Vrai', true), tf('Faux', false)] },
    { qType: 'single_choice', prompt: SIX_TYPES[1][1], totalScore: 2, answers: [tf('Ottawa', true), tf('Toronto', false)] },
    { qType: 'multiple_choice', prompt: SIX_TYPES[2][1], totalScore: 1, answers: [tf('2', true), tf('3', false), tf('4', true)] },
    {
      qType: 'ordering',
      prompt: SIX_TYPES[3][1],
      totalScore: 2,
      dragItems: ['Un', 'Deux', 'Trois'].map((content, i) => ({ content, correctOrder: i })),
    },
    {
      qType: 'matching',
      prompt: SIX_TYPES[4][1],
      totalScore: 2,
      dragItems: [
        { content: 'Chat', correctOrder: 0, groupName: 'Mammifère' },
        { content: 'Aigle', correctOrder: 1, groupName: 'Oiseau' },
      ],
    },
    {
      qType: 'coding',
      prompt: SIX_TYPES[5][1],
      totalScore: 3,
      language: { id: python!.id, name: python!.name },
      startCode: START_CODE,
      testCases: [{ name: 'Somme de deux entiers', harnessCode: 'return solution(2, 3) == 5', weight: 1 }],
    },
  ].map((q, orderIndex) => ({ ...q, orderIndex }));
  const res = await api.post(`/api/courses/${courseId}/quizzes`, {
    data: { title, isPublished: true, isDaily: false, allowRetry: true, questions },
  });
  expect(res.ok(), `création du quiz : HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: number }).id;
}

/**
 * Colle `text` dans `target` par le VRAI presse-papiers : copie depuis un champ temporaire
 * (Ctrl+A, Ctrl+C) puis Ctrl+V dans la cible. Un `ClipboardEvent` synthétique n'est pas vu par
 * Firefox ; ce chemin passe par le gestionnaire `onPaste` réel sur les trois moteurs.
 */
export async function pasteFromClipboard(page: Page, target: Locator, text: string) {
  await page.evaluate((value) => {
    const input = document.createElement('input');
    input.id = 'e2e-clipboard-source';
    input.value = value;
    document.body.appendChild(input);
  }, text);
  await page.locator('#e2e-clipboard-source').focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await page.evaluate(() => document.getElementById('e2e-clipboard-source')?.remove());
  await target.focus();
  await page.keyboard.press('ControlOrMeta+V');
}

/** Description courte de l'élément focalisé (pour les messages d'échec). */
export const focusedDescription = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
    return `${el.tagName.toLowerCase()}[role=${el.getAttribute('role') ?? '-'}] « ${name} »`;
  });

/** La popup (titre `title`) contient-elle l'élément focalisé ? */
export const popupHasFocus = (page: Page, title: string) =>
  page.evaluate((name) => {
    const heading = [...document.querySelectorAll('h1, h2, h3')].find(
      (h) => h.textContent?.trim() === name
    );
    if (!heading) return false;
    let root: HTMLElement | null = heading as HTMLElement;
    while (root && getComputedStyle(root).position !== 'fixed') root = root.parentElement;
    return root ? root.contains(document.activeElement) : false;
  }, title);

/**
 * Indicateur de focus visible sur l'élément focalisé : contour (`outline`) non nul OU ombre
 * portée (`box-shadow`), sur l'élément lui-même ou sur un pseudo-élément `::before` / `::after`
 * (la poignée de redimensionnement révèle ainsi un trait coloré). Le contour par défaut du
 * navigateur (`outline-style: auto`) compte. Un simple changement de couleur de bordure, non.
 */
export async function hasVisibleFocusIndicator(locator: Locator) {
  return locator.evaluate((el) => {
    const marks = (s: CSSStyleDeclaration) => ({
      outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0,
      shadow: s.boxShadow !== 'none' && s.boxShadow !== '',
    });
    const opaque = (color: string) => !/^rgba\(.*, 0\)$/.test(color) && color !== 'transparent';
    const own = marks(getComputedStyle(el));
    const pseudo = ['::before', '::after'].some((p) => {
      const s = getComputedStyle(el, p);
      if (s.content === 'none') return false;
      const m = marks(s);
      return m.outline || m.shadow || opaque(s.backgroundColor);
    });
    const s = getComputedStyle(el);
    return {
      visible: own.outline || own.shadow || pseudo,
      outline: `${s.outlineStyle} ${s.outlineWidth}`,
      boxShadow: s.boxShadow,
      pseudo,
    };
  });
}

/**
 * Place le focus sur le premier élément focalisable de la popup (titre `title`) et renvoie le
 * nombre d'éléments focalisables qu'elle contient (0 si la popup est introuvable).
 */
export const focusFirstInPopup = (page: Page, title: string) =>
  page.evaluate((name) => {
    const heading = [...document.querySelectorAll('h1, h2, h3')].find(
      (h) => h.textContent?.trim() === name
    );
    let root: HTMLElement | null = (heading as HTMLElement | undefined) ?? null;
    while (root && getComputedStyle(root).position !== 'fixed') root = root.parentElement;
    if (!root) return 0;
    const focusable = [
      ...root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ),
    ];
    focusable[0]?.focus();
    return focusable.length;
  }, title);
