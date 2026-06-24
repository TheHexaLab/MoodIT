// Contexte « utilisateur connecté » : source de vérité UNIQUE pour l'identité et les
// droits, alimentée par un seul GET /api/me (cf. CurrentUserProvider).
//
// Ce fichier ne contient volontairement AUCUN composant (uniquement le contexte, le
// hook et les types) : le provider vit dans CurrentUserProvider.tsx. Cette séparation
// évite l'avertissement react-refresh (« only export components ») et garde le Fast
// Refresh fonctionnel.

import { createContext, useContext } from 'react';
import type { User } from '../types/domain.ts';
import type { ProfileUpdate } from '../components/EditProfilePopup/types.ts';

// 'checking' tant que la validation /api/me est en cours ; 'authed' si le token est
// valide en BD (profil chargé) ; 'unauthed' si absent/refusé.
export type AuthStatus = 'checking' | 'authed' | 'unauthed';

export interface CurrentUserApi {
  /** État d'authentification, consommé par ProtectedRoute pour le garde de route. */
  status: AuthStatus;
  /** Profil connecté (réel dès que status === 'authed'). */
  currentUser: User;
  /** Validation /api/me en cours : pilote le skeleton du UserMenu. */
  profileLoading: boolean;
  /** Droits d'édition dérivés des rôles globaux (rôle « Administrateur »). */
  isAdmin: boolean;
  /** PATCH /api/me (prénom, nom, couleur). Rejette si l'appel échoue. */
  saveProfile: (profile: ProfileUpdate) => Promise<void>;
}

export const CurrentUserContext = createContext<CurrentUserApi | null>(null);

/** Accès au profil connecté. À utiliser sous <CurrentUserProvider>. */
export function useCurrentUser(): CurrentUserApi {
  const ctx = useContext(CurrentUserContext);
  if (!ctx) {
    throw new Error('useCurrentUser doit être utilisé dans <CurrentUserProvider>');
  }
  return ctx;
}
