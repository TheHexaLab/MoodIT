/**
 * Base IndexedDB du vocal chiffré (une par profil de navigateur) :
 *  - `devices` : NOTRE appareil par compte local (clés privées non extractibles) — deviceStore ;
 *  - `trust`   : les clés d'identité des AUTRES appareils déjà rencontrés (TOFU) — trustStore.
 * IndexedDB et non localStorage : seul IndexedDB stocke des CryptoKey non extractibles.
 */

const DB_NAME = 'moodit-e2ee';
const DB_VERSION = 2;
export const DEVICES_STORE = 'devices';
export const TRUST_STORE = 'trust';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // v1 → devices ; v2 → + trust. Création idempotente (une base v1 existante est migrée).
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DEVICES_STORE)) {
        db.createObjectStore(DEVICES_STORE, { keyPath: 'userId' });
      }
      if (!db.objectStoreNames.contains(TRUST_STORE)) {
        db.createObjectStore(TRUST_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Exécute UNE requête dans une transaction sur `store`, puis ferme la base. */
export async function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
