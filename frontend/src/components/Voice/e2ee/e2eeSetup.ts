import { isE2EESupported } from 'livekit-client';
// Worker de chiffrement des trames fourni par le SDK. `?worker` : Vite l'émet comme fichier JS
// séparé same-origin (pas de blob:), donc compatible avec la CSP `script-src 'self'`.
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { MooditKeyProvider } from './MooditKeyProvider';

/** Topic LiveKit des messages d'échange de clés (annonces + enveloppes, cf. protocol.ts). */
export const E2EE_TOPIC = 'moodit.e2ee';

export interface E2EESession {
  keyProvider: MooditKeyProvider;
  worker: Worker;
}

/**
 * Prépare le chiffrement pour UNE connexion au salon. Lève une erreur explicite si le
 * navigateur ne sait pas chiffrer les trames : on refuse alors de rejoindre plutôt que de
 * parler en clair (E2EE.md §5.7).
 */
export function createE2EESession(): E2EESession {
  if (!isE2EESupported()) {
    throw new Error('Ce navigateur ne supporte pas le vocal chiffré de bout en bout.');
  }
  return { keyProvider: new MooditKeyProvider(), worker: new E2EEWorker() };
}
