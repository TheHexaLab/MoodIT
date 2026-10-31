import { expect, request, test, type Page } from './fixtures';
import { TEST_PASSWORD } from '../setup/accounts';
import { MAIL_DOMAIN, createEnrolledUser, enterCode, newUser, readCodeFromMail } from './helpers';
import { expectTheme, setThemeInDb } from './a11y.helpers';

// Compléments d'auth.spec.ts : déconnexion, renvoi de code, validations client, liens entre
// les pages d'authentification et redirections du routeur.

const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025';

/** Nombre de courriels reçus par `to` dont le sujet contient `subject`. */
async function countMails(to: string, subject: string): Promise<number> {
  const api = await request.newContext({ baseURL: MAILPIT_URL });
  try {
    const res = await api.get('/api/v1/search', {
      params: { query: `to:"${to}" subject:"${subject}"`, limit: 1 },
    });
    return ((await res.json()) as { messages_count: number }).messages_count;
  } finally {
    await api.dispose();
  }
}

/** Remplit le formulaire d'inscription (tous les champs valides par défaut). */
async function fillRegister(
  page: Page,
  values: Partial<
    Record<'username' | 'firstName' | 'lastName' | 'email' | 'password' | 'confirm', string>
  >
) {
  const user = newUser();
  const v = {
    username: user.username,
    firstName: 'Dora',
    lastName: 'E2E',
    email: user.email,
    password: TEST_PASSWORD,
    confirm: values.password ?? TEST_PASSWORD,
    ...values,
  };
  await page.getByPlaceholder('ex : RKarine').fill(v.username);
  await page.getByPlaceholder('ex: Karine', { exact: true }).fill(v.firstName);
  await page.getByPlaceholder('ex: Roussel').fill(v.lastName);
  await page.getByPlaceholder('ex: Karine_Roussel@usherbrooke.ca').fill(v.email);
  await page.getByPlaceholder('Choisissez un mot de passe').fill(v.password);
  await page.getByPlaceholder('Retapez votre mot de passe').fill(v.confirm);
}

const submitRegister = (page: Page) =>
  page.getByRole('button', { name: 'Créer mon compte →' }).click();

test.describe('déconnexion', () => {
  // Compte neuf : la déconnexion invalide la session côté serveur, une session partagée
  // (storageState d'alice…) casserait les autres tests.
  test('« Se déconnecter » ramène à la connexion et ferme la session', async ({
    browser,
    baseURL,
  }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto('/home');

    await page.getByRole('button', { name: 'Compte utilisateur' }).click();
    const logout = page.waitForResponse(
      (r) => r.url().endsWith('/auth/logout') && r.request().method() === 'POST'
    );
    await page.getByRole('menuitem', { name: 'Se déconnecter' }).click();
    expect((await logout).ok()).toBe(true);
    await expect(page).toHaveURL(/\/login$/);

    // Le cookie de session ne vaut plus rien : /home renvoie à la connexion.
    await page.goto('/home');
    await expect(page).toHaveURL(/\/login$/);
    await context.close();
  });

  // #224 : en sombre, l'icône était en --danger et le texte en --badge-danger-fg (deux rouges).
  test('« Se déconnecter » : l\'icône a la couleur du texte, en sombre', async ({
    browser,
    baseURL,
  }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    await setThemeInDb(baseURL!, storageState, 'dark');
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto('/home');
    await expectTheme(page, 'dark');

    await page.getByRole('button', { name: 'Compte utilisateur' }).click();
    const item = page.getByRole('menuitem', { name: 'Se déconnecter' });
    const textColor = await item.evaluate((el) => getComputedStyle(el).color);
    await expect(item.locator('svg')).toHaveCSS('color', textColor);
    await context.close();
  });
});

test.describe('renvoi de code', () => {
  // Le serveur impose 60 s entre deux envois (anti-bombing) : le premier clic, juste après
  // l'inscription, est refusé ; on réessaie comme le ferait l'utilisateur jusqu'à ce que le
  // délai soit écoulé, puis on vérifie que le NOUVEAU code reçu valide le compte.
  test('« Renvoyer le code » sur /verify-code envoie un nouveau courriel', async ({ page }) => {
    test.setTimeout(150_000);
    const user = newUser(MAIL_DOMAIN);
    const subject = 'Code de vérification';

    await page.goto('/register');
    await fillRegister(page, { username: user.username, email: user.email });
    await page.getByRole('checkbox').check();
    await submitRegister(page);
    await expect(page.getByRole('heading', { name: 'Vérifiez votre email' })).toBeVisible();
    await readCodeFromMail(user.email, subject);
    expect(await countMails(user.email, subject)).toBe(1);

    const resend = page.getByRole('button', { name: 'Renvoyer le code' });
    await resend.click();
    await expect(page.getByText('Un code vous a déjà été envoyé.')).toBeVisible();

    await expect(async () => {
      await resend.click();
      await expect(page.getByText('Un nouveau code a été envoyé.')).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 90_000, intervals: [5_000] });

    // Compte à rebours local (60 s) : le bouton est désactivé pendant ce temps.
    const countdown = page.getByRole('button', { name: /^Renvoyer \(\d+s\)$/ });
    await expect(countdown).toBeDisabled();
    await expect(countdown).not.toHaveText('Renvoyer (60s)');

    await expect.poll(() => countMails(user.email, subject)).toBe(2);
    await enterCode(page, await readCodeFromMail(user.email, subject));
    await expect(page).toHaveURL(/\/home(\/|$)/);
  });

  // Anti-énumération : la réponse est la même que le compte existe ou non ; un e-mail inconnu
  // suffit donc à tester l'interface.
  test('« Renvoyer » sur /reset-password affiche le message et le compte à rebours', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await page.getByPlaceholder('exemple@usherbrooke.ca').fill(newUser().email);
    await page.getByRole('button', { name: 'Envoyer le code →' }).click();
    await expect(
      page.getByRole('heading', { name: 'Réinitialiser le mot de passe' })
    ).toBeVisible();

    await page.getByRole('button', { name: 'Renvoyer', exact: true }).click();
    await expect(
      page.getByText('Si un compte existe, un nouveau code a été envoyé.')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Renvoyer \(\d+s\)$/ })).toBeDisabled();
  });
});

test.describe('validations du formulaire d’inscription', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/register');
  });

  test('tous les champs et les CGU sont requis', async ({ page }) => {
    await submitRegister(page);
    // Nom d'utilisateur, prénom, nom, e-mail, mot de passe, confirmation.
    await expect(page.getByText('⚠ Requis', { exact: true })).toHaveCount(6);
    await expect(
      page.getByText("⚠ Vous devez accepter les conditions d'utilisation")
    ).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('e-mail invalide', async ({ page }) => {
    await fillRegister(page, { email: 'pas-un-courriel@domaine' });
    await page.getByRole('checkbox').check();
    await submitRegister(page);
    await expect(page.getByText('⚠ Format d’e-mail invalide')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('mot de passe trop faible', async ({ page }) => {
    await fillRegister(page, { password: 'abc' });
    await page.getByRole('checkbox').check();
    await submitRegister(page);
    await expect(page.getByText('⚠ Mot de passe trop faible')).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('confirmation différente : signalée dès la saisie puis à l’envoi', async ({ page }) => {
    await fillRegister(page, { confirm: 'Autre-Passw0rd!' });
    const mismatch = page.getByText('⚠ Les mots de passe ne correspondent pas');
    await expect(mismatch).toBeVisible();
    await page.getByRole('checkbox').check();
    await submitRegister(page);
    await expect(mismatch).toBeVisible();
    await expect(page).toHaveURL(/\/register$/);
  });

  test('CGU non cochées', async ({ page }) => {
    await fillRegister(page, {});
    await submitRegister(page);
    await expect(
      page.getByText("⚠ Vous devez accepter les conditions d'utilisation")
    ).toBeVisible();
    await expect(page.getByText('⚠ Requis', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/register$/);
  });

  // Barème : < 8 caractères = trop court ; sinon +1 pour un chiffre, +1 pour un caractère spécial.
  test('indicateur de force du mot de passe', async ({ page }) => {
    const password = page.getByPlaceholder('Choisissez un mot de passe');
    for (const [value, label] of [
      ['abc', 'Mot de passe trop court'],
      ['abcdefgh', 'Mot de passe faible'],
      ['abcdefg1', 'Mot de passe moyen'],
      ['abcdefg1!', 'Mot de passe fort'],
    ]) {
      await password.fill(value);
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await password.fill('');
    await expect(page.getByText(/^Mot de passe (trop court|faible|moyen|fort)$/)).toHaveCount(0);
  });

  test('les boutons œil affichent puis masquent chaque mot de passe', async ({ page }) => {
    for (const placeholder of ['Choisissez un mot de passe', 'Retapez votre mot de passe']) {
      const field = page.getByPlaceholder(placeholder);
      // Le bouton œil est le voisin du champ (même conteneur).
      const eye = field.locator('xpath=..').getByRole('button');
      await expect(field).toHaveAttribute('type', 'password');
      await expect(eye).toHaveAccessibleName('Afficher le mot de passe');
      await eye.click();
      await expect(field).toHaveAttribute('type', 'text');
      await expect(eye).toHaveAccessibleName('Masquer le mot de passe');
      await eye.click();
      await expect(field).toHaveAttribute('type', 'password');
    }
  });

  // Le bouton de thème n'existe avec un nom accessible que sur l'inscription ; le choix est
  // mémorisé dans localStorage (`moodit-theme`) et survit au rechargement.
  test('le bouton « Changer de thème » bascule et mémorise le thème', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Changer de thème' }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('moodit-theme'))).toBe('dark');

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Changer de thème' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => localStorage.getItem('moodit-theme'))).toBe('light');
  });
});

test.describe('validations du formulaire de connexion', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('e-mail et mot de passe requis', async ({ page }) => {
    await page.getByRole('button', { name: 'Se connecter →' }).click();
    await expect(page.getByText('⚠ L’adresse e-mail est requise')).toBeVisible();
    await expect(page.getByText('⚠ Le mot de passe est requis')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  // « a@b » passe la validation native du champ type=email mais pas celle de l'app (TLD exigé).
  test('e-mail invalide', async ({ page }) => {
    await page.getByPlaceholder('exemple@gmail.com').fill('a@b');
    await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter →' }).click();
    await expect(page.getByText('⚠ Format d’e-mail invalide')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  // L'œil de la connexion n'a pas de nom accessible : localisé par sa classe.
  test('le bouton œil affiche puis masque le mot de passe', async ({ page }) => {
    const field = page.getByPlaceholder('••••••••••');
    await field.fill(TEST_PASSWORD);
    await expect(field).toHaveAttribute('type', 'password');
    await page.locator('.eye-btn').click();
    await expect(field).toHaveAttribute('type', 'text');
    await page.locator('.eye-btn').click();
    await expect(field).toHaveAttribute('type', 'password');
  });
});

test.describe('liens entre les pages d’authentification', () => {
  test('connexion ⇄ inscription ⇄ mot de passe oublié', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Créer un compte' }).click();
    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('heading', { name: 'Créer un compte' })).toBeVisible();

    await page.getByRole('link', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Bon retour 👋' })).toBeVisible();

    await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByRole('link', { name: '← Retour à la connexion' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('/reset-password : « ← Retour à la connexion »', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByPlaceholder('exemple@usherbrooke.ca').fill(newUser().email);
    await page.getByRole('button', { name: 'Envoyer le code →' }).click();
    await expect(page).toHaveURL(/\/reset-password$/);
    await page.getByRole('link', { name: '← Retour à la connexion' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  // En mode inscription, « ← Retour » ramène à l'inscription et « Se connecter » est proposé.
  test('/verify-code (inscription) : « ← Retour » et « Se connecter »', async ({ page }) => {
    await page.goto('/register');
    await fillRegister(page, {});
    await page.getByRole('checkbox').check();
    await submitRegister(page);
    await expect(page.getByRole('heading', { name: 'Vérifiez votre email' })).toBeVisible();

    await page.getByRole('link', { name: '← Retour' }).click();
    await expect(page).toHaveURL(/\/register$/);

    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Vérifiez votre email' })).toBeVisible();
    await page.getByRole('link', { name: 'Se connecter' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  // En 2FA, « ← Retour » ramène à la connexion et le lien « Se connecter » n'a pas lieu d'être.
  test('/verify-code (2FA) : « ← Retour » ramène à la connexion', async ({ page, baseURL }) => {
    const { user } = await createEnrolledUser(baseURL!);
    await page.goto('/login');
    await page.getByPlaceholder('exemple@gmail.com').fill(user.email);
    await page.getByPlaceholder('••••••••••').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Se connecter →' }).click();
    await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Se connecter' })).toHaveCount(0);

    await page.getByRole('link', { name: '← Retour' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('redirections du routeur', () => {
  // Sans l'e-mail passé par la page précédente (state de navigation), ces pages ne peuvent rien
  // vérifier : elles renvoient à l'étape d'avant.
  test('/verify-code sans état renvoie à la connexion', async ({ page }) => {
    await page.goto('/verify-code');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('/reset-password sans état renvoie à « mot de passe oublié »', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page).toHaveURL(/\/forgot-password$/);
  });

  test('une route inconnue renvoie à la connexion', async ({ page }) => {
    await page.goto('/route-qui-n-existe-pas');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('« / » mène à /home', async ({ browser, baseURL }) => {
    const { storageState } = await createEnrolledUser(baseURL!);
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveURL(/\/home(\/|$)/);
    await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible();
    await context.close();
  });
});
