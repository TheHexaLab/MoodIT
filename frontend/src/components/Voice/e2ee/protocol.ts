import { fromBase64, toBase64 } from './deviceCrypto';

/**
 * Protocole d'échange de clés du vocal chiffré (voice-service/E2EE.md §5.5). Crypto PURE, sans
 * état ni réseau : sérialisation, signatures, dérivation et (dé)chiffrement des enveloppes.
 *
 * Deux messages, transportés par le data channel LiveKit (topic E2EE_TOPIC) :
 *   - `announce` : « voici ma clé de SESSION éphémère », signé par la clé d'identité de l'appareil
 *     (vérifiable via l'annuaire). Diffusé au join, renvoyé en direct à chaque nouvel arrivant.
 *   - `key`      : ma clé MÉDIA courante, chiffrée pour UN destinataire avec une clé dérivée
 *     ECDH(ma session, sa session). Seul ce destinataire peut l'ouvrir ; le SFU ne fait que relayer.
 */

export const PROTOCOL_VERSION = 1 as const;
/** Taille du trousseau LiveKit (MooditKeyProvider.keyringSize) : index média = seq % KEYRING_SIZE. */
export const KEYRING_SIZE = 16;
/** Tolérance d'horloge sur l'horodatage d'une annonce (anti-rejeu grossier). */
export const ANNOUNCE_MAX_SKEW_MS = 2 * 60 * 1000;

const ECDH: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA_VERIFY: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_SIGN: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };
const enc = new TextEncoder();
/** Octets UTF-8 adossés à un ArrayBuffer (exigé par les signatures WebCrypto en TS strict). */
const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(text));

export interface AnnounceMsg {
  t: 'announce';
  v: typeof PROTOCOL_VERSION;
  room: string;
  identity: string;
  deviceId: string;
  /** SPKI Base64 de la clé ECDH de session. */
  sessionPub: string;
  ts: number;
  /** Signature ECDSA (P1363, Base64) des champs ci-dessus, par la clé d'identité de l'appareil. */
  sig: string;
}

export interface KeyMsg {
  t: 'key';
  v: typeof PROTOCOL_VERSION;
  room: string;
  from: string;
  to: string;
  /** Compteur de rotation de l'émetteur, strictement croissant par session (anti-rejeu). */
  seq: number;
  iv: string;
  ct: string;
}

export type E2EEMessage = AnnounceMsg | KeyMsg;

/** Identité LiveKit MoodIT : "<userId>.<deviceId>" (voice-service VoiceTokenController). */
export function parseIdentity(identity: string): { userId: number; deviceId: string } | null {
  const m = /^(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(identity);
  return m ? { userId: Number(m[1]), deviceId: m[2] } : null;
}

export const keyIndexOf = (seq: number) => seq % KEYRING_SIZE;

// ── Sérialisation canonique (ordre fixe : ce qui est signé / authentifié ne dépend pas de JSON) ──

function announceBytes(m: Omit<AnnounceMsg, 'sig'>): Uint8Array<ArrayBuffer> {
  return utf8(
    JSON.stringify(['moodit-e2ee-announce', m.v, m.room, m.identity, m.deviceId, m.sessionPub, m.ts])
  );
}

function keyAad(m: Pick<KeyMsg, 'v' | 'room' | 'from' | 'to' | 'seq'>): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(['moodit-e2ee-key', m.v, m.room, m.from, m.to, m.seq]));
}

export function encodeMessage(msg: E2EEMessage): Uint8Array<ArrayBuffer> {
  return utf8(JSON.stringify(msg));
}

const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1024;
const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

/** Décode et valide STRICTEMENT la forme d'un message reçu (données d'un tiers). null si invalide. */
export function decodeMessage(payload: Uint8Array): E2EEMessage | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object' || m.v !== PROTOCOL_VERSION) return null;
  if (
    m.t === 'announce' &&
    isStr(m.room) &&
    isStr(m.identity) &&
    isStr(m.deviceId) &&
    isStr(m.sessionPub) &&
    isInt(m.ts) &&
    isStr(m.sig)
  ) {
    return m as unknown as AnnounceMsg;
  }
  if (
    m.t === 'key' &&
    isStr(m.room) &&
    isStr(m.from) &&
    isStr(m.to) &&
    isInt(m.seq) &&
    isStr(m.iv) &&
    isStr(m.ct)
  ) {
    return m as unknown as KeyMsg;
  }
  return null;
}

// ── Clés de session et annonces ──

export interface SessionKeys {
  pair: CryptoKeyPair;
  /** SPKI Base64 de la clé publique. */
  pub: string;
}

/** Paire ECDH éphémère d'UNE connexion (privée non extractible, oubliée à la sortie). */
export async function generateSessionKeys(): Promise<SessionKeys> {
  const pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
  return { pair, pub: toBase64(await crypto.subtle.exportKey('spki', pair.publicKey)) };
}

export async function signAnnounce(
  signPrivateKey: CryptoKey,
  fields: Omit<AnnounceMsg, 't' | 'v' | 'sig'>
): Promise<AnnounceMsg> {
  const unsigned = { t: 'announce' as const, v: PROTOCOL_VERSION, ...fields };
  const sig = await crypto.subtle.sign(ECDSA_SIGN, signPrivateKey, announceBytes(unsigned));
  return { ...unsigned, sig: toBase64(sig) };
}

/** Vérifie la signature d'une annonce avec la clé d'identité (SPKI Base64) lue dans l'annuaire. */
export async function verifyAnnounce(msg: AnnounceMsg, signPubB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', fromBase64(signPubB64), ECDSA_VERIFY, false, [
      'verify',
    ]);
    return await crypto.subtle.verify(ECDSA_SIGN, key, fromBase64(msg.sig), announceBytes(msg));
  } catch {
    return false;
  }
}

// ── Enveloppes de clé média ──

/**
 * Clé AES-GCM d'enveloppe pour le sens from → to. ECDH(sessions) puis HKDF, avec le salon en sel
 * et le SENS en info : A→B et B→A n'utilisent jamais la même clé.
 */
export async function deriveWrapKey(
  sessionPrivateKey: CryptoKey,
  peerSessionPubB64: string,
  room: string,
  from: string,
  to: string
): Promise<CryptoKey> {
  const peerPub = await crypto.subtle.importKey('spki', fromBase64(peerSessionPubB64), ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, sessionPrivateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8(room),
      info: utf8(`moodit-voice-e2ee/v${PROTOCOL_VERSION}/${from}->${to}`),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function wrapMediaKey(
  wrapKey: CryptoKey,
  rawKey: ArrayBuffer,
  header: Pick<KeyMsg, 'room' | 'from' | 'to' | 'seq'>
): Promise<KeyMsg> {
  const base = { t: 'key' as const, v: PROTOCOL_VERSION, ...header };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: keyAad(base) },
    wrapKey,
    rawKey
  );
  return { ...base, iv: toBase64(iv.buffer), ct: toBase64(ct) };
}

/** Ouvre une enveloppe. Lève si la clé, l'en-tête (AAD) ou le contenu ne correspondent pas. */
export async function unwrapMediaKey(wrapKey: CryptoKey, msg: KeyMsg): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromBase64(msg.iv)), additionalData: keyAad(msg) },
    wrapKey,
    fromBase64(msg.ct)
  );
}

/** Nouvelle clé média : 32 octets aléatoires (matériau HKDF pour le worker LiveKit). */
export function randomMediaKey(): ArrayBuffer {
  return crypto.getRandomValues(new Uint8Array(32)).buffer;
}
