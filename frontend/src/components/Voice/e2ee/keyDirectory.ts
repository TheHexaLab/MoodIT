import { apiFetch } from '../../../helpers/api';
import { type PublicDeviceKeys } from './deviceCrypto';

/**
 * Client de l'annuaire des clés PUBLIQUES d'appareil (core-service, /api/keys/**). Le serveur
 * distribue des clés mais ne fait pas foi : le client les vérifie (verifyPublicKeys + TOFU en E3).
 */

/** Miroir de core DeviceKeyDTO. */
export interface DeviceKeyRecord extends PublicDeviceKeys {
  deviceId: string;
  userId: number;
  username: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** Le deviceId est déjà pris / révoqué / associé à d'autres clés : régénérer l'appareil. */
export class DeviceConflictError extends Error {}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { message?: string }).message || `Erreur ${res.status}`;
}

/** Enregistre (ou confirme, c'est idempotent) l'appareil de l'utilisateur courant. */
export async function registerDevice(
  deviceId: string,
  label: string,
  keys: PublicDeviceKeys
): Promise<DeviceKeyRecord> {
  const res = await apiFetch('/api/keys/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, label, ...keys }),
  });
  if (res.status === 409) throw new DeviceConflictError(await readError(res));
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** Mes appareils (actifs et révoqués). */
export async function listMyDevices(): Promise<DeviceKeyRecord[]> {
  const res = await apiFetch('/api/keys/my-devices');
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** Clés publiques d'un appareil (le mien, ou celui d'un membre d'un programme commun). */
export async function getDevice(deviceId: string): Promise<DeviceKeyRecord> {
  const res = await apiFetch(`/api/keys/devices/${encodeURIComponent(deviceId)}`);
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

/** Révoque un de mes appareils. */
export async function revokeDevice(deviceId: string): Promise<void> {
  const res = await apiFetch(`/api/keys/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res));
}
