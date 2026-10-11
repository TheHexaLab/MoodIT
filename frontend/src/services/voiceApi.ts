import { apiFetch } from '../helpers/api';

/**
 * Flag d'activation du vocal côté front (greffon retirable). En DEV : visible par défaut,
 * sauf VITE_VOICE_ENABLED=false. En build de prod : masqué sauf VITE_VOICE_ENABLED=true.
 * Pendant à moodit.voice.enabled côté backend — les deux doivent être ON pour que ça marche.
 */
export const VOICE_ENABLED =
  import.meta.env.VITE_VOICE_ENABLED === 'true' ||
  (import.meta.env.DEV && import.meta.env.VITE_VOICE_ENABLED !== 'false');

/** Réponse de POST /api/voice/token : de quoi connecter le navigateur au SFU LiveKit. */
export interface VoiceTokenResponse {
  /** JoinToken signé (JWT LiveKit) à passer au SDK. */
  token: string;
  /** URL publique du SFU (WebSocket de signalisation LiveKit). */
  url: string;
  /** Nom du salon LiveKit rejoint ("channel:<id>"). */
  room: string;
}

/**
 * Demande un JoinToken pour le salon vocal d'un canal. L'autorisation (droit de rejoindre
 * ce canal) est tranchée côté backend via le permission-service AVANT la signature :
 *   - 401 si non authentifié, 403 si pas le droit (→ Error remontée au composant).
 * Le cookie d'auth part automatiquement (apiFetch → credentials:'include').
 */
export async function getVoiceToken(channelId: number): Promise<VoiceTokenResponse> {
  const res = await apiFetch('/api/voice/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({ message: `Erreur ${res.status}` }));
    throw new Error(data.message || `Erreur ${res.status}`);
  }

  return res.json();
}
