// Le JWT vit désormais dans un cookie HttpOnly `moodit_token` (posé par l'auth-service),
// inaccessible au JavaScript. Le front ne lit ni n'écrit plus le token : il envoie le
// cookie automatiquement (credentials:'include') et déduit l'état d'authentification du
// succès de GET /api/me (voir CurrentUserProvider). La déconnexion réelle passe par
// POST /auth/logout (efface le cookie côté serveur).

const TOKEN_KEY = 'moodit_token';

// Purge un éventuel token résiduel en localStorage (anciennes sessions d'avant la
// migration cookie). Conservé le temps que ces sessions expirent ; ne pose plus de
// nouveau token. Le cookie HttpOnly, lui, ne peut être effacé que par le serveur.
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
