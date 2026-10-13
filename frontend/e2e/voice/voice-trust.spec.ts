import { expect, test } from '@playwright/test';
import { emptyTestRoom } from '../setup/livekit-admin';
import {
  PROGRAM_NAME,
  VOICE_CHANNEL,
  closeAll,
  expectKeyReady,
  joinVoice,
  loggedInContext,
  participantRow,
} from './helpers';

/**
 * Confiance dans les appareils (voice-service/E2EE.md §5.3, étape E3) : codes de sécurité et
 * révocation avec éjection immédiate.
 */
test.describe('vocal chiffré — confiance', () => {
  // Chaque test part d'un salon VIDE (pas de fantôme laissé par un test précédent).
  test.beforeEach(async () => emptyTestRoom());

  test.skip(({ browserName }) => browserName === 'firefox', 'WebRTC KO dans le Firefox de Playwright');

  test('le code de sécurité est identique des deux côtés et « vérifié » s’affiche', async ({
    browser,
  }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);
      await expectKeyReady(pa, 'e2e_bob');
      await expectKeyReady(pb, 'e2e_alice');

      await participantRow(pa, 'e2e_bob').getByRole('button', { name: 'Vérifier' }).click();
      await participantRow(pb, 'e2e_alice').getByRole('button', { name: 'Vérifier' }).click();
      const codeA = await pa.getByTestId('safety-code').textContent();
      const codeB = await pb.getByTestId('safety-code').textContent();
      expect(codeA).toMatch(/^(\d{5} ){11}\d{5}$/);
      expect(codeA).toBe(codeB);

      await pa.getByRole('button', { name: 'Les codes correspondent' }).click();
      await expect(participantRow(pa, 'e2e_bob')).toContainText('✔ vérifié');
      // Vérification LOCALE : Bob n'a rien confirmé de son côté.
      await expect(participantRow(pb, 'e2e_alice')).not.toContainText('✔ vérifié');
    } finally {
      await closeAll([alice, bob]);
    }
  });

  test('révoquer un appareil depuis un autre navigateur l’éjecte du salon', async ({ browser }) => {
    const aliceLaptop = await loggedInContext(browser, 'alice');
    const alicePhone = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const laptop = await aliceLaptop.newPage();
      const pb = await bob.newPage();
      await joinVoice(laptop);
      await joinVoice(pb);
      await expectKeyReady(pb, 'e2e_alice');

      // Depuis un AUTRE appareil d'Alice : « Mes appareils » → révoquer tous les autres.
      const phone = await alicePhone.newPage();
      await phone.goto('/home');
      await phone.getByRole('button', { name: PROGRAM_NAME }).click();
      await phone.getByRole('button', { name: VOICE_CHANNEL }).click();
      await phone.getByRole('button', { name: 'Mes appareils' }).click();
      const devices = phone.getByRole('region', { name: 'Mes appareils' });
      await expect(devices.getByText('(cet appareil)')).toBeVisible();
      while ((await devices.getByRole('button', { name: 'Révoquer' }).count()) > 0) {
        await devices.getByRole('button', { name: 'Révoquer' }).first().click();
        await devices.getByRole('button', { name: 'Confirmer la révocation' }).click();
        // Attend la fin de la révocation (liste rechargée) avant de viser le bouton suivant.
        await expect(devices).toHaveAttribute('aria-busy', 'false');
      }

      // Le portable est éjecté par le serveur ; Bob ne le voit plus.
      await expect(laptop.getByRole('button', { name: 'Rejoindre le vocal' })).toBeVisible();
      await expect(participantRow(pb, 'e2e_alice')).toHaveCount(0);
    } finally {
      await closeAll([aliceLaptop, alicePhone, bob]);
    }
  });
});
