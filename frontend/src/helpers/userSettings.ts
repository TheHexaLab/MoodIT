// Préférences utilisateur persistées dans `User_.settings` (colonne TEXT côté BD, blob
// JSON dont le FRONT est propriétaire). Le backend ne fait que valider + persister ;
// c'est ici qu'on définit la forme, qu'on parse à la lecture (GET /api/me) et qu'on
// sérialise à l'écriture (PUT /api/me/settings — cf. helpers/api.ts `updateMeSettings`).
//
// `theme` : dark/light, source de vérité BD (suit l'appareil). Cf. ThemeProvider.

/** Forme du blob `settings`. Tous les champs sont optionnels (compte neuf → objet vide). */
export interface UserSettings {
  theme?: 'light' | 'dark';
}

/**
 * Parse défensivement le blob brut renvoyé par l'API. Tolère `undefined`/`null` (compte
 * neuf) et un JSON corrompu : on retombe toujours sur un objet vide plutôt que de casser
 * le chargement de l'app.
 */
export function parseUserSettings(raw?: string | null): UserSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as UserSettings) : {};
  } catch {
    return {};
  }
}

/** Sérialise les préférences pour l'envoi à PUT /api/me/settings. */
export function serializeUserSettings(settings: UserSettings): string {
  return JSON.stringify(settings);
}
