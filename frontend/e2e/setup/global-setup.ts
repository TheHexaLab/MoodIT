import { request, type APIRequestContext, type FullConfig } from '@playwright/test';
import {
  ACCOUNTS,
  DEV_2FA_CODE,
  TEST_PASSWORD,
  TEST_COURSE_ID,
  TEST_PROGRAM_ID,
  storageStatePath,
  type TestAccount,
} from './accounts';

/**
 * Prépare les comptes de test (idempotent) et enregistre leur session (cookie HttpOnly) dans
 * e2e/.auth/<compte>.json, réutilisée par les tests via `storageState`.
 *
 * Pré-requis (cf. e2e/README.md) : stack de DEV lancée, dev-db.sql appliqué, auth-service avec
 * DEV_FIXED_2FA_CODE. Chaque étape échoue avec un message explicite si ce n'est pas le cas.
 */

async function expectOk(res: Awaited<ReturnType<APIRequestContext['get']>>, step: string) {
  if (!res.ok()) {
    throw new Error(`[e2e setup] ${step} : HTTP ${res.status()} ${await res.text()}`);
  }
}

async function ensureAccount(baseURL: string, account: TestAccount): Promise<void> {
  const ctx = await request.newContext({ baseURL });
  try {
    // 1. Connexion d'abord : si elle passe, le compte existe déjà.
    let login = await ctx.post('/auth/login', {
      data: { email: account.email, password: TEST_PASSWORD },
    });
    if (login.status() === 401) {
      // 2. Inscription + validation par l'endpoint de DEV (/auth/verify/{username}, profil dev).
      const reg = await ctx.post('/auth/register', {
        data: {
          username: account.username,
          firstName: account.firstName,
          lastName: 'E2E',
          email: account.email,
          password: TEST_PASSWORD,
        },
      });
      await expectOk(reg, `inscription de ${account.email} (dev-db.sql appliqué ?)`);
      await expectOk(
        await ctx.get(`/auth/verify/${account.username}`),
        `validation dev de ${account.username} (auth-service en profil dev ?)`
      );
      login = await ctx.post('/auth/login', {
        data: { email: account.email, password: TEST_PASSWORD },
      });
    }
    await expectOk(login, `connexion de ${account.email}`);

    // 3. 2FA avec le code fixe de dev → cookie de session.
    await expectOk(
      await ctx.post('/auth/verify-2fa', { data: { email: account.email, code: DEV_2FA_CODE } }),
      `2FA de ${account.email} (auth-service lancé avec DEV_FIXED_2FA_CODE=${DEV_2FA_CODE} ?)`
    );

    // 4. Abonnement au programme du cours de test (idempotent côté core).
    const me = await ctx.get('/api/me');
    await expectOk(me, `GET /api/me pour ${account.email}`);
    const { id } = (await me.json()) as { id: number };
    await expectOk(
      await ctx.post('/api/programs/users', { data: { id, programIds: [TEST_PROGRAM_ID] } }),
      `abonnement de ${account.email} au programme ${TEST_PROGRAM_ID}`
    );
    // 5. Inscription au cours (la sidebar ne liste que les cours suivis).
    await expectOk(
      await ctx.post('/api/courses/users', {
        data: { id, courseIds: [TEST_COURSE_ID], programId: TEST_PROGRAM_ID },
      }),
      `inscription de ${account.email} au cours ${TEST_COURSE_ID}`
    );

    // 6. Révocation des appareils des runs précédents : chaque contexte Playwright est un
    //    navigateur neuf (= un nouvel appareil), on resterait sinon bloqué au plafond de 20.
    //    404 = pile sans le vocal chiffré (ex. main avant la fusion vocale) : rien à révoquer.
    const devices = await ctx.get('/api/keys/my-devices');
    if (devices.status() !== 404) {
      await expectOk(devices, `appareils de ${account.email}`);
      for (const d of (await devices.json()) as { deviceId: string; revokedAt: string | null }[]) {
        if (!d.revokedAt) {
          await expectOk(
            await ctx.delete(`/api/keys/devices/${d.deviceId}`),
            `révocation d'un appareil de ${account.email}`
          );
        }
      }
    }

    await ctx.storageState({ path: storageStatePath(account.key) });
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:5173';
  for (const account of ACCOUNTS) {
    await ensureAccount(baseURL, account);
  }
}
