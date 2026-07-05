// Provider du profil connecté : effectue l'UNIQUE GET /api/me et le partage à toute
// la zone protégée (garde de route + UserMenu + Dashboard). Réussir cet appel prouve
// que le token est valide en BD (le gateway le vérifie pour répondre) → ProtectedRoute
// s'en sert comme validation forte, et le Dashboard récupère le profil déjà chargé :
// un seul appel réseau au lieu de deux.

import { useEffect, useState, type ReactNode } from 'react';
import { getMe, updateMe } from '../helpers/api.ts';
import type { User } from '../types/domain.ts';
import type { ProfileUpdate } from '../components/EditProfilePopup/types.ts';
import { CurrentUserContext, type AuthStatus, type CurrentUserApi } from './currentUserContext.ts';

// Identité neutre affichée tant que /api/me n'a pas répondu : aucun faux nom.
const loadingUser: User = {
  id: -1,
  username: '',
  firstName: '',
  lastName: '',
  avatarColor: '#0a5cc0',
};

// Rôle global (table Role) accordant les droits d'édition (cours, programmes,
// sections, gestion des rôles). Les rôles enseignant PAR programme ne sont pas gérés ici.
const ADMIN_ROLE_NAME = 'Administrateur';

export default function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User>(loadingUser);
  // Le token est dans un cookie HttpOnly : le JS ne peut pas savoir a priori s'il existe.
  // On part donc toujours en 'checking' et on laisse GET /api/me trancher (succès = authed).
  const [status, setStatus] = useState<AuthStatus>('checking');

  const isAdmin = currentUser.roles?.some((role) => role.name === ADMIN_ROLE_NAME) ?? false;

  // Validation forte + chargement du profil en un seul appel. GET /api/me transite par
  // le gateway (signature + token actif en BD via /auth/validate) : un succès vaut
  // authentification. En cas d'échec (401 déjà purgé/redirigé par apiFetch, ou 503),
  // on refuse l'accès.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (cancelled) return;
        setCurrentUser(user);
        localStorage.setItem('moodit_user_id', String(user.id));
        setStatus('authed');
      })
      .catch(() => {
        if (!cancelled) setStatus('unauthed');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // PATCH /api/me : prénom, nom, couleur. Au succès on applique le profil renvoyé par
  // le backend (source de vérité), répercuté partout via le contexte.
  // TODO : upload de la photo (multipart) — non géré côté backend pour l'instant.
  const saveProfile = async (profile: ProfileUpdate) => {
    const updated = await updateMe({
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatarColor: profile.avatarColor,
    });
    setCurrentUser(updated);
  };

  const value: CurrentUserApi = {
    status,
    currentUser,
    profileLoading: status === 'checking',
    isAdmin,
    saveProfile,
  };

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}
