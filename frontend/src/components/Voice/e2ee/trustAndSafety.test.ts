import { describe, expect, it } from 'vitest';
import { exportPublicKeys, generateDeviceKeys } from './deviceCrypto';
import { safetyCode } from './safetyCode';
import { evaluateTrust, type TrustRecord } from './trustStore';

const record = (over: Partial<TrustRecord> = {}): TrustRecord => ({
  key: '1|d',
  deviceId: 'd',
  userId: 2,
  signPub: 'KEY',
  verified: false,
  firstSeen: '',
  ...over,
});

describe('evaluateTrust (TOFU)', () => {
  it('jamais vu → new', () => {
    expect(evaluateTrust(undefined, { userId: 2, signPub: 'KEY' })).toBe('new');
  });
  it('même clé → known, ou verified si marqué', () => {
    expect(evaluateTrust(record(), { userId: 2, signPub: 'KEY' })).toBe('known');
    expect(evaluateTrust(record({ verified: true }), { userId: 2, signPub: 'KEY' })).toBe('verified');
  });
  it('autre clé ou autre propriétaire → changed, même si vérifié avant', () => {
    expect(evaluateTrust(record({ verified: true }), { userId: 2, signPub: 'AUTRE' })).toBe('changed');
    expect(evaluateTrust(record(), { userId: 3, signPub: 'KEY' })).toBe('changed');
  });
});

describe('safetyCode', () => {
  it('identique des deux côtés, 12 groupes de 5 chiffres', async () => {
    const a = (await exportPublicKeys(await generateDeviceKeys())).signPub;
    const b = (await exportPublicKeys(await generateDeviceKeys())).signPub;
    const ab = await safetyCode(a, b);
    expect(await safetyCode(b, a)).toBe(ab);
    expect(ab).toMatch(/^(\d{5} ){11}\d{5}$/);
  });
  it('change dès qu’une des deux clés change', async () => {
    const [a, b, c] = await Promise.all(
      [1, 2, 3].map(async () => (await exportPublicKeys(await generateDeviceKeys())).signPub)
    );
    expect(await safetyCode(a, b)).not.toBe(await safetyCode(a, c));
  });
});
