import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { TEST_COURSE_ID } from '../setup/accounts';
import { TEST_ROOM, emptyTestRoom, roomExists } from '../setup/livekit-admin';
import {
  AUDIBLE_RMS,
  PROGRAM_NAME,
  closeAll,
  expectHearsAudio,
  expectKeyReady,
  joinVoice,
  loggedInContext,
  measureRemoteAudio,
  participantRow,
} from './helpers';

/**
 * Modération vocale, NIVEAU BACKEND (voice-service VoiceModerationController) : les actions sont
 * appelées par l'API, comme le fera l'UI. e2e_carol est Enseignante du programme de test
 * (e2e/setup/dev-db.sql) donc modératrice ; e2e_bob est un simple étudiant.
 */

const CHANNEL_ID = Number(TEST_ROOM.split(':')[1]);
const moderation = (channelId: number, userId: number, action: 'mute' | 'kick') =>
  `/api/voice/channels/${channelId}/participants/${userId}/${action}`;

async function userId(ctx: BrowserContext): Promise<number> {
  const res = await ctx.request.get('/api/me');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: number }).id;
}

/** La page n'entend plus rien de façon STABLE (plusieurs fenêtres de mesure silencieuses). */
async function expectSilence(page: Page): Promise<void> {
  await expect
    .poll(() => measureRemoteAudio(page, 1500), { timeout: 15_000, intervals: [250] })
    .toBeLessThan(AUDIBLE_RMS);
  expect(await measureRemoteAudio(page, 2500)).toBeLessThan(AUDIBLE_RMS);
}

test.describe('vocal — modération (backend)', () => {
  test.beforeEach(async () => emptyTestRoom());
  test.afterEach(async () => emptyTestRoom()); // efface aussi les server-mutes (métadonnées)

  test.skip(({ browserName }) => browserName === 'firefox', 'WebRTC KO dans le Firefox de Playwright');

  test('server-mute : coupé, impossible à réactiver, survit à une reconnexion, puis levé', async ({
    browser,
  }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    const carol = await loggedInContext(browser, 'carol');
    try {
      const aliceId = await userId(alice);
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);
      await expectKeyReady(pb, 'e2e_alice');
      await expectHearsAudio(pb);

      // Un étudiant ne peut pas modérer (gateway → permission-service, 403).
      expect((await bob.request.post(moderation(CHANNEL_ID, aliceId, 'mute'))).status()).toBe(403);

      // La modératrice (pas besoin d'être dans le salon) coupe Alice.
      const mute = await carol.request.post(moderation(CHANNEL_ID, aliceId, 'mute'));
      expect(mute.status(), await mute.text()).toBe(204);
      await expectSilence(pb);
      await expect(participantRow(pb, 'e2e_alice')).toContainText('muet');

      // Alice tente de se réactiver : le serveur le lui interdit, Bob n'entend toujours rien.
      await pa.getByRole('button', { name: '🔇 Activer le micro' }).click();
      await expectSilence(pb);

      // Reconnexion : le nouveau JoinToken n'autorise toujours pas le micro.
      await pa.getByRole('button', { name: 'Quitter' }).click();
      await pa.getByRole('button', { name: 'Rejoindre le vocal' }).click();
      await expect(pa.getByText('🔒 Chiffré de bout en bout')).toBeVisible();
      await expectKeyReady(pb, 'e2e_alice');
      await expectSilence(pb);

      // Levée du mute : Alice PEUT réactiver son micro (on ne le rallume pas à sa place).
      const unmute = await carol.request.delete(moderation(CHANNEL_ID, aliceId, 'mute'));
      expect(unmute.status(), await unmute.text()).toBe(204);
      const toggle = pa.getByRole('button', { name: /Activer le micro|Couper le micro/ });
      if ((await toggle.textContent())?.includes('Activer')) await toggle.click();
      await expectHearsAudio(pb);
    } finally {
      await closeAll([alice, bob, carol]);
    }
  });

  test('expulsion : tous les appareils sont déconnectés, la personne peut revenir', async ({
    browser,
  }) => {
    const bobLaptop = await loggedInContext(browser, 'bob');
    const bobPhone = await loggedInContext(browser, 'bob');
    const alice = await loggedInContext(browser, 'alice');
    const carol = await loggedInContext(browser, 'carol');
    try {
      const bobId = await userId(bobLaptop);
      const laptop = await bobLaptop.newPage();
      const phone = await bobPhone.newPage();
      const pa = await alice.newPage();
      await joinVoice(laptop);
      await joinVoice(phone);
      await joinVoice(pa);
      await expect(participantRow(pa, 'e2e_bob')).toHaveCount(2);

      // Un étudiant ne peut pas expulser.
      expect((await alice.request.post(moderation(CHANNEL_ID, bobId, 'kick'))).status()).toBe(403);

      const kick = await carol.request.post(moderation(CHANNEL_ID, bobId, 'kick'));
      expect(kick.status(), await kick.text()).toBe(200);
      expect(await kick.json()).toEqual({ removedDevices: 2 });

      await expect(laptop.getByRole('button', { name: 'Rejoindre le vocal' })).toBeVisible();
      await expect(phone.getByRole('button', { name: 'Rejoindre le vocal' })).toBeVisible();
      await expect(participantRow(pa, 'e2e_bob')).toHaveCount(0);

      // Personne dans le salon → 404 explicite.
      expect((await carol.request.post(moderation(CHANNEL_ID, bobId, 'kick'))).status()).toBe(404);

      // Pas un bannissement : Bob peut revenir.
      await laptop.getByRole('button', { name: 'Rejoindre le vocal' }).click();
      await expect(laptop.getByText('🔒 Chiffré de bout en bout')).toBeVisible();
      await expectKeyReady(pa, 'e2e_bob');
    } finally {
      await closeAll([bobLaptop, bobPhone, alice, carol]);
    }
  });

  test('supprimer un canal vocal ferme son salon LiveKit', async ({ browser }) => {
    const alice = await loggedInContext(browser, 'alice');
    const carol = await loggedInContext(browser, 'carol');
    const name = `Vocal e2e ${Date.now()}`;
    let channelId: string | undefined;
    try {
      // La modératrice (Enseignante) crée un canal vocal via l'éditeur de section.
      const created = await carol.request.patch(`/api/courses/${TEST_COURSE_ID}/sections`, {
        data: { sectionType: 'voice', change: { type: 'create', item: { id: 'tmp', name } } },
      });
      expect(created.ok(), await created.text()).toBeTruthy();
      channelId = ((await created.json()) as { item: { id: string } }).item.id;
      const room = `channel:${channelId}`;

      const pa = await alice.newPage();
      await pa.goto('/home');
      await pa.getByRole('button', { name: PROGRAM_NAME }).click();
      await pa.getByRole('button', { name }).click();
      await pa.getByRole('button', { name: 'Rejoindre le vocal' }).click();
      await expect(pa.getByText('🔒 Chiffré de bout en bout')).toBeVisible();
      expect(await roomExists(room)).toBe(true);

      const deleted = await carol.request.patch(`/api/courses/${TEST_COURSE_ID}/sections`, {
        data: { sectionType: 'voice', change: { type: 'delete', id: channelId } },
      });
      expect(deleted.ok(), await deleted.text()).toBeTruthy();
      channelId = undefined;

      // DeleteRoom côté serveur : le salon DISPARAÎT. (Si seule l'UI quittait le salon en
      // retirant le canal, LiveKit le garderait vide ~5 min : ce test le distinguerait.)
      await expect.poll(() => roomExists(room), { timeout: 10_000 }).toBe(false);
    } finally {
      if (channelId) {
        await carol.request.patch(`/api/courses/${TEST_COURSE_ID}/sections`, {
          data: { sectionType: 'voice', change: { type: 'delete', id: channelId } },
        });
      }
      await closeAll([alice, carol]);
    }
  });
});
