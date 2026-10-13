import { TRUST_STORE, withStore } from './e2eeDb';

/**
 * Confiance locale dans les appareils des AUTRES (voice-service/E2EE.md §5.3) : TOFU (« trust on
 * first use ») + vérification manuelle par code de sécurité.
 *
 * L'annuaire est tenu par le serveur, qui pourrait mentir. On mémorise donc, PAR COMPTE LOCAL, la
 * clé d'identité de chaque appareil rencontré : si le même appareil revient avec une AUTRE clé, ce
 * n'est jamais légitime (le serveur interdit de changer les clés d'un appareil) → alerte et refus.
 */

/** Niveau de confiance d'un appareil distant, du point de vue de ce navigateur. */
export type TrustLevel = 'new' | 'known' | 'verified' | 'changed';

export interface TrustRecord {
  /** `${localUserId}|${deviceId}` : la confiance est propre au compte connecté localement. */
  key: string;
  deviceId: string;
  userId: number;
  signPub: string;
  verified: boolean;
  firstSeen: string;
}

/**
 * Décision PURE (testable) : que vaut cet appareil au vu de ce qu'on en a mémorisé ?
 *  - jamais vu → 'new' (à mémoriser) ;
 *  - même clé (et même propriétaire) → 'known' ou 'verified' ;
 *  - autre clé ou autre propriétaire → 'changed' (la mémoire n'est PAS écrasée).
 */
export function evaluateTrust(
  stored: TrustRecord | undefined,
  peer: { userId: number; signPub: string }
): TrustLevel {
  if (!stored) return 'new';
  if (stored.signPub !== peer.signPub || stored.userId !== peer.userId) return 'changed';
  return stored.verified ? 'verified' : 'known';
}

const keyOf = (localUserId: number, deviceId: string) => `${localUserId}|${deviceId}`;

/** Évalue un appareil distant et le mémorise s'il est nouveau. */
export async function checkTrust(
  localUserId: number,
  peer: { deviceId: string; userId: number; signPub: string }
): Promise<TrustLevel> {
  const key = keyOf(localUserId, peer.deviceId);
  const stored = await withStore<TrustRecord | undefined>(TRUST_STORE, 'readonly', (s) => s.get(key));
  const level = evaluateTrust(stored, peer);
  if (level === 'new') {
    const record: TrustRecord = {
      key,
      ...peer,
      verified: false,
      firstSeen: new Date().toISOString(),
    };
    await withStore(TRUST_STORE, 'readwrite', (s) => s.put(record));
  }
  return level;
}

/** Marque un appareil comme vérifié (codes de sécurité comparés et identiques). */
export async function markVerified(localUserId: number, deviceId: string): Promise<void> {
  const key = keyOf(localUserId, deviceId);
  const stored = await withStore<TrustRecord | undefined>(TRUST_STORE, 'readonly', (s) => s.get(key));
  if (!stored) throw new Error('Appareil inconnu : impossible de le marquer vérifié.');
  await withStore(TRUST_STORE, 'readwrite', (s) => s.put({ ...stored, verified: true }));
}
