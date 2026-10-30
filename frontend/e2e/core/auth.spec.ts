import { expect, test, type Page } from './fixtures';
import { TEST_PASSWORD } from '../setup/accounts';
import {
  MAIL_DOMAIN,
  createEnrolledUser,
  enterCode,
  loginThroughUi,
  newUser,
  readCodeFromMail,
} from './helpers';

async function fillLogin(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByPlaceholder('exemple@gmail.com').fill(email);
  await page.getByPlaceholder('••••••••••').fill(password);
  await page.getByRole('button', { name: 'Se connecter →' }).click();
}

// Parcours réel complet : le code de validation est lu dans le courriel (Mailpit), et la
// validation connecte directement.
test('inscription validée par le code reçu par courriel', async ({ page }) => {
  const user = newUser(MAIL_DOMAIN);

  await page.goto('/register');
  await page.getByPlaceholder('ex : RKarine').fill(user.username);
  await page.getByPlaceholder('ex: Karine', { exact: true }).fill('Dora');
  await page.getByPlaceholder('ex: Roussel').fill('E2E');
  await page.getByPlaceholder('ex: Karine_Roussel@usherbrooke.ca').fill(user.email);
  await page.getByPlaceholder('Choisissez un mot de passe').fill(TEST_PASSWORD);
  await page.getByPlaceholder('Retapez votre mot de passe').fill(TEST_PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Créer mon compte →' }).click();

  await expect(page.getByRole('heading', { name: 'Vérifiez votre email' })).toBeVisible();
  await enterCode(page, await readCodeFromMail(user.email, 'Code de vérification'));

  await expect(page).toHaveURL(/\/home(\/|$)/);
  await expect(page.getByRole('heading', { name: 'Bienvenue sur MoodIT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toContainText(
    `@${user.username}`
  );
});

test('connexion avec 2FA', async ({ page, baseURL }) => {
  const { user } = await createEnrolledUser(baseURL!);
  await loginThroughUi(page, user.email);
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toContainText(
    `@${user.username}`
  );
});

test('un mauvais mot de passe est refusé', async ({ page, baseURL }) => {
  const { user } = await createEnrolledUser(baseURL!);
  await fillLogin(page, user.email, 'Mauvais-Passw0rd!');
  await expect(page.getByText('Email ou mot de passe invalide')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

// Compte neuf : les essais ratés s'accumulent par compte (verrou 2FA), un compte partagé finirait
// verrouillé au fil des exécutions locales.
test('un mauvais code 2FA ne connecte pas', async ({ page, baseURL }) => {
  const { user } = await createEnrolledUser(baseURL!);
  await fillLogin(page, user.email, TEST_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();

  await enterCode(page, '123456');
  // Attendre le refus AVANT de ressaisir : pendant la vérification, la page ignore la saisie.
  await expect(page.getByText('Code invalide ou expiré.')).toBeVisible();
  await expect(page).toHaveURL(/\/verify-code$/);

  // Le bon code passe toujours ensuite (un seul essai raté reste sous le plafond).
  await enterCode(page);
  await expect(page).toHaveURL(/\/home(\/|$)/);
});

test('mot de passe oublié : réinitialisation par le code reçu par courriel', async ({
  page,
  baseURL,
}) => {
  const { user } = await createEnrolledUser(baseURL!, MAIL_DOMAIN);
  const newPassword = 'Nouv3au-Passw0rd!';

  await page.goto('/login');
  await page.getByRole('link', { name: 'Mot de passe oublié ?' }).click();
  await page.getByPlaceholder('exemple@usherbrooke.ca').fill(user.email);
  await page.getByRole('button', { name: 'Envoyer le code →' }).click();

  await expect(page.getByRole('heading', { name: 'Réinitialiser le mot de passe' })).toBeVisible();
  const code = await readCodeFromMail(user.email, 'Réinitialisation du mot de passe');
  await enterCode(page, code);
  const passwords = page.getByPlaceholder('••••••••••');
  await passwords.nth(0).fill(newPassword);
  await passwords.nth(1).fill(newPassword);
  await page.getByRole('button', { name: 'Réinitialiser →' }).click();

  // L'ancien mot de passe ne passe plus, le nouveau oui.
  await fillLogin(page, user.email, TEST_PASSWORD);
  await expect(page.getByText('Email ou mot de passe invalide')).toBeVisible();
  await fillLogin(page, user.email, newPassword);
  await expect(page.getByRole('heading', { name: 'Double authentification' })).toBeVisible();
  await enterCode(page);
  await expect(page).toHaveURL(/\/home(\/|$)/);
});

test('une page protégée sans session renvoie à la connexion', async ({ page }) => {
  await page.goto('/home');
  await expect(page).toHaveURL(/\/login$/);
});
