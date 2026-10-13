import React, { useCallback, useEffect, useState } from 'react';
import styles from './VoicePanel.module.css';
import { ensureDevice } from './e2ee/deviceStore';
import { listMyDevices, revokeDevice, type DeviceKeyRecord } from './e2ee/keyDirectory';

/**
 * « Mes appareils » du vocal chiffré (voice-service/E2EE.md §5.3) : chaque navigateur utilisé
 * pour le vocal est un appareil. Un appareil inconnu = compte compromis possible → le révoquer
 * (il est alors éjecté immédiatement des salons et n'obtient plus aucune clé).
 */
export const MyDevices: React.FC = () => {
  const [devices, setDevices] = useState<DeviceKeyRecord[] | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  /** Révocation en cours (jusqu'au rechargement de la liste) : boutons désactivés. */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ensureDevice D'ABORD (connaître et enregistrer au besoin l'appareil de CE navigateur), PUIS la
  // liste : en parallèle, la liste pouvait être lue avant l'enregistrement de cet appareil.
  const load = useCallback(async () => {
    const current = await ensureDevice();
    return [current, await listMyDevices()] as const;
  }, []);

  const apply = useCallback(([current, list]: Awaited<ReturnType<typeof load>>) => {
    setCurrentId(current.deviceId);
    setDevices(list);
  }, []);

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : 'Appareils indisponibles');

  useEffect(() => {
    let cancelled = false;
    load()
      .then((r) => {
        if (!cancelled) apply(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) fail(e);
      });
    return () => {
      cancelled = true;
    };
  }, [load, apply]);

  const reload = () => load().then(apply).catch(fail);

  const revoke = async (deviceId: string) => {
    setConfirming(null);
    setBusy(true);
    try {
      await revokeDevice(deviceId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Révocation impossible');
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className={styles.error}>⚠ {error}</p>;
  if (!devices) return <p className={styles.hint}>Chargement des appareils…</p>;

  const active = devices.filter((d) => !d.revokedAt);
  const revoked = devices.filter((d) => d.revokedAt);

  return (
    <section className={styles.devices} aria-label="Mes appareils" aria-busy={busy}>
      <p className={styles.hint}>
        Chaque navigateur utilisé pour le vocal chiffré est un appareil. Révoque ceux que tu ne
        reconnais pas.
      </p>
      <ul className={styles.deviceList}>
        {active.map((d) => (
          <li key={d.deviceId} className={styles.device} data-device-id={d.deviceId}>
            <span>
              {d.label || 'Appareil'}
              {d.deviceId === currentId && <strong> (cet appareil)</strong>}
              <small> — ajouté le {new Date(d.createdAt).toLocaleString('fr-CA')}</small>
            </span>
            {d.deviceId !== currentId &&
              (confirming === d.deviceId ? (
                <button
                  type="button"
                  className={styles.leave}
                  disabled={busy}
                  onClick={() => void revoke(d.deviceId)}
                >
                  Confirmer la révocation
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.mute}
                  disabled={busy}
                  onClick={() => setConfirming(d.deviceId)}
                >
                  Révoquer
                </button>
              ))}
          </li>
        ))}
      </ul>
      {revoked.length > 0 && (
        <p className={styles.hint}>{revoked.length} appareil(s) révoqué(s).</p>
      )}
    </section>
  );
};

export default MyDevices;
