import { test } from '@playwright/test';
import { emptyTestRoom } from '../setup/livekit-admin';
import {
  closeAll,
  expectHearsAudio,
  expectKeyReady,
  joinVoice,
  leaveVoice,
  loggedInContext,
} from './helpers';

/**
 * Vocal chiffré de bout en bout (voice-service/E2EE.md), dans un vrai navigateur, contre la stack
 * de dev. Le micro est simulé (tonalité) ; « entendre » = mesurer un signal DÉCHIFFRÉ (helpers).
 */

test.describe('vocal chiffré', () => {
  // Chaque test part d'un salon VIDE (pas de fantôme laissé par un test précédent).
  test.beforeEach(async () => emptyTestRoom());

  // ⚠ Firefox de Playwright (build modifié « Juggler ») : la connexion WebRTC au LiveKit de dev
  // échoue (« ICE failed », aucun candidat reçu côté serveur), même avec loopback/mDNS/IP LAN.
  // Un VRAI Firefox fonctionne (validé à la main au spike E0). À réessayer à chaque mise à jour.
  test.skip(({ browserName }) => browserName === 'firefox', 'WebRTC KO dans le Firefox de Playwright');

  test('deux comptes se rejoignent, échangent leurs clés et s’entendent', async ({ browser }) => {
    const alice = await loggedInContext(browser, 'alice');
    const bob = await loggedInContext(browser, 'bob');
    try {
      const pa = await alice.newPage();
      const pb = await bob.newPage();
      await joinVoice(pa);
      await joinVoice(pb);

      await expectKeyReady(pa, 'e2e_bob');
      await expectKeyReady(pb, 'e2e_alice');
      await expectHearsAudio(pa);
      await expectHearsAudio(pb);
    } finally {
      await closeAll([alice, bob]);
    }
  });

  test('arrivée puis départ d’un 3e participant : les clés tournent, tout le monde s’entend encore', async ({
    browser,
  }) => {
    const ctxs = await Promise.all(['alice', 'bob', 'carol'].map((k) => loggedInContext(browser, k)));
    try {
      const [pa, pb, pc] = await Promise.all(ctxs.map((c) => c.newPage()));
      await joinVoice(pa);
      await joinVoice(pb);
      await expectKeyReady(pa, 'e2e_bob');

      // Arrivée de Carol → rotation chez tous ; les trois doivent s'entendre.
      await joinVoice(pc);
      for (const [page, others] of [
        [pa, ['e2e_bob', 'e2e_carol']],
        [pb, ['e2e_alice', 'e2e_carol']],
        [pc, ['e2e_alice', 'e2e_bob']],
      ] as const) {
        for (const name of others) await expectKeyReady(page, name);
        await expectHearsAudio(page);
      }

      // Départ de Carol → nouvelle rotation ; Alice et Bob s'entendent toujours (nouvelles clés).
      await leaveVoice(pc);
      await expectHearsAudio(pa);
      await expectHearsAudio(pb);
    } finally {
      await closeAll(ctxs);
    }
  });

  test('le même compte dans deux navigateurs : deux appareils distincts qui s’entendent', async ({
    browser,
  }) => {
    // Avant E1, l'identité LiveKit était l'email : la 2e connexion éjectait la 1re.
    const first = await loggedInContext(browser, 'alice');
    const second = await loggedInContext(browser, 'alice');
    try {
      const p1 = await first.newPage();
      const p2 = await second.newPage();
      // Chaque contexte Playwright a sa propre IndexedDB = un appareil distinct.
      await joinVoice(p1);
      await joinVoice(p2);
      await expectHearsAudio(p1);
      await expectHearsAudio(p2);
    } finally {
      await closeAll([first, second]);
    }
  });
});

test.describe('vocal chiffré — inter-navigateurs', () => {
  test.beforeEach(async () => emptyTestRoom());
  // Les options de contexte du projet s'appliqueraient aussi aux navigateurs lancés ici.
  test.use({ permissions: [] });

  test('Chrome et Edge dans le même salon s’entendent', async ({ playwright }, info) => {
    // Lance lui-même ses navigateurs : on ne l'exécute qu'une fois (projet chromium).
    test.skip(info.project.name !== 'chromium', 'scénario inter-navigateurs lancé une seule fois');

    const args = [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ];
    const chrome = await playwright.chromium.launch({ args });
    const edge = await playwright.chromium.launch({ channel: 'msedge', args });
    try {
      const baseURL = info.project.use.baseURL;
      const open = async (b: typeof chrome, key: string) =>
        (await b.newContext({ baseURL, storageState: `e2e/.auth/${key}.json` })).newPage();
      const pages = [await open(chrome, 'alice'), await open(edge, 'bob'), await open(edge, 'carol')];

      for (const p of pages) await joinVoice(p);
      await expectKeyReady(pages[0], 'e2e_bob');
      await expectKeyReady(pages[1], 'e2e_carol');
      await expectKeyReady(pages[2], 'e2e_alice');
      for (const p of pages) await expectHearsAudio(p);
    } finally {
      await closeAll([...chrome.contexts(), ...edge.contexts()]);
      await Promise.all([chrome.close(), edge.close()]);
    }
  });
});
