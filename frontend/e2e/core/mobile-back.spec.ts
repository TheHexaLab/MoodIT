import { devices, expect, test } from './fixtures';
import { createEnrolledUser, loginThroughUi } from './helpers';

// Bogue #63 : toute l'app vit sous /home et la connexion empile /login puis /verify-code dans
// l'historique. Le bouton « back » du téléphone ramène alors à l'écran de code : impression de
// déconnexion. `test.fail` : ce test DOIT échouer tant que #63 n'est pas corrigé. Le jour où il
// passe, Playwright le signale en rouge → retirer `test.fail` dans la PR qui corrige #63.

// Émulation téléphone, sans `defaultBrowserType` (interdit dans un test.use de fichier).
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch });

test('« back » après connexion ne ramène pas à un écran d’authentification', async ({
  page,
  browserName,
  baseURL,
}) => {
  test.skip(browserName === 'firefox', 'Firefox ne prend pas en charge isMobile.');
  test.fail(true, 'Bogue #63 non corrigé');

  const { user } = await createEnrolledUser(baseURL!);
  await loginThroughUi(page, user.email);
  await page.goBack();

  // Délais courts : la navigation arrière est immédiate, et tant que #63 est ouvert ce test échoue
  // à chaque exécution (inutile d'attendre le délai par défaut de 15 s).
  await expect(page).not.toHaveURL(/\/(login|verify-code|register)$/, { timeout: 3_000 });
  await expect(page.getByRole('button', { name: 'Compte utilisateur' })).toBeVisible({
    timeout: 3_000,
  });
});
