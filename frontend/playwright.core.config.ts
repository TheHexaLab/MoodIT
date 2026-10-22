import { defineConfig, devices } from '@playwright/test';
import baseConfig from './playwright.config';

/**
 * Configuration des tests E2E du tronc commun (e2e/core), utilisée par la CI :
 *   npx playwright test --config playwright.core.config.ts --project=<profil>
 * Étend playwright.config.ts (comptes de test, rapport, délais) et remplace ses projets par des
 * profils d'appareils. Les points de rupture CSS du frontend : 900 px (barre latérale en tiroir),
 * 1024 px, 768 px, 480 px et 360 px.
 *
 *  - desktop-* : toute la suite, sur les trois moteurs (Chromium, Firefox, WebKit).
 *  - tablet-* / mobile-* : la suite « responsive » (e2e/core/responsive/) ; les autres tests
 *    pilotent l'application en disposition de bureau.
 */
const RESPONSIVE = /e2e[\\/]core[\\/]responsive[\\/]/;

/** `defaultBrowserType` est interdit dans `use` d'un projet : on ne garde que l'émulation. */
const emulation = (name: keyof typeof devices) => {
  const { defaultBrowserType, ...rest } = devices[name];
  return { use: rest, browser: defaultBrowserType };
};

const deviceProject = (project: string, name: keyof typeof devices) => {
  const { use, browser } = emulation(name);
  return { name: project, use: { ...use, browserName: browser }, testMatch: RESPONSIVE };
};

export default defineConfig({
  ...baseConfig,
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
    deviceProject('tablet-portrait', 'iPad Mini'), // 768 px : tiroir, règles ≤ 768 px
    deviceProject('tablet-landscape', 'iPad Mini landscape'), // 1024 px : barre fixe, règles ≤ 1024 px
    deviceProject('mobile-chromium', 'Pixel 7'), // 412 px
    deviceProject('mobile-webkit', 'iPhone 14'), // 390 px
    deviceProject('mobile-small', 'Galaxy S8'), // 360 px : règles ≤ 360 px
  ],
});
