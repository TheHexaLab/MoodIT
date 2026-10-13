import { expect, test } from '@playwright/test';
import { emptyTestRoom } from '../setup/livekit-admin';
import {
  closeAll,
  expectKeyReady,
  expectVideoDecoding,
  joinVoice,
  loggedInContext,
  videoTile,
} from './helpers';

/**
 * Caméra et partage d'écran, chiffrés de bout en bout comme l'audio (même clé média par
 * participant). « Voir » = des images DÉCODÉES en continu côté récepteur (cf. helpers).
 * Chromium/Edge fournissent une fausse caméra et un faux écran (flags du projet).
 */
test.describe('vocal chiffré — vidéo', () => {
  test.skip(({ browserName }) => browserName === 'firefox', 'WebRTC KO dans le Firefox de Playwright');
  test.beforeEach(async () => emptyTestRoom());

  test('caméra : Bob voit (et déchiffre) la caméra d’Alice, qui se voit en miroir', async ({
    browser,
  }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);
      await expectKeyReady(pb, 'e2e_alice');

      await pa.getByRole('button', { name: '📷 Activer la caméra' }).click();
      await expectVideoDecoding(pa, 'e2e_alice (moi)');
      await expect(videoTile(pa, 'e2e_alice (moi)')).toHaveClass(/mirrored/);
      await expectVideoDecoding(pb, 'e2e_alice');

      await pa.getByRole('button', { name: '📷 Couper la caméra' }).click();
      await expect(videoTile(pb, 'e2e_alice')).toHaveCount(0);
    } finally {
      await closeAll([alice, bob]);
    }
  });

  test('partage d’écran : affiché en grand et déchiffré chez les autres', async ({ browser }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);
      await expectKeyReady(pb, 'e2e_alice');

      await pa.getByRole('button', { name: "🖥️ Partager l'écran" }).click();
      await expectVideoDecoding(pb, 'Écran de e2e_alice');

      await pa.getByRole('button', { name: '🖥️ Arrêter le partage' }).click();
      await expect(videoTile(pb, 'Écran de e2e_alice')).toHaveCount(0);
    } finally {
      await closeAll([alice, bob]);
    }
  });

  test('partage arrêté par la barre NATIVE du navigateur : plus de carré noir chez personne', async ({
    browser,
  }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);
      await pa.getByRole('button', { name: "🖥️ Partager l'écran" }).click();
      await expectVideoDecoding(pb, 'Écran de e2e_alice');

      // « Arrêter le partage » de Chrome = le navigateur termine la piste (évènement 'ended').
      await videoTile(pa, 'Écran de e2e_alice (moi)').evaluate((v: HTMLVideoElement) => {
        (v.srcObject as MediaStream).getVideoTracks().forEach((t) => {
          t.stop();
          t.dispatchEvent(new Event('ended'));
        });
      });

      // Régression : Bob gardait un carré noir (TrackUnpublished n'était pas écouté).
      await expect(videoTile(pb, 'Écran de e2e_alice')).toHaveCount(0);
      await expect(videoTile(pa, 'Écran de e2e_alice (moi)')).toHaveCount(0);
      await expect(pa.getByRole('button', { name: "🖥️ Partager l'écran" })).toBeVisible();
    } finally {
      await closeAll([alice, bob]);
    }
  });

  test('un arrivant reçoit la clé tournée et déchiffre la vidéo déjà en cours', async ({
    browser,
  }) => {
    const ctxs = await Promise.all(['alice', 'bob', 'carol'].map((k) => loggedInContext(browser, k)));
    try {
      const [pa, pb, pc] = await Promise.all(ctxs.map((c) => c.newPage()));
      await joinVoice(pa);
      await joinVoice(pb);
      await pa.getByRole('button', { name: '📷 Activer la caméra' }).click();
      await expectVideoDecoding(pb, 'e2e_alice');

      // Carol arrive PENDANT la vidéo → rotation des clés ; elle doit déchiffrer avec la nouvelle.
      await joinVoice(pc);
      await expectVideoDecoding(pc, 'e2e_alice');
      await expectVideoDecoding(pb, 'e2e_alice');
    } finally {
      await closeAll(ctxs);
    }
  });
});
