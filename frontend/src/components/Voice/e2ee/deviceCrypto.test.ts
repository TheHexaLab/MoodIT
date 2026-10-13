import { describe, expect, it } from 'vitest';
import {
  deviceLabel,
  exportPublicKeys,
  fromBase64,
  generateDeviceKeys,
  toBase64,
  verifyPublicKeys,
} from './deviceCrypto';

// Même vecteur que core DeviceKeyVerifierTest : le front et le backend vérifient la même chose.
const VECTOR = {
  signPub:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgEPwC5GCI6cTrUIeFNUsnhAo4qCyX21S3JC8bXV+WvwKaN0VcEknA4Nz958Hd6Roizq8ePGn5FcmeF6OLXlR2g==',
  dhPub:
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE3PidRDhQT7BctXVbkGKmU7QkR1iNr8AVVX4n/aalGD+cvUHb7qefEivrXdHm9+TK8p6589WpawO6vStcCFX5rA==',
  dhSig:
    't3YO48zDpbtdSOKjIAEt2yjogOdEiHQ49KGFaWBhjJJN1H5xmYruzx+qxZafjZaK7irrsFdVEaBiiw0E0KWFRg==',
};

describe('deviceCrypto', () => {
  it('génère des clés privées non extractibles', async () => {
    const keys = await generateDeviceKeys();
    expect(keys.sign.privateKey.extractable).toBe(false);
    expect(keys.dh.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', keys.sign.privateKey)).rejects.toThrow();
  });

  it('publie des clés dont la signature est vérifiable (format P1363, 64 octets)', async () => {
    const pub = await exportPublicKeys(await generateDeviceKeys());
    expect(fromBase64(pub.dhSig).byteLength).toBe(64);
    expect(await verifyPublicKeys(pub)).toBe(true);
  });

  it('accepte le vecteur partagé avec le backend Java', async () => {
    expect(await verifyPublicKeys(VECTOR)).toBe(true);
  });

  it('rejette une clé dh substituée (signature qui ne la couvre plus)', async () => {
    const other = await exportPublicKeys(await generateDeviceKeys());
    expect(await verifyPublicKeys({ ...VECTOR, dhPub: other.dhPub })).toBe(false);
  });

  it('rejette des données invalides sans lever', async () => {
    expect(await verifyPublicKeys({ ...VECTOR, signPub: 'pas-du-base64!' })).toBe(false);
  });

  it('aller-retour Base64', () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128]).buffer;
    expect(new Uint8Array(fromBase64(toBase64(bytes)))).toEqual(new Uint8Array(bytes));
  });

  it('libellé indicatif selon le user-agent', () => {
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
    expect(deviceLabel(edge)).toBe('Edge · Windows');
    expect(deviceLabel(firefox)).toBe('Firefox · Linux');
  });
});
