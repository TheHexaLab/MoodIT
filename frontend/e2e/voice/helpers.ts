import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { storageStatePath } from '../setup/accounts';

export const PROGRAM_NAME = process.env.E2E_PROGRAM_NAME ?? 'Génie informatique';
export const VOICE_CHANNEL = process.env.E2E_VOICE_CHANNEL ?? 'Vocal - Mathématiques pour ingénieurs I';

/** Contexte navigateur connecté avec le compte `key` (session préparée par global-setup). */
export async function loggedInContext(browser: Browser, key: string): Promise<BrowserContext> {
  return browser.newContext({ storageState: storageStatePath(key) });
}

/** Ouvre le salon vocal de test et le rejoint ; attend la connexion chiffrée. */
export async function joinVoice(page: Page): Promise<void> {
  await page.goto('/home');
  await page.getByRole('button', { name: PROGRAM_NAME }).click();
  await page.getByRole('button', { name: VOICE_CHANNEL }).click();
  await page.getByRole('button', { name: 'Rejoindre le vocal' }).click();
  await expect(page.getByText('🔒 Chiffré de bout en bout')).toBeVisible();
}

export async function leaveVoice(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Quitter' }).click();
  await expect(page.getByRole('button', { name: 'Rejoindre le vocal' })).toBeVisible();
}

/**
 * Révoque les appareils actifs du compte de ce contexte. Chaque contexte Playwright est un
 * navigateur neuf, donc un NOUVEL appareil : sans ménage, un run complet (plusieurs navigateurs
 * × plusieurs contextes par test) dépasse le plafond de 20 appareils actifs par compte.
 */
async function revokeDevices(ctx: BrowserContext): Promise<void> {
  const res = await ctx.request.get('/api/keys/my-devices');
  if (!res.ok()) return;
  for (const d of (await res.json()) as { deviceId: string; revokedAt: string | null }[]) {
    if (!d.revokedAt) await ctx.request.delete(`/api/keys/devices/${d.deviceId}`);
  }
}

/**
 * Quitte proprement le salon (si on y est), révoque les appareils puis ferme les contextes.
 * Fermer un contexte SANS quitter laisse un participant « fantôme » ~20 s côté LiveKit (pas de
 * signal de départ), qui polluerait le test suivant.
 */
export async function closeAll(contexts: BrowserContext[]): Promise<void> {
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      const quit = page.getByRole('button', { name: 'Quitter' });
      if (await quit.isVisible().catch(() => false)) await leaveVoice(page).catch(() => {});
    }
  }
  for (const ctx of contexts) await revokeDevices(ctx).catch(() => {});
  await Promise.all(contexts.map((c) => c.close()));
}

/** Ligne d'un participant dans le panneau vocal (nom affiché = username). */
export const participantRow = (page: Page, username: string) =>
  page.locator('li', { hasText: username });

/** Le participant est présent ET on détient sa clé média (ni « ⏳ clé » ni appareil refusé). */
export async function expectKeyReady(page: Page, username: string): Promise<void> {
  const row = participantRow(page, username);
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('⏳ clé');
  await expect(row).not.toContainText('appareil refusé');
  await expect(row).not.toContainText('clé changée');
}

/**
 * Niveau sonore MAX (RMS, 0..1) des flux audio distants lus par la page, mesuré pendant
 * `durationMs` via WebAudio. Les trames que le navigateur n'arrive pas à déchiffrer sont jetées
 * par le worker E2EE → silence (≈0). Un niveau nettement > 0 prouve donc un audio DÉCHIFFRÉ
 * (le micro simulé de Chromium/Firefox émet une tonalité).
 */
export async function measureRemoteAudio(page: Page, durationMs = 2500): Promise<number> {
  return page.evaluate(async (duration) => {
    const streams = Array.from(document.querySelectorAll('audio'))
      .map((el) => el.srcObject)
      .filter((s): s is MediaStream => s instanceof MediaStream);
    if (streams.length === 0) return 0;

    const ctx = new AudioContext();
    await ctx.resume();
    const analysers = streams.map((stream) => {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      return analyser;
    });

    let max = 0;
    const buf = new Float32Array(2048);
    const end = performance.now() + duration;
    while (performance.now() < end) {
      for (const a of analysers) {
        a.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        max = Math.max(max, rms);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    await ctx.close();
    return max;
  }, durationMs);
}

/** Seuil au-dessus duquel on considère entendre un signal (le silence mesure ~0). */
export const AUDIBLE_RMS = 0.01;

/** Attend que la page entende un signal déchiffré (plusieurs fenêtres de mesure si besoin). */
export async function expectHearsAudio(page: Page): Promise<void> {
  await expect
    .poll(() => measureRemoteAudio(page), {
      timeout: 20_000,
      intervals: [500],
      message: 'aucun audio déchiffré reçu',
    })
    .toBeGreaterThan(AUDIBLE_RMS);
}

/** <video> d'une tuile (aria-label = nom affiché, ex. « e2e_alice » ou « Écran de e2e_alice »). */
export const videoTile = (page: Page, label: string) => page.locator(`video[aria-label="${label}"]`);

/**
 * La vidéo `label` DÉCODE des images en continu. Comme pour l'audio, une trame que le worker E2EE
 * n'arrive pas à déchiffrer est jetée : sans la bonne clé, l'image reste figée / noire (0 image
 * décodée). On mesure le nombre d'images décodées sur 1 s via getVideoPlaybackQuality().
 */
export async function expectVideoDecoding(page: Page, label: string): Promise<void> {
  const video = videoTile(page, label);
  await expect(video).toBeVisible();
  await expect
    .poll(
      () =>
        video.evaluate(async (v: HTMLVideoElement) => {
          const before = v.getVideoPlaybackQuality().totalVideoFrames;
          await new Promise((r) => setTimeout(r, 1000));
          const after = v.getVideoPlaybackQuality().totalVideoFrames;
          return v.videoWidth > 0 ? after - before : 0;
        }),
      { timeout: 20_000, intervals: [500], message: `aucune image déchiffrée pour « ${label} »` }
    )
    .toBeGreaterThan(3);
}
