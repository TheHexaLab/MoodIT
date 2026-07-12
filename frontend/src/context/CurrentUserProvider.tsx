// Provider du profil connecté : effectue l'UNIQUE GET /api/me et le partage à toute
// la zone protégée (garde de route + UserMenu + Dashboard). Réussir cet appel prouve
// que le token est valide en BD (le gateway le vérifie pour répondre) → ProtectedRoute
// s'en sert comme validation forte, et le Dashboard récupère le profil déjà chargé :
// un seul appel réseau au lieu de deux.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getMe, updateMe, updateMeSettings } from '../helpers/api.ts';
import { getToken } from '../helpers/auth.ts';
import { ROLE } from '../helpers/roles.ts';
import type { Role, User } from '../types/domain.ts';
import type { ProfileUpdate } from '../components/EditProfilePopup/types.ts';
import {
  parseUserSettings,
  serializeUserSettings,
  type UserSettings,
} from '../helpers/userSettings.ts';
import { useTheme } from './themeContext.ts';
import { CurrentUserContext, type AuthStatus, type CurrentUserApi } from './currentUserContext.ts';

// Délai de regroupement des sauvegardes de settings : la localisation change à chaque
// navigation ; on n'émet qu'un seul PUT après la rafale.
const SETTINGS_SAVE_DEBOUNCE_MS = 1000;

// Identité neutre affichée tant que /api/me n'a pas répondu : aucun faux nom.
const loadingUser: User = {
  id: -1,
  username: '',
  firstName: '',
  lastName: '',
  avatarColor: '#0a5cc0',
};

// Rôles GLOBAUX (User_Role) accordant les droits plateforme. Le gardien est
// au-dessus de l'administrateur général : il en est un SUPERSET (isAdmin true pour les deux).
// Les rôles enseignant/administrateur PAR programme (User_Program_Role) ne sont pas gérés ici.
const ADMIN_ROLE_NAME = ROLE.ADMIN;
const SUPER_ADMIN_ROLE_NAME = ROLE.GUARDIAN;

export default function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<User>(loadingUser);
  // 'checking' seulement s'il y a un token à valider ; sinon directement 'unauthed'
  // (pas de setState synchrone dans l'effet → pas de rendu en cascade).
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'checking' : 'unauthed'));

  // Thème partagé : la BD fait autorité, on réaligne le cache local (localStorage/data-theme)
  // sur les settings dès que /api/me a répondu.
  const { setTheme } = useTheme();

  // Préférences parsées, dérivées du blob brut renvoyé par l'API.
  const settings = useMemo<UserSettings>(
    () => parseUserSettings(currentUser.settings),
    [currentUser.settings]
  );
  // Copie « live » des settings pour fusionner sans dépendre d'une closure figée
  // (plusieurs saveSettings peuvent s'enchaîner dans le même tick).
  const settingsRef = useRef<UserSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  // Minuteur de debounce du PUT /api/me/settings.
  const saveTimerRef = useRef<number | null>(null);

  const isGuardian =
    currentUser.roles?.some((role) => role.name === SUPER_ADMIN_ROLE_NAME) ?? false;
  // Gardien ⊇ admin général : les deux ont les droits d'admin global.
  const isAdmin =
    isGuardian ||
    (currentUser.roles?.some((role) => role.name === ADMIN_ROLE_NAME) ?? false);

  // Validation forte + chargement du profil en un seul appel. GET /api/me transite par
  // le gateway (signature + token actif en BD via /auth/validate) : un succès vaut
  // authentification. En cas d'échec (401 déjà purgé/redirigé par apiFetch, ou 503),
  // on refuse l'accès.
  useEffect(() => {
    if (!getToken()) return; // status déjà 'unauthed' via l'init

    let cancelled = false;
    getMe()
      .then((user) => {
        if (cancelled) return;
        setCurrentUser(user);
        localStorage.setItem('moodit_user_id', String(user.id));
        // Réaligne le thème sur la BD (source de vérité, suit l'appareil). Si aucun
        // thème enregistré (compte neuf), on garde le cache local / la préférence OS.
        const savedTheme = parseUserSettings(user.settings).theme;
        if (savedTheme) setTheme(savedTheme);
        setStatus('authed');
      })
      .catch(() => {
        if (!cancelled) setStatus('unauthed');
      });

    return () => {
      cancelled = true;
    };
  }, [setTheme]);

  // Envoie IMMÉDIATEMENT une sauvegarde en attente (annule le debounce). `keepalive`
  // permet à la requête de survivre au déchargement de la page (refresh / fermeture).
  const flushSettings = useCallback((keepalive: boolean) => {
    if (!saveTimerRef.current) return; // rien en attente
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    updateMeSettings(settingsRef.current, { keepalive }).catch(() => {
      // Non critique : aucun message d'erreur.
    });
  }, []);

  // Flush avant que la page ne disparaisse (refresh / fermeture / passage en arrière-plan) :
  // sinon un changement de position survenu < 1 s avant le refresh serait perdu (debounce
  // annulé au démontage). `pagehide` couvre le refresh ; `visibilitychange→hidden` couvre
  // le changement d'onglet / la mise en arrière-plan mobile.
  useEffect(() => {
    const onPageHide = () => flushSettings(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushSettings(true);
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [flushSettings]);

  // Fusionne `patch` dans les settings courants, applique une mise à jour optimiste locale
  // (le blob sérialisé devient la nouvelle valeur de currentUser.settings) et planifie un
  // PUT /api/me/settings debouncé. Un échec réseau est ignoré silencieusement : les
  // préférences sont non critiques et le prochain enregistrement retentera.
  const saveSettings = useCallback((patch: Partial<UserSettings>) => {
    const merged: UserSettings = { ...settingsRef.current, ...patch };
    settingsRef.current = merged;
    const serialized = serializeUserSettings(merged);
    setCurrentUser((prev) => ({ ...prev, settings: serialized }));

    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      updateMeSettings(settingsRef.current).catch(() => {
        // Non critique : on n'interrompt pas l'expérience si la sauvegarde échoue.
      });
    }, SETTINGS_SAVE_DEBOUNCE_MS);
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
    // On PRÉSERVE les settings locaux : PATCH /me ne les modifie pas, et sa réponse porte
    // un instantané BD qui pourrait être plus ancien qu'une sauvegarde de settings encore
    // debouncée (sinon on écraserait le thème/la localisation en attente d'envoi).
    setCurrentUser((prev) => ({ ...updated, settings: prev.settings }));
  };

  // Écho WS `user:globalRolesChanged` : remplace les rôles globaux → isAdmin/isGuardian
  // se recalculent au rendu suivant (le bouton « Gérer les administrateurs » apparaît/disparaît).
  const applyGlobalRoles = useCallback((roles: Role[]) => {
    setCurrentUser((prev) => ({ ...prev, roles }));
  }, []);

  const value: CurrentUserApi = {
    status,
    currentUser,
    profileLoading: status === 'checking',
    isAdmin,
    isGuardian,
    saveProfile,
    settings,
    saveSettings,
    applyGlobalRoles,
  };

  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>;
}
