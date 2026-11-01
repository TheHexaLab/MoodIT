/**
 * Comptes de test E2E. Domaine `e2e.test` : TLD réservé (RFC 2606), aucun email ne peut atteindre
 * une vraie personne. L'établissement correspondant est créé par e2e/setup/dev-db.sql.
 */
export interface TestAccount {
  key: string;
  username: string;
  firstName: string;
  email: string;
}

/** Mot de passe commun des comptes de test (BD de DEV uniquement). */
export const TEST_PASSWORD = 'E2e-Passw0rd!';

/** Code 2FA fixe : auth-service doit tourner avec DEV_FIXED_2FA_CODE=000000 (profil dev). */
export const DEV_2FA_CODE = process.env.DEV_FIXED_2FA_CODE ?? '000000';

/** Programme auquel les comptes sont abonnés (Génie informatique dans la démo, db/demo). */
export const TEST_PROGRAM_ID = Number(process.env.E2E_PROGRAM_ID ?? 1);
/** Cours suivi (son salon vocal « Vocal - … » est créé par la démo, db/demo). */
export const TEST_COURSE_ID = Number(process.env.E2E_COURSE_ID ?? 1);

export const ACCOUNTS: TestAccount[] = [
  { key: 'alice', username: 'e2e_alice', firstName: 'Alice', email: 'alice@e2e.test' },
  { key: 'bob', username: 'e2e_bob', firstName: 'Bob', email: 'bob@e2e.test' },
  { key: 'carol', username: 'e2e_carol', firstName: 'Carol', email: 'carol@e2e.test' },
];

export const storageStatePath = (key: string) => `e2e/.auth/${key}.json`;
