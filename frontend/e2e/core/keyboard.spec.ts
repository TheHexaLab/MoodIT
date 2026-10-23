import { expect, test, type Locator, type Page } from './fixtures';
import { TEST_PASSWORD } from '../setup/accounts';
import {
  FORUM_NAME,
  PROGRAM_NAME,
  createEnrolledUser,
  mainContent,
  newUser,
  openCourseItem,
  uniqueSuffix,
} from './helpers';
import {
  clickCourseMenu,
  clickProgramMenu,
  freshAccount,
  openHome,
  programButton,
} from './admin.helpers';
import { SECOND_COURSE, enrollInCourses, ensureCourse, settingsSaved } from './dashboard.helpers';
import {
  createProgramFixture,
  createSixTypeQuiz,
  focusFirstInPopup,
  focusedDescription,
  pasteFromClipboard,
  popupHasFocus,
  type ProgramFixture,
} from './a11y.helpers';

// Navigation au clavier réelle (Tab, Entrée, Espace, Échap, flèches, collage). Les manquements
// connus de l'application (pas de piège de focus, pas de gestion d'Échap dans les popups, pas de
// flèches dans les menus…) sont écrits comme des tests attendus et marqués `test.fail`.

/** Noms accessibles (ou placeholders) des éléments atteints par `count` Tab successifs. */
async function tabSequence(page: Page, count: number) {
  const reached: string[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    reached.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return 'body';
        return (
          el.getAttribute('aria-label') ??
          el.getAttribute('placeholder') ??
          el.textContent?.trim() ??
          el.tagName
        );
      })
    );
  }
  return reached;
}

/** Appuie sur Tab (au plus `max` fois) jusqu'à ce que `target` ait le focus. */
async function tabUntilFocused(page: Page, target: Locator, max = 25) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/**
 * Vérifie l'ordre de Tab. Les entrées `link` sont des liens : Chromium et Firefox s'y arrêtent
 * toujours ; WebKit s'y arrête sur Linux (runners CI) mais pas sur macOS/Windows (Option+Tab).
 * Sur WebKit on compare donc la séquence SANS les liens, quelle que soit la plateforme.
 */
async function expectTabOrder(page: Page, browserName: string, items: (string | { link: string })[]) {
  const full = items.map((item) => (typeof item === 'string' ? item : item.link));
  const links = new Set(items.flatMap((item) => (typeof item === 'string' ? [] : [item.link])));
  const received = await tabSequence(page, full.length);
  if (browserName !== 'webkit') {
    expect(received).toEqual(full);
    return;
  }
  const withoutLinks = full.filter((name) => !links.has(name));
  expect(received.filter((name) => !links.has(name)).slice(0, withoutLinks.length)).toEqual(withoutLinks);
}

const codeBoxes = (page: Page) =>
  page.getByRole('group', { name: 'Code à 6 chiffres' }).getByRole('textbox');

test.describe('formulaires d’authentification', () => {
  test('connexion : Tab suit l’ordre visuel et Entrée soumet', async ({
    page,
    baseURL,
    browserName,
  }) => {
    const { user } = await createEnrolledUser(baseURL!);
    await page.goto('/login');
    await expect(page.getByPlaceholder('exemple@gmail.com')).toBeVisible(); // page rendue avant le 1er Tab
    await expectTabOrder(page, browserName, [
      'exemple@gmail.com',
      '••••••••••',
      '', // œil (sans nom accessible)
      { link: 'Mot de passe oublié ?' },
      'Se connecter →',
      { link: 'Créer un compte' },
    ]);

    // Saisie entièrement au clavier, Entrée dans le mot de passe soumet : on arrive à la 2FA.
    await page.getByPlaceholder('exemple@gmail.com').focus();
    await page.keyboard.type(user.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(TEST_PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
    await expect(page).toHaveURL(/\/verify-code$/);
  });

  test('inscription : Tab suit l’ordre visuel', async ({ page, browserName }) => {
    await page.goto('/register');
    await expect(page.getByPlaceholder('ex : RKarine')).toBeVisible(); // sinon WebKit tabule sur <body>
    await expectTabOrder(page, browserName, [
      'ex : RKarine',
      'ex: Karine',
      'ex: Roussel',
      'ex: Karine_Roussel@usherbrooke.ca',
      'Choisissez un mot de passe',
      'Afficher le mot de passe',
      'Retapez votre mot de passe',
      'Afficher le mot de passe',
      '', // case CGU (libellé = texte voisin)
      { link: "conditions d'utilisation" }, // liens dans le libellé de la case
      { link: 'politique de confidentialité' },
      'Créer mon compte →',
    ]);
  });

  // Bogue : la page d'inscription n'a pas de <form> (le bouton « Créer mon compte → » n'est qu'un
  // onClick) : Entrée dans un champ ne soumet rien, alors que la connexion, elle, soumet.
  // Attendu : la soumission (ici, la validation des champs requis) se déclenche à Entrée.
  test('inscription : Entrée dans un champ soumet le formulaire', async ({ page }) => {
    test.fail(true, 'inscription sans <form> : Entrée ne soumet pas (bouton onClick seulement)');
    await page.goto('/register');
    await page.getByPlaceholder('ex : RKarine').focus();
    await page.keyboard.type(newUser().username);
    await page.keyboard.press('Enter');
    await expect(page.getByText('⚠ Requis', { exact: true })).toHaveCount(5, { timeout: 2_000 });
    await expect(page).toHaveURL(/\/register$/);
  });

  // /reset-password a les mêmes 6 cases que /verify-code, SANS auto-soumission : on peut y
  // observer la saisie case par case sans déclencher de requête.
  test('code à 6 chiffres : la saisie avance, Retour arrière recule', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByPlaceholder('exemple@usherbrooke.ca').fill(newUser().email);
    await page.getByRole('button', { name: 'Envoyer le code →' }).click();
    const boxes = codeBoxes(page);
    await expect(boxes).toHaveCount(6);

    await boxes.nth(0).focus();
    await page.keyboard.type('12');
    await expect(boxes.nth(0)).toHaveValue('1');
    await expect(boxes.nth(1)).toHaveValue('2');
    await expect(boxes.nth(2)).toBeFocused();
    // Case vide : Retour arrière efface la précédente et y revient.
    await page.keyboard.press('Backspace');
    await expect(boxes.nth(1)).toHaveValue('');
    await expect(boxes.nth(1)).toBeFocused();
    // Case pleine : Retour arrière l'efface sans bouger.
    await page.keyboard.type('3');
    await expect(boxes.nth(1)).toHaveValue('3');
    await expect(boxes.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(boxes.nth(1)).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(boxes.nth(1)).toHaveValue('');
    await expect(boxes.nth(1)).toBeFocused();
    await expect(boxes.nth(0)).toHaveValue('1');
  });

  test('code 2FA : coller 6 chiffres remplit toutes les cases et valide', async ({
    page,
    baseURL,
  }) => {
    const { user } = await createEnrolledUser(baseURL!);
    await page.goto('/login');
    await page.getByPlaceholder('exemple@gmail.com').fill(user.email);
    await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter →' }).click();
    await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();

    await pasteFromClipboard(page, codeBoxes(page).first(), '000000');
    // Les 6 cases sont remplies et le code est soumis de lui-même : session ouverte.
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toContainText(
      `@${user.username}`
    );
  });
});

test.describe('popups', () => {
  interface PopupCase {
    title: string;
    open: (page: Page) => Promise<void>;
    /** Fermeture à la souris (sans Échap) : bouton « Annuler », ou croix de l'en-tête. */
    close: (page: Page) => Promise<void>;
  }
  const cancel = (page: Page) => page.getByRole('button', { name: 'Annuler' }).click();
  const cross = (page: Page) => page.getByRole('button', { name: '✕' }).click();

  /** Popups de l'étudiant (page sur le programme de test). */
  const STUDENT_POPUPS: PopupCase[] = [
    {
      title: 'Modifier le profil',
      open: async (page) => {
        await page.getByRole('button', { name: 'Compte utilisateur' }).click();
        await page.getByRole('menuitem', { name: 'Modifier le profil' }).click();
      },
      close: cancel,
    },
    {
      title: 'Ajouter un programme',
      open: (page) => page.getByRole('button', { name: 'Ajouter un programme', exact: true }).click(),
      close: cross, // croix de l'en-tête (sans aria-label) : pas d'« Annuler » à cette étape
    },
    {
      title: 'Rejoindre des cours',
      open: (page) => clickProgramMenu(page, PROGRAM_NAME, 'Rejoindre des cours'),
      close: cancel,
    },
    {
      title: 'Quitter le cours ?',
      open: (page) => clickCourseMenu(page, 'MAT115', 'Quitter le cours'),
      close: cancel,
    },
  ];

  async function studentHome(browser: Parameters<typeof openHome>[0], baseURL: string) {
    const { storageState } = await createEnrolledUser(baseURL);
    const { page } = await openHome(browser, storageState);
    await programButton(page, PROGRAM_NAME).click();
    await expect(
      mainContent(page).getByRole('heading', { name: 'Aucun canal sélectionné' })
    ).toBeVisible();
    return page;
  }

  // WAI-ARIA dialog : à l'ouverture, la coquille Popup déplace le focus dans la popup.
  test('le focus entre dans la popup à son ouverture', async ({ browser, baseURL }) => {
    const page = await studentHome(browser, baseURL!);
    for (const { title, open, close } of STUDENT_POPUPS) {
      await open(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      expect
        .soft(await popupHasFocus(page, title), `« ${title} » : focus sur ${await focusedDescription(page)}`)
        .toBe(true);
      await close(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    }
  });

  // Tab et Maj+Tab tournent à l'intérieur de la popup ouverte (piège de focus de la coquille).
  // Vérifié en RECULANT (Maj+Tab depuis le premier élément) : les
  // popups sont en fin de document, donc Tab depuis leur dernier élément sort vers l'interface du
  // navigateur, où Firefox ne change pas `document.activeElement` ; en reculant, la sortie atterrit
  // sur un élément de la page, observable sur les trois moteurs.
  test('Maj+Tab reste dans la popup ouverte (piège de focus)', async ({ browser, baseURL }) => {
    const page = await studentHome(browser, baseURL!);
    for (const { title, open, close } of STUDENT_POPUPS) {
      await open(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
      // Point de départ : le premier élément focalisable de la popup ; un piège mène au dernier.
      // On recule d'au plus deux fois le nombre d'éléments de la popup.
      const count = await focusFirstInPopup(page, title);
      expect(count, `« ${title} » : éléments focalisables`).toBeGreaterThan(0);
      const start = await focusedDescription(page);
      let escaped: string | null = null;
      for (let i = 0; i < count * 2; i++) {
        await page.keyboard.press('Shift+Tab');
        if (!(await popupHasFocus(page, title))) {
          escaped = `${await focusedDescription(page)} après ${i + 1} Maj+Tab`;
          break;
        }
        if (i > 0 && (await focusedDescription(page)) === start) break; // cycle complet
      }
      expect.soft(escaped, `« ${title} » : le focus est sorti vers ${escaped}`).toBeNull();
      await close(page);
      await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    }
  });

  // Échap ferme la popup et rend le focus à l'élément qui l'a ouverte (coquille Popup).
  test('Échap ferme la popup et rend le focus au déclencheur', async ({ browser, baseURL }) => {
    const page = await studentHome(browser, baseURL!);
    for (const { title, open, close } of STUDENT_POPUPS) {
      await open(page);
      const heading = page.getByRole('heading', { name: title, exact: true });
      await expect(heading).toBeVisible();
      await page.keyboard.press('Escape');
      await expect.soft(heading, `« ${title} » : toujours ouverte après Échap`).toBeHidden({
        timeout: 2_000,
      });
      if (await heading.isVisible()) await close(page);
      await expect(heading).toHaveCount(0);
    }

    // ErrorPopup (panne injectée) : Entrée la ferme, Échap devrait aussi.
    await page.route('**/api/courses/*/users/*', (route) => route.fulfill({ status: 500 }));
    await STUDENT_POPUPS[3].open(page);
    await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    const error = page.getByText('Impossible de quitter le cours. Réessaie.');
    await expect(error).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.soft(error, 'ErrorPopup : toujours ouverte après Échap').toBeHidden({ timeout: 2_000 });
    if (await error.isVisible()) await page.keyboard.press('Enter');
    await expect(error).toBeHidden();
    await page.unroute('**/api/courses/*/users/*');
  });
});

test.describe('menus', () => {
  test('menu du compte : Échap le ferme et le déclencheur garde le focus', async ({
    browser,
    baseURL,
  }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    const { page } = await openHome(browser, storageState);
    const trigger = page.getByRole('button', { name: 'Compte utilisateur' });
    const menu = page.getByRole('menu', { name: 'Menu du compte' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  // Attendu (WAI-ARIA menu) : à l'ouverture le focus va sur le premier élément, les flèches
  // circulent, Entrée active. Obtenu : le focus reste sur le déclencheur et Tab part ailleurs dans
  // la page (le menu est porté en fin de document).
  test('menu du compte : flèches et Entrée', async ({ browser, baseURL }) => {
    test.fail(true, 'menu du compte sans gestion du focus ni des flèches');
    const { storageState } = await createEnrolledUser(baseURL!);
    const { page } = await openHome(browser, storageState);
    const trigger = page.getByRole('button', { name: 'Compte utilisateur' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Menu du compte' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('switch', { name: 'Mode sombre' })).toBeFocused({ timeout: 2_000 });
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Modifier le profil' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Modifier le profil' })).toBeVisible();
  });

  // Maj+F10 (ou la touche Menu) déclenche l'événement `contextmenu` sur l'élément focalisé : c'est
  // la seule ouverture clavier possible, et seul Chromium la synthétise. Firefox et WebKit n'ont
  // aucun moyen d'ouvrir ces menus au clavier : l'application devrait offrir une alternative.
  test('menu contextuel du programme : ouverture au clavier, Échap, Entrée sur une action', async ({
    browser,
    baseURL,
    browserName,
  }) => {
    test.fail(
      browserName !== 'chromium',
      'menus contextuels ouverts seulement au clic droit : pas d’alternative clavier hors Chromium'
    );
    const { storageState } = await createEnrolledUser(baseURL!);
    const { page } = await openHome(browser, storageState);
    const program = programButton(page, PROGRAM_NAME);
    await program.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 2_000 });
    await expect(menu.getByRole('menuitem')).toHaveText(['Rejoindre des cours', 'Quitter le programme']);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(program).toBeFocused();

    // Les actions sont des boutons : atteignables par Tab, activables à Entrée.
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await tabUntilFocused(page, menu.getByRole('menuitem', { name: 'Rejoindre des cours' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Rejoindre des cours' })).toBeVisible();
    await page.getByRole('button', { name: 'Annuler' }).click();
  });

  // Attendu (flèches dans le menu, cf. ci-dessus). Obtenu : rien ne bouge.
  test('menu contextuel du programme : flèches', async ({ browser, baseURL, browserName }) => {
    test.fail(true, 'menus contextuels sans navigation aux flèches');
    test.skip(browserName !== 'chromium', 'Seul Chromium ouvre un menu contextuel au clavier.');
    const { storageState } = await createEnrolledUser(baseURL!);
    const { page } = await openHome(browser, storageState);
    await programButton(page, PROGRAM_NAME).focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused({ timeout: 2_000 });
  });

  test('sélecteur de cours : Entrée ouvre sur la recherche, Tab + Entrée choisit un cours, Échap ferme', async ({
    browser,
    baseURL,
  }) => {
    const { user, storageState } = await createEnrolledUser(baseURL!);
    await enrollInCourses(baseURL!, storageState, user.id, [1, SECOND_COURSE.id]);
    const { page } = await openHome(browser, storageState);
    await programButton(page, PROGRAM_NAME).click();
    await ensureCourse(page, 'MAT115');
    const nav = page.getByRole('navigation', { name: 'Cours' });
    const picker = nav.locator('button[aria-haspopup="listbox"]');
    const listbox = page.getByRole('listbox');
    await expect(picker).toHaveText('MAT115');

    await picker.focus();
    await page.keyboard.press('Enter');
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('textbox', { name: 'Rechercher un cours…' })).toBeFocused();
    await page.keyboard.type('GIF');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(listbox.getByRole('option', { name: /^GIF201/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(listbox).toBeHidden();
    await expect(picker).toHaveText('GIF201');
    await expect(nav.getByRole('button', { name: SECOND_COURSE.channel })).toBeVisible();

    // Échap depuis la recherche referme sans changer de cours.
    await picker.focus();
    await page.keyboard.press('Enter');
    await expect(listbox.getByRole('textbox', { name: 'Rechercher un cours…' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
    await expect(picker).toHaveText('GIF201');
  });

  // Attendu (WAI-ARIA listbox) : flèches entre les options, Entrée valide ; Échap depuis une option
  // ferme aussi ; le focus revient au bouton du sélecteur. Obtenu : seules la recherche et Tab marchent.
  test('sélecteur de cours : flèches, Échap depuis une option, retour du focus', async ({
    browser,
    baseURL,
  }) => {
    test.fail(true, 'listbox du sélecteur de cours : pas de flèches, Échap ignoré hors de la recherche, focus perdu à la fermeture');
    const { user, storageState } = await createEnrolledUser(baseURL!);
    await enrollInCourses(baseURL!, storageState, user.id, [1, SECOND_COURSE.id]);
    const { page } = await openHome(browser, storageState);
    await programButton(page, PROGRAM_NAME).click();
    await ensureCourse(page, 'MAT115');
    const picker = page.getByRole('navigation', { name: 'Cours' }).locator('button[aria-haspopup="listbox"]');
    const listbox = page.getByRole('listbox');

    await picker.focus();
    await page.keyboard.press('Enter');
    await expect(listbox).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.soft(listbox.getByRole('option').first(), 'ArrowDown ne cible pas la 1re option').toBeFocused({ timeout: 2_000 });

    await page.keyboard.press('Tab'); // 1re option (ou déjà dessus)
    await expect(listbox.getByRole('option').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.soft(listbox, 'Échap depuis une option ne ferme pas').toBeHidden({ timeout: 2_000 });
    if (await listbox.isVisible()) {
      await listbox.getByRole('textbox', { name: 'Rechercher un cours…' }).focus();
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
    }
    await expect.soft(picker, 'le focus ne revient pas au sélecteur').toBeFocused({ timeout: 2_000 });
  });

  // L'éditeur Markdown capture Tab pour indenter : en avançant, le clavier ne peut plus atteindre
  // « Publier » / « Annuler » (WCAG 2.1.2 : il faut au moins annoncer la sortie). Les issues
  // existantes — Maj+Tab vers la barre d'outils, Ctrl+Entrée publie, Échap annule — sont vérifiées.
  test('éditeur Markdown : Tab mène au bouton « Publier »', async ({ browser, baseURL }) => {
    test.fail(true, 'l’éditeur Markdown capture Tab (indentation) : « Publier » inatteignable en avançant');
    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await openCourseItem(page, FORUM_NAME);
    await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
    await page.getByRole('textbox', { name: 'Titre du sujet' }).fill(`Sujet Tab ${uniqueSuffix()}`);
    const editor = page.getByRole('textbox', { name: 'Éditeur Markdown' });
    await editor.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(
      page.getByRole('toolbar', { name: 'Mise en forme Markdown' }).getByRole('button', { name: 'Aperçu' })
    ).toBeFocused();
    await editor.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Publier' })).toBeFocused({ timeout: 2_000 });
  });

  test('menu « Titre » de l’éditeur Markdown : Entrée ouvre, Tab + Entrée insère, Échap ferme', async ({
    browser,
    baseURL,
  }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await openCourseItem(page, FORUM_NAME);
    await page.getByRole('button', { name: '+ Nouveau sujet' }).click();
    const editor = page.getByRole('textbox', { name: 'Éditeur Markdown' });
    const trigger = page
      .getByRole('toolbar', { name: 'Mise en forme Markdown' })
      .getByRole('button', { name: 'Titre' });
    const menu = page.getByRole('menu', { name: 'Niveau de titre' });

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await tabUntilFocused(page, menu.getByRole('menuitem', { name: 'Sous-titre' }), 6);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(editor).toHaveValue(/^## /);
    await page.getByRole('button', { name: 'Annuler' }).click();
  });
});

test.describe('éditeur de quiz (Administrateur neuf d’un programme neuf)', () => {
  let fixture: ProgramFixture;
  let quizTitle: string;

  test.beforeAll(async ({ baseURL }) => {
    fixture = await createProgramFixture(baseURL!, 'Clav');
    quizTitle = `Quiz clavier ${uniqueSuffix()}`;
    await createSixTypeQuiz(fixture.admin.api, fixture.course.id, quizTitle);
  });

  test.afterAll(async () => {
    await fixture?.cleanup();
  });

  /** Ouvre « Modifier le quiz » du quiz de la fixture. */
  async function openQuizForm(page: Page) {
    await programButton(page, fixture.program.name).click();
    await page
      .getByRole('navigation', { name: 'Cours' })
      .getByRole('button', { name: 'Modifier la section QUIZ' })
      .click();
    await expect(page.getByRole('heading', { name: 'Modifier les quiz' })).toBeVisible();
    await page.locator('[data-reorder-id]').filter({ hasText: quizTitle }).click();
    await page.getByRole('button', { name: `Modifier ${quizTitle}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Modifier le quiz' })).toBeVisible();
  }

  test('switch « Publié » : Espace le bascule, et l’état enregistré suit', async ({ browser }) => {
    const { page } = await openHome(browser, fixture.admin.storageState);
    await openQuizForm(page);
    const publish = page.getByRole('switch', { name: 'Publié' });
    await expect(publish).toHaveAttribute('aria-checked', 'true');
    await publish.focus();
    await page.keyboard.press('Space');
    await expect(publish).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();

    const manage = async () => {
      const res = await fixture.admin.api.get(`/api/courses/${fixture.course.id}/quizzes/manage`);
      const quizzes = (await res.json()) as { title: string; isPublished: boolean }[];
      return quizzes.find((q) => q.title === quizTitle)?.isPublished;
    };
    await expect.poll(manage).toBe(false);

    // Retour à l'état publié (les autres tests du fichier comptent sur un quiz visible).
    await publish.focus();
    await page.keyboard.press('Space');
    await expect(publish).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect.poll(manage).toBe(true);
  });

  // Attendu (listbox) : flèches entre les options, Entrée valide, le focus revient au contrôle.
  // Obtenu : le menu est porté en fin de document, Tab part ailleurs et les flèches ne font rien.
  test('liste déroulante « Type de question » : flèches et Entrée', async ({ browser }) => {
    test.fail(true, 'liste déroulante de l’éditeur sans flèches ni focus sur les options');
    const { page } = await openHome(browser, fixture.admin.storageState);
    await openQuizForm(page);
    await page.getByRole('button', { name: 'Modifier la question' }).first().click();
    await expect(page.getByRole('heading', { name: 'Modifier la question' })).toBeVisible();
    const control = page.getByRole('button', { name: 'Type de question' });
    await expect(control).toHaveText('Vrai/Faux');
    await control.focus();
    await page.keyboard.press('Enter');
    const listbox = page.getByRole('listbox');
    await expect(listbox).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(listbox.getByRole('option', { name: 'Choix unique' })).toBeFocused({ timeout: 2_000 });
    await page.keyboard.press('Enter');
    await expect(listbox).toBeHidden();
    await expect(control).toHaveText('Choix unique');
    await expect(control).toBeFocused();
  });

  // Échap ferme l'éditeur de quiz et la popup des sections (tous deux bâtis sur Popup).
  test('Échap ferme l’éditeur de quiz et l’éditeur de sections', async ({ browser }) => {
    const { page } = await openHome(browser, fixture.admin.storageState);
    await programButton(page, fixture.program.name).click();
    const nav = page.getByRole('navigation', { name: 'Cours' });

    await nav.getByRole('button', { name: 'Modifier la section QUIZ' }).click();
    const editor = page.getByRole('heading', { name: 'Modifier les quiz' });
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.soft(editor, 'éditeur de quiz toujours ouvert après Échap').toBeHidden({ timeout: 2_000 });
    if (await editor.isVisible()) await page.getByRole('button', { name: 'Fermer' }).click();
    await expect(editor).toBeHidden();

    await nav.getByRole('button', { name: 'Modifier la section CANAUX' }).click();
    const sections = page.getByRole('heading', { name: 'Modifier les canaux' });
    await expect(sections).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.soft(sections, 'éditeur de sections toujours ouvert après Échap').toBeHidden({ timeout: 2_000 });
    if (await sections.isVisible()) await page.getByRole('button', { name: '✕' }).click();
    await expect(sections).toHaveCount(0);
  });
});

test.describe('switch et forum', () => {
  test('switch « Mode sombre » : Espace le bascule et le thème est enregistré', async ({
    browser,
    baseURL,
  }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    const { page } = await openHome(browser, storageState);
    await page.getByRole('button', { name: 'Compte utilisateur' }).click();
    const darkSwitch = page.getByRole('switch', { name: 'Mode sombre' });
    await expect(darkSwitch).toHaveAttribute('aria-checked', 'false');
    const saved = settingsSaved(page, (s) => s.theme === 'dark');
    await darkSwitch.focus();
    await page.keyboard.press('Space');
    await expect(darkSwitch).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await saved;
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('forum : voter et répondre au clavier (Tab + Entrée, Ctrl+Entrée)', async ({
    browser,
    baseURL,
  }) => {
    const title = `Sujet clavier ${uniqueSuffix()}`;
    const replyText = `Réponse clavier ${uniqueSuffix()}`;
    // L'auteur publie ; le lecteur (autre compte neuf) vote et répond au clavier.
    const author = await freshAccount(baseURL!);
    await author.api.post('/api/programs/users', { data: { id: author.user.id, programIds: [1] } });
    await author.api.post('/api/courses/users', { data: { id: author.user.id, courseIds: [1], programId: 1 } });
    await author.api.dispose();
    const authorContext = await browser.newContext({ storageState: author.storageState });
    const authorPage = await authorContext.newPage();
    await openCourseItem(authorPage, FORUM_NAME);
    await authorPage.getByRole('button', { name: '+ Nouveau sujet' }).click();
    await authorPage.getByRole('textbox', { name: 'Titre du sujet' }).fill(title);
    await authorPage.getByRole('textbox', { name: 'Éditeur Markdown' }).fill('Corps du sujet');
    await authorPage.getByRole('button', { name: 'Publier' }).click();
    await expect(authorPage.getByRole('heading', { name: title })).toBeVisible();

    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await openCourseItem(page, FORUM_NAME);
    // Tri « Récents » : le sujet frais est en tête, juste après la barre de tri dans l'ordre de Tab.
    const recent = page.getByRole('button', { name: 'Récents' });
    await recent.click();
    const card = mainContent(page)
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await expect(card).toBeVisible();
    const upvote = card.getByRole('button', { name: 'Voter pour' }).first();
    const reply = card.getByRole('button', { name: 'Répondre', exact: true }).first();

    await recent.focus();
    await tabUntilFocused(page, upvote);
    await page.keyboard.press('Enter');
    await expect(upvote).toHaveAttribute('aria-pressed', 'true');
    await expect(card).toMatchAriaSnapshot(`
      - button "Voter pour" [pressed]
      - text: "1"
      - button "Voter contre"
    `);

    await tabUntilFocused(page, reply);
    await page.keyboard.press('Enter');
    const composer = card.getByRole('textbox', { name: 'Éditeur Markdown' });
    await expect(composer).toBeFocused();
    await page.keyboard.type(replyText);
    await page.keyboard.press('Control+Enter');
    await expect(card.getByText(replyText, { exact: true })).toBeVisible();

    // Persisté : vote et réponse survivent au rechargement.
    await openCourseItem(page, FORUM_NAME);
    await expect(card.getByRole('button', { name: 'Voter pour' }).first()).toHaveAttribute('aria-pressed', 'true');
    await card.getByRole('button', { name: 'Déplier les réponses' }).first().click();
    await expect(card.getByText(replyText, { exact: true })).toBeVisible();

    await context.close();
    await authorContext.close();
  });
});
