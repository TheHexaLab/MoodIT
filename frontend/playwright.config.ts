import { defineConfig, devices } from '@playwright/test';

/**
 * Tests E2E (Playwright) contre la stack de DEV lancée en local. Pas de `webServer` : l'app
 * dépend de plusieurs services (gateway, auth, core, permission, voice, LiveKit) qu'on lance à
 * part — cf. e2e/README.md. Les comptes de test sont préparés par e2e/setup/global-setup.ts.
 */

/** Micro simulé + lecture audio sans geste utilisateur (Chromium / Edge). */
const chromiumMedia = {
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
};

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup/global-setup.ts',
  // Les tests vocaux partagent les mêmes salons et comptes : pas de parallélisme.
  fullyParallel: false,
  workers: 1,
  // Scénarios à 3 navigateurs (connexion + échange de clés + mesure audio par participant).
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  outputDir: 'e2e/results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...chromiumMedia } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge', ...chromiumMedia } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            'media.autoplay.default': 0,
          },
        },
      },
    },
  ],
});
