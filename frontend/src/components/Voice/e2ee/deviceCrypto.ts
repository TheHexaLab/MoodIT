/**
 * Crypto PURE des clés d'appareil du vocal chiffré (voice-service/E2EE.md §4-§5.1), sans stockage
 * ni réseau — donc testable telle quelle (WebCrypto est aussi dispo dans Node).
 *
 * Un appareil = deux paires P-256 :
 *   - `sign` (ECDSA) : identité longue durée, signe la clé `dh` et, en E2, nos annonces de session ;
 *   - `dh`   (ECDH)  : accord de clés.
 * Les clés PRIVÉES sont générées NON EXTRACTIBLES : même un script injecté ne peut pas les lire,
 * seulement s'en servir tant qu'il tourne (d'où la CSP stricte). Les publiques restent
 * exportables (règle WebCrypto), c'est ce qu'on publie dans l'annuaire.
 */

const SIGN_ALGO: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
const DH_ALGO: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN_PARAMS: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

export interface DeviceKeyPairs {
  sign: CryptoKeyPair;
  dh: CryptoKeyPair;
}

/** Forme publiée dans l'annuaire (POST /api/keys/devices). Tout en Base64 standard. */
export interface PublicDeviceKeys {
  /** SPKI de la clé ECDSA. */
  signPub: string;
  /** SPKI de la clé ECDH. */
  dhPub: string;
  /** Signature ECDSA (format P1363, r||s) des octets SPKI de dhPub, par la clé sign. */
  dhSig: string;
}

export function toBase64(bytes: ArrayBuffer): string {
  let bin = '';
  new Uint8Array(bytes).forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Nouvelles paires d'appareil, clés privées non extractibles. */
export async function generateDeviceKeys(): Promise<DeviceKeyPairs> {
  const [sign, dh] = await Promise.all([
    crypto.subtle.generateKey(SIGN_ALGO, false, ['sign', 'verify']),
    crypto.subtle.generateKey(DH_ALGO, false, ['deriveKey', 'deriveBits']),
  ]);
  return { sign, dh };
}

/** Clés publiques + signature de dh par sign, prêtes à publier. */
export async function exportPublicKeys(keys: DeviceKeyPairs): Promise<PublicDeviceKeys> {
  const [signSpki, dhSpki] = await Promise.all([
    crypto.subtle.exportKey('spki', keys.sign.publicKey),
    crypto.subtle.exportKey('spki', keys.dh.publicKey),
  ]);
  const sig = await crypto.subtle.sign(SIGN_PARAMS, keys.sign.privateKey, dhSpki);
  return { signPub: toBase64(signSpki), dhPub: toBase64(dhSpki), dhSig: toBase64(sig) };
}

/**
 * Vérifie qu'un jeu de clés publiques (lu dans l'annuaire) est cohérent : dhPub est bien signée
 * par signPub. Servira en E2 avant tout échange de clés avec un autre appareil.
 */
export async function verifyPublicKeys(pub: PublicDeviceKeys): Promise<boolean> {
  try {
    const signKey = await crypto.subtle.importKey('spki', fromBase64(pub.signPub), SIGN_ALGO, false, [
      'verify',
    ]);
    // Import de dhPub : rejette une clé qui ne serait pas une ECDH P-256 valide.
    await crypto.subtle.importKey('spki', fromBase64(pub.dhPub), DH_ALGO, false, []);
    return await crypto.subtle.verify(SIGN_PARAMS, signKey, fromBase64(pub.dhSig), fromBase64(pub.dhPub));
  } catch {
    return false;
  }
}

/**
 * Libellé d'affichage de l'appareil (« Mes appareils », liste du salon). Purement indicatif et
 * NON fiable (dérivé du user-agent) : la confiance repose sur les clés, jamais sur ce libellé.
 */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Navigateur';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Inconnu';
  return `${browser} · ${os}`;
}
