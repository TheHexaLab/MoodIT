import { test as base } from '@playwright/test';

// Les specs de e2e/core importent `test` (et le reste de Playwright) d'ici.
export * from '@playwright/test';

/**
 * `test` de Playwright + fermeture automatique, après CHAQUE test, des contextes navigateur qu'il a
 * ouverts lui-même (`browser.newContext`, 2e utilisateur…). Sans ça, un test qui échoue — y compris
 * un `test.fail` attendu — s'arrête avant ses `close()` : ses pages restent ouvertes pour la suite
 * du worker, gardent leur WebSocket et polluent les captures d'échec des tests suivants.
 */
export const test = base.extend<{ closeOpenedContexts: void }>({
  closeOpenedContexts: [
    async ({ browser, context }, use) => {
      await use();
      for (const opened of browser.contexts()) {
        if (opened !== context) await opened.close().catch(() => {});
      }
    },
    { auto: true },
  ],
});
