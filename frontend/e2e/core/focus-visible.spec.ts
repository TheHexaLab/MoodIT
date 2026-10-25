import { expect, test, type Locator, type Page } from './fixtures';
import { FORUM_NAME, PROGRAM_NAME, createEnrolledUser, mainContent, openCourseItem } from './helpers';
import { openHome, programButton } from './admin.helpers';
import { hasVisibleFocusIndicator } from './a11y.helpers';

// Indicateur de focus visible (WCAG 2.4.7) : après un Tab, l'élément focalisé porte un contour
// (`outline`) ou une ombre (`box-shadow`) non nuls. Le focus est toujours obtenu AU CLAVIER
// (Maj+Tab puis Tab depuis l'élément) pour que `:focus-visible` s'applique comme pour un vrai
// utilisateur, les navigateurs ne l'activant pas forcément après un `focus()` programmatique.

/** Assertions douces ré-essayées : un contrôle sans indicateur n'arrête pas l'inventaire. */
const softly = expect.configure({ soft: true, timeout: 1_000 });

/**
 * Place le focus sur `control` par le clavier et vérifie son indicateur (assertion douce). On
 * arrive sur le contrôle en avançant puis reculant (`forward`, défaut : Maj+Tab depuis le premier
 * contrôle d'une page sortirait vers l'interface du navigateur, d'où Firefox ne revient pas) ou
 * l'inverse (`backward`, pour un champ qui capture Tab, comme l'éditeur Markdown).
 */
async function expectFocusIndicator(
  page: Page,
  control: Locator,
  label: string,
  approach: 'backward' | 'forward' = 'forward'
) {
  const [away, back] = approach === 'backward' ? ['Shift+Tab', 'Tab'] : ['Tab', 'Shift+Tab'];
  // Ré-essayé : un message WebSocket (contenu créé par une autre spec sur le même cours) peut
  // re-rendre la barre latérale entre deux touches et faire retomber le focus sur <body>.
  await expect(async () => {
    await control.focus();
    await page.keyboard.press(away);
    await page.keyboard.press(back);
    await expect(control).toBeFocused({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  // Certains indicateurs apparaissent par transition CSS (≈ 150 ms) : assertion ré-essayée.
  let indicator = await hasVisibleFocusIndicator(control);
  await softly
    .poll(async () => (indicator = await hasVisibleFocusIndicator(control)).visible, {
      message: `${label} : outline=${indicator.outline}, box-shadow=${indicator.boxShadow}`,
    })
    .toBe(true);
  console.log(
    `FOCUS|${label}|${indicator.visible}|${indicator.outline}|${indicator.boxShadow}|pseudo=${indicator.pseudo}`
  );
}

test('/login : chaque contrôle garde un indicateur de focus', async ({ page, browserName }) => {
  await page.goto('/login');
  const controls: [Locator, string][] = [
    [page.getByPlaceholder('exemple@gmail.com'), 'champ e-mail'],
    [page.getByPlaceholder('••••••••••'), 'champ mot de passe'],
    [page.locator('.eye-btn'), 'bouton œil'],
    [page.getByRole('button', { name: 'Se connecter →' }), 'bouton Se connecter'],
  ];
  // WebKit (comme Safari) ne s'arrête pas sur les liens avec Tab seul : vérifiés ailleurs.
  if (browserName !== 'webkit') {
    controls.push(
      [page.getByRole('link', { name: 'Mot de passe oublié ?' }), 'lien mot de passe oublié'],
      [page.getByRole('link', { name: 'Créer un compte' }), 'lien Créer un compte']
    );
  }
  for (const [control, label] of controls) await expectFocusIndicator(page, control, label);
});

test('accueil : rail, sélecteur de cours, sections, canaux et compte', async ({
  browser,
  baseURL,
}) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const { page } = await openHome(browser, storageState);
  await programButton(page, PROGRAM_NAME).click();
  const nav = page.getByRole('navigation', { name: 'Cours' });
  await expect(nav.getByRole('button', { name: 'MAT115', exact: true })).toBeVisible();
  const controls: [Locator, string][] = [
    [programButton(page, PROGRAM_NAME), 'pastille du programme'],
    [page.getByRole('button', { name: 'Ajouter un programme', exact: true }), 'Ajouter un programme'],
    [nav.getByRole('button', { name: 'MAT115', exact: true }), 'sélecteur de cours'],
    [nav.getByRole('button', { name: 'CANAUX', exact: true }), 'repli de section'],
    [nav.getByRole('button', { name: FORUM_NAME }), 'élément de section (forum)'],
    [page.getByRole('button', { name: 'Compte utilisateur' }), 'bouton du compte'],
  ];
  for (const [control, label] of controls) await expectFocusIndicator(page, control, label);
  // Dernier élément focalisable de la page (rien après elle) : abordée en reculant.
  await expectFocusIndicator(
    page,
    page.getByRole('separator', { name: 'Redimensionner le menu des cours' }),
    'poignée de redimensionnement',
    'backward'
  );
});

test('forum : actions, votes, tri et composeur', async ({ browser, baseURL }) => {
  const { storageState } = await createEnrolledUser(baseURL!);
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await openCourseItem(page, FORUM_NAME);
  const main = mainContent(page);
  await expect(main.getByRole('button', { name: '+ Nouveau sujet' })).toBeVisible();
  // Le forum du seed a toujours au moins un sujet (forum.spec.ts en publie).
  const firstCard = main.getByRole('listitem').first();
  const beforeCompose: [Locator, string][] = [
    [main.getByRole('button', { name: '+ Nouveau sujet' }), 'Nouveau sujet'],
    [page.getByRole('group', { name: 'Trier les sujets' }).getByRole('button', { name: 'Récents' }), 'tri Récents'],
    [firstCard.getByRole('button', { name: 'Voter pour' }).first(), 'Voter pour'],
    [firstCard.getByRole('button', { name: 'Répondre', exact: true }).first(), 'Répondre'],
  ];
  for (const [control, label] of beforeCompose) await expectFocusIndicator(page, control, label);

  await main.getByRole('button', { name: '+ Nouveau sujet' }).click();
  // L'éditeur Markdown capture Tab (indentation) : on l'aborde en reculant.
  const composing: [Locator, string, 'backward' | 'forward'][] = [
    [page.getByRole('textbox', { name: 'Titre du sujet' }), 'champ Titre du sujet', 'forward'],
    [page.getByRole('toolbar', { name: 'Mise en forme Markdown' }).getByRole('button', { name: 'Gras' }), 'bouton Gras', 'forward'],
    [page.getByRole('textbox', { name: 'Éditeur Markdown' }), 'éditeur Markdown', 'backward'],
    [page.getByRole('button', { name: 'Annuler' }), 'bouton Annuler', 'forward'],
  ];
  for (const [control, label, approach] of composing) {
    await expectFocusIndicator(page, control, label, approach);
  }
  await page.getByRole('button', { name: 'Annuler' }).click();
  await context.close();
});
