import { getMe } from '../../../helpers/api';
import {
  deviceLabel,
  exportPublicKeys,
  generateDeviceKeys,
  type DeviceKeyPairs,
  type PublicDeviceKeys,
} from './deviceCrypto';
import { DEVICES_STORE, withStore } from './e2eeDb';
import { DeviceConflictError, registerDevice } from './keyDirectory';

/**
 * Appareil courant du vocal chiffré : clés persistées dans IndexedDB (cf. e2eeDb) et enregistrées
 * dans l'annuaire.
 *
 * Un enregistrement PAR COMPTE (clé = userId) : un même profil de navigateur utilisé par deux
 * comptes donne deux appareils distincts, jamais de clé partagée entre comptes.
 */

/** Miroir de core DeviceKeyService.MAX_ACTIVE_DEVICES (pour le message d'erreur uniquement). */
const MAX_ACTIVE_DEVICES = 20;

interface StoredDevice {
  userId: number;
  deviceId: string;
  keys: DeviceKeyPairs;
  /**
   * Clés publiques SIGNÉES une fois pour toutes à la création. ECDSA étant non déterministe,
   * re-signer à chaque join donnerait une dhSig différente à chaque fois. Absent sur un appareil
   * créé avant ce champ : recalculé puis mémorisé au prochain ensureDevice.
   */
  pub?: PublicDeviceKeys;
}

export interface CurrentDevice {
  /** Compte connecté localement (sert aussi de clé à la confiance TOFU, trustStore). */
  userId: number;
  deviceId: string;
  keys: DeviceKeyPairs;
  /** Nos clés publiques telles que publiées (signPub sert au code de sécurité). */
  pub: PublicDeviceKeys;
}

const load = (userId: number) =>
  withStore<StoredDevice | undefined>(DEVICES_STORE, 'readonly', (s) => s.get(userId));
const save = (device: StoredDevice) => withStore(DEVICES_STORE, 'readwrite', (s) => s.put(device));
const remove = (userId: number) => withStore(DEVICES_STORE, 'readwrite', (s) => s.delete(userId));

async function createDevice(userId: number): Promise<Required<StoredDevice>> {
  const keys = await generateDeviceKeys();
  const device = { userId, deviceId: crypto.randomUUID(), keys, pub: await exportPublicKeys(keys) };
  await save(device);
  return device;
}

async function loadOrCreate(userId: number): Promise<Required<StoredDevice>> {
  const stored = await load(userId);
  if (!stored) return createDevice(userId);
  if (stored.pub) return stored as Required<StoredDevice>;
  const upgraded = { ...stored, pub: await exportPublicKeys(stored.keys) };
  await save(upgraded);
  return upgraded;
}

/** Évite deux générations concurrentes dans le même onglet (double clic « Rejoindre »). */
let pending: Promise<CurrentDevice> | null = null;

/**
 * Appareil prêt à l'emploi : chargé (ou créé) puis (ré)enregistré dans l'annuaire. L'appel à
 * l'annuaire est fait à CHAQUE fois (idempotent côté serveur) : si l'appareil a été révoqué ou
 * son id refusé (409), on le régénère une fois, ce qui « répare » un navigateur révoqué.
 */
export function ensureDevice(): Promise<CurrentDevice> {
  pending ??= (async () => {
    const me = await getMe();
    const label = deviceLabel(navigator.userAgent);
    let device = await loadOrCreate(me.id);
    try {
      await registerDevice(device.deviceId, label, device.pub);
    } catch (e) {
      if (!(e instanceof DeviceConflictError)) throw e;
      await remove(me.id);
      device = await createDevice(me.id);
      try {
        await registerDevice(device.deviceId, label, device.pub);
      } catch (retry) {
        // Un appareil NEUF refusé = plafond d'appareils actifs atteint (côté core).
        if (retry instanceof DeviceConflictError) {
          throw new Error(
            `Trop d'appareils enregistrés pour le vocal chiffré (maximum ${MAX_ACTIVE_DEVICES}). ` +
              'Révoque les anciens appareils dans « Mes appareils » pour en ajouter un.',
            { cause: retry }
          );
        }
        throw retry;
      }
    }
    return { userId: me.id, deviceId: device.deviceId, keys: device.keys, pub: device.pub };
  })().finally(() => {
    pending = null;
  });
  return pending;
}
