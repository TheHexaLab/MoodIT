// Logique « API » du profil connecté, extraite du Dashboard pour l'alléger :
// GET /api/me au montage, dérivation des droits (isAdmin) et PATCH /api/me.

import { useEffect, useState } from 'react';
import { getMe, updateMe } from '../../helpers/api.ts';
import type { User } from '../../types/domain.ts';
import type { ProfileUpdate } from '../../components/EditProfilePopup/types.ts';

// Identité neutre affichée tant que GET /api/me n'a pas répondu : aucun faux nom.
// L'UI retombe sur 'Utilisateur' / 'U' (cf. getDisplayName / getUserInitial) jusqu'à
// ce que le vrai profil arrive et remplace cette valeur.
const loadingUser: User = {
  id: -1,
  username: '',
  firstName: '',
  lastName: '',
  avatarColor: '#0a5cc0',
};

// Nom du rôle global (table Role) qui accorde les droits d'édition (cours,
// programmes, sections, gestion des rôles). Les rôles enseignant PAR programme
// (User_Program_Role) ne sont pas encore gérés ici.
const ADMIN_ROLE_NAME = 'Administrateur';

export interface CurrentUserApi {
  /** Profil connecté (loadingUser tant que GET /api/me n'a pas répondu). */
  currentUser: User;
  /** GET /api/me en cours : pilote le skeleton du UserMenu. */
  profileLoading: boolean;
  /** Droits d'édition dérivés des rôles globaux (rôle « Administrateur »). */
  isAdmin: boolean;
  /** PATCH /api/me (prénom, nom, couleur). Rejette si l'appel échoue. */
  saveProfile: (profile: ProfileUpdate) => Promise<void>;
}

/**
 * Profil de l'utilisateur connecté : charge GET /api/me au montage, expose les
 * droits dérivés et la sauvegarde via PATCH /api/me.
 */
export function useCurrentUser(): CurrentUserApi {
  const [currentUser, setCurrentUser] = useState<User>(loadingUser);
  const [profileLoading, setProfileLoading] = useState(true);

  // false tant que /api/me n'a pas répondu → aucun bouton d'édition ne « flashe ».
  const isAdmin = currentUser.roles?.some((role) => role.name === ADMIN_ROLE_NAME) ?? false;

  // Profil réel (GET /api/me). Remplace `loadingUser` dès la réponse. En cas d'échec
  // autre que 401 (déjà géré par apiFetch → /login), on conserve la valeur de
  // chargement plutôt que de bloquer l'UI.
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((user) => {
        if (!cancelled) setCurrentUser(user);
      })
      .catch(() => {
        // 401 → redirection gérée par apiFetch ; autres erreurs : on garde la valeur
        // de chargement (skeleton retiré quand même pour ne pas figer l'UI).
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // PATCH /api/me : prénom, nom, couleur. Au succès on applique le profil renvoyé par
  // le backend (source de vérité). Si l'appel rejette, EditProfilePopup garde le popup
  // ouvert et affiche l'erreur.
  // TODO : upload de la photo (multipart) — non géré côté backend pour l'instant.
  const saveProfile = async (profile: ProfileUpdate) => {
    const updated = await updateMe({
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatarColor: profile.avatarColor,
    });
    setCurrentUser(updated);
  };

  return { currentUser, profileLoading, isAdmin, saveProfile };
}
