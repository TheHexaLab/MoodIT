import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { TEST_PROGRAM_ID } from '../setup/accounts';
import { apiAs, assignProgramRoleApi, courseSelector, roleId } from './admin.helpers';
import { PROGRAM_NAME, ROLE_ACCOUNTS, createEnrolledUser } from './helpers';
import { enrollInCourses } from './dashboard.helpers';

/**
 * Aides de la suite responsive (e2e/core/responsive). Les tests tournent sur les 8 profils de
 * playwright.core.config.ts : ils ne supposent jamais une disposition, ils la DÉDUISENT de la
 * largeur du viewport (`layoutOf`) et branchent dessus.
 *
 * Points de rupture du frontend (lus dans les CSS) :
 *  - ≤ 900 px (56.25rem, LeftMenuGroup / CourseMenu / UserMenu / QuizView) : barre latérale en
 *    tiroir « Menus lateraux » (90 vw, translatée hors écran), barre mobile fixe de 3.25rem avec
 *    hamburger « Ouvrir le menu » et pastille compte compacte ; pied de page du compte masqué ;
 *    poignée de redimensionnement masquée ; menu du compte en feuille basse ; points de
 *    progression et « Retour au résumé » du quiz masqués.
 *  - ≤ 768 px (48rem, ChannelView / ForumView) : actions des messages / posts flottantes,
 *    révélées au toucher ; vote du sujet déplacé sous le post (`[data-role="mobile-vote"]`).
 *    < 768 px : marges réduites des popups (`@media (min-width: 768px)`).
 *  - ≤ 480 px (30rem) : contexte de cours masqué dans les en-têtes, actions des états vides
 *    empilées, actions des lignes de l'éditeur de quiz flottantes.
 *  - ≤ 360 px (22.5rem) : palettes de couleur en colonne, cases du code 2FA réduites.
 *  - `(hover: none)` (tablettes et téléphones, quelle que soit la largeur) : les actions d'un
 *    message de chat n'apparaissent qu'au toucher de la ligne.
 *  - 1024 px : aucune règle propre dans l'application (App.css n'est pas importé) ; la tablette
 *    paysage se comporte comme un bureau tactile (barre fixe + `hover: none`).
 */

export const CHANNEL_NAME = 'Discussion — Mathématiques pour ingénieurs I';
/** Cours MCP100 du seed (programme 1) : porte le quiz « Quiz noté — exercice de code ». */
export const CODE_COURSE = { id: 3, code: 'MCP100', quiz: 'Quiz noté — exercice de code' };

export interface Layout {
  width: number;
  height: number;
  /** ≤ 900 px : barre latérale en tiroir + barre mobile fixe. */
  drawer: boolean;
  /** ≤ 768 px : actions de chat / forum flottantes, vote mobile. */
  dense: boolean;
  /** ≤ 480 px : en-têtes sans contexte de cours, actions empilées. */
  narrow: boolean;
}

export function layoutOf(page: Page): Layout {
  const { width, height } = page.viewportSize()!;
  return { width, height, drawer: width <= 900, dense: width <= 768, narrow: width <= 480 };
}

export const banner = (page: Page) => page.getByRole('banner');
export const drawer = (page: Page) => page.getByRole('complementary', { name: 'Menus lateraux' });
export const courseNav = (page: Page) => page.getByRole('navigation', { name: 'Cours' });
export const resizeHandle = (page: Page) =>
  page.getByRole('separator', { name: 'Redimensionner le menu des cours' });
/** Sélecteur de cours (bouton aria-haspopup="listbox"), quel que soit le cours actif. */
export const coursePicker = (page: Page) => courseNav(page).locator('button[aria-haspopup="listbox"]');

/** Clic ou toucher selon le profil : les parcours « au tactile » passent par `tap`. */
export const press = (locator: Locator, hasTouch: boolean) =>
  hasTouch ? locator.tap() : locator.click();

/**
 * Ouvre le tiroir des menus (disposition ≤ 900 px) et attend la fin de sa translation. La
 * disposition est déduite du viewport (et non de la présence du hamburger : juste après un
 * `goto`, le DOM peut ne pas être rendu encore) ; on attend ensuite le hamburger.
 */
export async function openDrawer(page: Page, hasTouch = false) {
  if (!layoutOf(page).drawer) return;
  // Déjà ouvert : le hamburger est devenu « Fermer le menu » (masqué, aria-expanded=true).
  const hamburger = banner(page).getByRole('button', { name: /^(Ouvrir|Fermer) le menu$/ });
  await expect(hamburger).toHaveAttribute('aria-expanded', /true|false/);
  if ((await hamburger.getAttribute('aria-expanded')) !== 'true') {
    await press(banner(page).getByRole('button', { name: 'Ouvrir le menu' }), hasTouch);
  }
  await expect(drawer(page)).toBeInViewport({ ratio: 1 });
}

/**
 * Referme le tiroir comme l'utilisateur : toucher sur le fond assombri, dans la bande de 10 vw
 * que le tiroir (90 vw) laisse à droite. Le hamburger, lui, est masqué et sous le tiroir.
 */
export async function closeDrawer(page: Page, hasTouch = false) {
  if (!layoutOf(page).drawer) return;
  const hamburger = banner(page).getByRole('button', { name: /^(Ouvrir|Fermer) le menu$/ });
  await expect(hamburger).toHaveAttribute('aria-expanded', /true|false/);
  if ((await hamburger.getAttribute('aria-expanded')) !== 'true') return;
  const { width, height } = page.viewportSize()!;
  const backdrop = page.getByRole('button', { name: 'Fermer le menu' }).last();
  const position = { x: width - 4, y: height / 2 };
  await (hasTouch ? backdrop.tap({ position }) : backdrop.click({ position }));
  await expectDrawerClosed(page);
}

/**
 * Tiroir fermé = translaté hors écran (bord droit ≤ 1 px). Tolérance nécessaire : `90vw` n'est
 * pas entier (691,2 px à 768 px) et WebKit rapporte alors un ratio d'intersection non nul.
 */
export async function expectDrawerClosed(page: Page, timeout?: number) {
  await expect
    .poll(
      async () => {
        const box = await drawer(page).boundingBox();
        return box ? box.x + box.width : 0;
      },
      { message: 'bord droit du tiroir (fermé : hors écran)', timeout }
    )
    .toBeLessThanOrEqual(1);
}

/**
 * Sélectionne un programme dans le rail (en ouvrant le tiroir au besoin, puis en le refermant).
 * `courses: false` pour un programme sans cours suivi (pas de sélecteur de cours).
 */
export async function selectProgram(
  page: Page,
  name: string,
  hasTouch = false,
  { courses = true }: { courses?: boolean } = {}
) {
  await openDrawer(page, hasTouch);
  const program = page.getByRole('navigation', { name: 'Programme' }).getByRole('button', { name });
  await press(program, hasTouch);
  await expect(program).toHaveAttribute('aria-current', 'page');
  if (courses) await expect(coursePicker(page)).toBeVisible();
  else await expect(courseNav(page).getByText('Aucun cours', { exact: true })).toBeVisible();
  await closeDrawer(page, hasTouch);
}

/** Ouvre un élément de la barre du cours (canal, forum, quiz) et referme le tiroir. */
export async function openSidebarItem(page: Page, name: string, hasTouch = false) {
  await openDrawer(page, hasTouch);
  const item = courseNav(page).getByRole('button', { name });
  await press(item, hasTouch);
  await expect(item).toHaveAttribute('aria-current', 'page');
  await closeDrawer(page, hasTouch);
}

/** Change de cours par le sélecteur (listbox portée dans <body>) et referme le tiroir. */
export async function pickCourse(page: Page, code: string, hasTouch = false) {
  await openDrawer(page, hasTouch);
  await expect(coursePicker(page)).toBeVisible(); // le texte lu ensuite doit être celui du sélecteur rendu
  if ((await coursePicker(page).innerText()).trim() !== code) {
    await press(coursePicker(page), hasTouch);
    await press(page.getByRole('option', { name: new RegExp(`^${code} `) }), hasTouch);
  }
  await expect(courseSelector(page, code)).toBeVisible();
  await closeDrawer(page, hasTouch);
}

/**
 * Appui long (500 ms) sur le sélecteur de cours → menu contextuel « Actions du cours … ».
 * Playwright n'a pas de geste tactile maintenu (`page.touchscreen` ne fait que `tap`) : on
 * dispatche nous-mêmes `touchstart`, attendons l'ouverture (minuteur de CourseMenu), puis
 * `touchend`. Le composant ne lit que `currentTarget`, un TouchEvent sans point suffit.
 */
export async function longPressCourseSelector(page: Page, code: string) {
  const picker = courseSelector(page, code);
  await picker.dispatchEvent('touchstart');
  const menu = page.getByRole('menu', { name: `Actions du cours ${code}` });
  await expect(menu).toBeVisible();
  await picker.dispatchEvent('touchend');
  return menu;
}

/** Compte étudiant NEUF (programme 1 + MAT115, et d'autres cours au besoin), page sur /home. */
export async function studentPage(browser: Browser, baseURL: string, extraCourseIds: number[] = []) {
  const { user, storageState } = await createEnrolledUser(baseURL);
  if (extraCourseIds.length > 0) {
    await enrollInCourses(baseURL, storageState, user.id, [1, ...extraCourseIds]);
  }
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  return { user, context, page };
}

/**
 * Compte NEUF, Administrateur du programme 1 (rôle donné par le gardien via l'API) : ouvre tous
 * les popups de gestion (cours, programme, rôles, sections, MCP, éditeur de quiz) sans toucher
 * aux rôles des comptes partagés. `revoke` retire le rôle en fin de test.
 */
export async function programAdminPage(browser: Browser, baseURL: string) {
  const { user, storageState } = await createEnrolledUser(baseURL);
  const gardien = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
  try {
    await assignProgramRoleApi(gardien, TEST_PROGRAM_ID, user.id, 'Administrateur');
  } finally {
    await gardien.dispose();
  }
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  const revoke = async () => {
    const api = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
    try {
      await api.post('/api/roles/change', {
        data: {
          type: 'unassign',
          roleId: await roleId(api, 'Administrateur', 'program'),
          userId: user.id,
          programId: TEST_PROGRAM_ID,
        },
      });
    } finally {
      await api.dispose();
    }
  };
  return { user, context, page, revoke };
}

/**
 * Compte NEUF avec le rôle GLOBAL Gardien (donné par le gardien via l'API, retiré par `revoke`) :
 * établissements et journal d'audit sans dépendre du jeton partagé `gardien`, que toute
 * connexion d'une autre spec révoque. Le compte reste abonné au programme 1 (createEnrolledUser).
 */
export async function guardianPage(browser: Browser, baseURL: string) {
  const { user, storageState } = await createEnrolledUser(baseURL);
  const change = async (type: 'assign' | 'unassign') => {
    const api = await apiAs(baseURL, ROLE_ACCOUNTS.gardien);
    try {
      const res = await api.post('/api/roles/global/change', {
        data: { type, roleId: await roleId(api, 'Gardien', 'global'), userId: user.id },
      });
      expect(res.ok(), `${type} Gardien à ${user.id} : HTTP ${res.status()}`).toBe(true);
    } finally {
      await api.dispose();
    }
  };
  await change('assign');
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto('/home');
  return { user, context, page, revoke: () => change('unassign') };
}

export { PROGRAM_NAME };

// ─── Assertions de mise en page ──────────────────────────────────────────────────────────

/** Le document ne défile pas horizontalement (aucun élément ne déborde de la page). */
export async function expectNoHorizontalOverflow(page: Page) {
  try {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const root = document.documentElement;
            return Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
          }),
        { message: 'débordement horizontal du document (scrollWidth - clientWidth)' }
      )
      .toBeLessThanOrEqual(0);
  } catch (error) {
    throw withOffenders(error, await page.locator('body').evaluate(listOffenders));
  }
}

/**
 * Un conteneur défilant (panneau principal, corps d'un popup…) ne défile pas horizontalement :
 * son contenu tient dans sa largeur.
 */
export async function expectNoScrollableOverflow(container: Locator) {
  try {
    await expect
      .poll(() => container.evaluate((el) => el.scrollWidth - el.clientWidth), {
        message: 'débordement horizontal du conteneur (scrollWidth - clientWidth)',
      })
      .toBeLessThanOrEqual(1);
  } catch (error) {
    throw withOffenders(error, await container.evaluate(listOffenders));
  }
}

/**
 * Diagnostic d'un débordement : éléments dont le bord droit dépasse celui du conteneur (hors
 * descendants d'une zone qui défile elle-même en interne, ex. bloc de code), avec la police
 * effective — un débordement qui n'apparaît que sur les runners Linux vient souvent d'une
 * police de repli plus large (l'app demande Inter sans la fournir).
 */
function listOffenders(root: Element): string[] {
  const right = root.getBoundingClientRect().right;
  const scrolls = (el: Element) => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const out: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= right + 1 || scrolls(el)) continue;
    const cs = getComputedStyle(el);
    out.push(
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}` +
        `[role=${el.getAttribute('role') ?? '-'}] dépasse de ${Math.round(r.right - right)} px ` +
        `(largeur ${Math.round(r.width)}, police ${cs.fontFamily.split(',')[0]}, nowrap=${cs.whiteSpace === 'nowrap'}) ` +
        `« ${(el.textContent ?? '').trim().slice(0, 40)} »`
    );
    if (out.length >= 8) break;
  }
  out.unshift(`police du document : ${getComputedStyle(document.body).fontFamily}`);
  return out;
}

function withOffenders(error: unknown, offenders: string[]): Error {
  const base = error instanceof Error ? error.message : String(error);
  return new Error(`${base}\n\nÉléments en cause :\n  - ${offenders.join('\n  - ')}`);
}

/**
 * Le corps défilant du popup qui contient `heading` (plus proche ancêtre à overflow-y auto /
 * scroll) ne déborde pas horizontalement.
 */
export async function expectPopupFits(heading: Locator) {
  await expect(heading).toBeVisible();
  await expect
    .poll(
      () =>
        heading.evaluate((el) => {
          for (let node = el.parentElement; node; node = node.parentElement) {
            const { overflowY } = getComputedStyle(node);
            if (overflowY === 'auto' || overflowY === 'scroll') {
              return node.scrollWidth - node.clientWidth;
            }
          }
          return 0;
        }),
      { message: 'débordement horizontal du popup' }
    )
    .toBeLessThanOrEqual(1);
  await expectReachable(heading);
}

/**
 * L'élément est atteignable : après défilement vers lui au besoin, sa boîte est ENTIÈREMENT
 * dans le viewport et son centre n'est recouvert par rien d'autre (barre fixe, fond…).
 */
export async function expectReachable(locator: Locator) {
  await expect(locator).toBeVisible();
  const { width, height } = locator.page().viewportSize()!;
  const label = await describe(locator);
  // Ne défile que si nécessaire : un défilement déplace le contenu sous la souris et annule un
  // survol (actions révélées au survol) ; Firefox défile même quand l'élément est déjà visible.
  const before = await locator.boundingBox();
  const inside = (box: { x: number; y: number; width: number; height: number } | null) =>
    !!box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1;
  if (!inside(before)) await locator.scrollIntoViewIfNeeded();
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        if (!box) return 'aucune boîte';
        if (!inside(box)) return `hors du viewport ${width}×${height} : ${JSON.stringify(box)}`;
        const covered = await locator.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || el.contains(hit)) return null;
          // Sous un en-tête collant après le défilement : on recentre et on réessaie.
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
          return hit.outerHTML.slice(0, 80);
        });
        return covered ? `recouvert par ${covered}` : 'ok';
      },
      { message: `${label} atteignable` }
    )
    .toBe('ok');
}

/** Le bord droit de l'élément reste dans le viewport (réessayé : le DOM peut se remplacer). */
export async function expectWithinWidth(locator: Locator) {
  const { width } = locator.page().viewportSize()!;
  await expect
    .poll(
      async () => {
        const box = await locator.boundingBox();
        return box ? Math.round(box.x + box.width) : null;
      },
      { message: 'bord droit de l’élément dans le viewport' }
    )
    .toBeLessThanOrEqual(width + 1);
}

/**
 * Taille d'une cible tactile (profils `hasTouch`). Seuil dur `min` (24 px par défaut, WCAG 2.5.8) ;
 * sous 32 px (taille confortable) la cible est seulement annotée dans le rapport.
 */
export async function expectTapTarget(locator: Locator, min = 24, label = 'cible') {
  const box = (await locator.boundingBox())!;
  expect(box, `${label} visible`).not.toBeNull();
  const size = `${Math.round(box.width)}×${Math.round(box.height)} px`;
  if (Math.min(box.width, box.height) < 32) {
    test.info().annotations.push({ type: 'cible tactile < 32 px', description: `${label} : ${size}` });
  }
  // Tolérance d'un dixième de pixel : sur les runners Linux, un bouton de 24 px rendu avec une autre
  // police mesure 23,9997 px (arrondi sous-pixel), ce qui n'est pas un défaut d'interface.
  expect(Math.min(box.width, box.height) + 0.1, `${label} ${size}`).toBeGreaterThanOrEqual(min);
}

/** Atteignable + (au tactile) taille minimale. */
export async function expectActionable(locator: Locator, hasTouch: boolean, min = 24) {
  await expectReachable(locator);
  if (hasTouch) await expectTapTarget(locator, min, await describe(locator));
}

/**
 * Bouton-icône (✕, crayon, poubelle, case à cocher…) : atteignable ; au tactile sa taille est
 * seulement ANNOTÉE (beaucoup font 15–22 px : listés dans le rapport, pas bloquants ici).
 */
export async function noteTarget(locator: Locator, hasTouch: boolean) {
  await expectReachable(locator);
  if (!hasTouch) return;
  const box = (await locator.boundingBox())!;
  if (Math.min(box.width, box.height) < 32) {
    test.info().annotations.push({
      type: 'cible tactile < 32 px',
      description: `${await describe(locator)} : ${Math.round(box.width)}×${Math.round(box.height)} px`,
    });
  }
}

/**
 * Champ de saisie atteignable ; au tactile, hauteur ≥ 24 px (dure) du champ ou de son cadre
 * (l'`<input>` nu fait souvent 15–17 px, le cadre visible et cliquable est sur son parent).
 */
export async function expectField(locator: Locator, hasTouch: boolean) {
  await expectReachable(locator);
  if (!hasTouch) return;
  const height = await locator.evaluate((el) => {
    const own = el.getBoundingClientRect().height;
    const parent = el.parentElement?.getBoundingClientRect().height ?? 0;
    return Math.max(own, parent);
  });
  const label = await describe(locator);
  if (height < 32) {
    test.info().annotations.push({ type: 'cible tactile < 32 px', description: `${label} : ${Math.round(height)} px de haut` });
  }
  expect(height + 0.1, `${label} : ${Math.round(height)} px de haut`).toBeGreaterThanOrEqual(24); // tolérance sous-pixel, cf. expectTapTarget
}

/** Nom accessible (ou texte) d'un élément, pour les messages et annotations. */
async function describe(locator: Locator) {
  return locator.evaluate((el) => {
    const name = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent ?? '';
    return `${el.tagName.toLowerCase()} « ${name.trim().slice(0, 40)} »`;
  });
}

/**
 * Vérifie la disposition attendue pour la largeur courante : tiroir + barre mobile (≤ 900 px)
 * ou barre latérale fixe. Suppose le tiroir fermé.
 */
export async function expectLayout(page: Page) {
  const { drawer: isDrawer } = layoutOf(page);
  const account = page.getByRole('button', { name: 'Compte utilisateur' });
  if (isDrawer) {
    await expect(banner(page)).toBeVisible();
    await expect(banner(page).getByRole('button', { name: 'Ouvrir le menu' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expectDrawerClosed(page);
    await expect(resizeHandle(page)).toBeHidden();
    // Pastille compacte dans la barre mobile ; pied de page du compte masqué (display: none).
    await expect(banner(page).getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
    await expect(courseNav(page).getByRole('button', { name: 'Compte utilisateur' })).toHaveCount(0);
  } else {
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ouvrir le menu' })).toHaveCount(0);
    await expect(drawer(page)).toBeInViewport({ ratio: 1 });
    expect((await drawer(page).boundingBox())!.x).toBe(0);
    await expect(resizeHandle(page)).toBeVisible();
    await expect(courseNav(page).getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
  }
  // Une seule pastille « Compte utilisateur » visible, quelle que soit la disposition.
  await expect(account).toHaveCount(1);
}
