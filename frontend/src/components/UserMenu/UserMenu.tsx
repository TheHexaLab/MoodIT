import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import styles from './UserMenu.module.css';
import { useTheme } from '../../helpers/theme.ts';
import { useCurrentUser } from '../../context/currentUserContext.ts';
import { Moon } from '../../assets/Moon.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { Sliders } from '../../assets/Sliders.tsx';
import { AuditLog } from '../../assets/AuditLog.tsx';
import { Copy } from '../../assets/Copy.tsx';
import { Check } from '../../assets/Check.tsx';
import { LogOut } from '../../assets/LogOut.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { type User as UserMenuUser } from '../../types/domain.ts';

// L'utilisateur affiché est l'entité User du domaine (source unique).
// `UserMenuUser` est conservé comme alias de compat pour les imports existants.
export type { UserMenuUser };

interface UserMenuProps {
  /** Utilisateur actuellement connecte. */
  user?: UserMenuUser | null;
  /**
   * Profil en cours de chargement (GET /api/me) : affiche un skeleton à la place de
   * l'avatar/nom et neutralise l'ouverture du menu tant que les données ne sont pas là.
   */
  loading?: boolean;
  /** Ouvre le formulaire de modification du profil. */
  onEditProfile?: () => void;
  /**
   * Ouvre le gestionnaire des administrateurs (rôles GLOBAUX). Fourni UNIQUEMENT si
   * l'utilisateur y a droit (admin général / gardien) : sinon l'entrée est masquée.
   */
  onManageAdmins?: () => void;
  /**
   * Ouvre le journal d'audit (actions de gestion). Fourni UNIQUEMENT au Gardien : sinon
   * l'entrée est masquée.
   */
  onViewAuditLogs?: () => void;
  /** Déconnecte l'utilisateur. */
  onLogout?: () => void;
  /**
   * Apparence du déclencheur :
   * - 'footer' (défaut) : ligne complète (avatar + nom) dans le pied de la barre.
   * - 'compact' : pastille d'avatar seule (barre mobile en haut à droite).
   */
  variant?: 'footer' | 'compact';
}

/**
 * Affiche l'utilisateur connecte dans le pied de la barre laterale cours.
 * Au clic, ouvre un menu (popover) en trois sections : carte d'identité,
 * préférences (thème, profil, copier le nom) et déconnexion.
 */
const MOBILE_QUERY = '(max-width: 900px)';

export default function UserMenu({
  user,
  loading = false,
  onEditProfile,
  onManageAdmins,
  onViewAuditLogs,
  onLogout,
  variant = 'footer',
}: UserMenuProps): React.ReactElement {
  const navigate = useNavigate();
  const displayName = getDisplayName(user);
  const username = user?.username?.trim() ?? '';
  const handle = username ? `@${username}` : '@utilisateur';
  const initials = getInitials(displayName);

  const { theme, setTheme } = useTheme();
  const { saveSettings } = useCurrentUser();
  // Bascule le thème ET le persiste en BD (settings utilisateur) : il suit alors
  // l'utilisateur d'un appareil à l'autre. On calcule la valeur cible explicitement
  // pour l'appliquer localement (setTheme) et l'envoyer (saveSettings) de façon cohérente.
  const handleToggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveSettings({ theme: next });
  }, [theme, setTheme, saveSettings]);
  const [isOpen, setIsOpen] = useState(false);
  /** Fermeture en cours : joue l'animation de sortie avant de démonter le popup. */
  const [isClosing, setIsClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Position fixe (viewport) du popup ; null tant qu'il n'est pas ouvert. */
  const [popupPos, setPopupPos] = useState<{ left: number; bottom: number } | null>(null);
  // En mobile, le popup devient un « bottom sheet » (collé en bas, pleine largeur,
  // avec scrim) : sa position est gérée par le CSS, pas par computePosition.
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const copyResetRef = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Calcule la position du popup (au-dessus du déclencheur, largeur fixe 15rem).
  // En fixed + portail vers <body>, on échappe au overflow:hidden de la sidebar.
  // En mobile, on ne calcule rien : le CSS ancre la feuille au bas de l'écran.
  const computePosition = useCallback(() => {
    if (window.matchMedia(MOBILE_QUERY).matches) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const popupWidth = 15 * rootFontSize;
    const gap = 8;
    const maxLeft = window.innerWidth - popupWidth - gap;
    const left = Math.max(gap, Math.min(rect.left, maxLeft));
    setPopupPos({ left, bottom: window.innerHeight - rect.top + gap });
  }, []);

  // Demande la fermeture : joue l'animation de sortie (ou ferme immédiatement si
  // l'utilisateur préfère les animations réduites). Le démontage a lieu à la fin
  // de l'animation (onAnimationEnd → finalizeClose).
  const requestClose = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setIsOpen(false);
      setIsClosing(false);
      setPopupPos(null);
    } else {
      setIsClosing(true);
    }
  }, []);

  // Ferme le menu au clic extérieur (déclencheur ou popup porté) ou sur Échap ;
  // recalcule la position au resize / scroll tant qu'il est ouvert.
  useEffect(() => {
    if (!isOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      requestClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') requestClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', computePosition);
    window.addEventListener('scroll', computePosition, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', computePosition);
      window.removeEventListener('scroll', computePosition, true);
    };
  }, [isOpen, computePosition, requestClose]);

  function toggleOpen() {
    if (loading) return; // pas de menu tant que le profil n'est pas chargé
    if (isOpen) {
      if (isClosing) setIsClosing(false); // ré-ouverture pendant l'animation de sortie
      else requestClose();
      return;
    }
    setIsClosing(false);
    computePosition();
    setIsOpen(true);
  }

  // Fin de l'animation de sortie : démonte réellement le popup.
  function handlePopupAnimationEnd() {
    if (isClosing) {
      setIsOpen(false);
      setIsClosing(false);
      setPopupPos(null);
    }
  }

  // Nettoie le minuteur du retour visuel « copié » au démontage.
  useEffect(() => () => {
    if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
  }, []);

  async function copyUsername() {
    if (!username) return;
    try {
      await navigator.clipboard.writeText(username);
      setCopied(true);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Presse-papiers indisponible : on ignore silencieusement.
    }
  }

  function handleEditProfile() {
    requestClose();
    onEditProfile?.();
  }

  function handleManageAdmins() {
    requestClose();
    onManageAdmins?.();
  }

  function handleViewAuditLogs() {
    requestClose();
    onViewAuditLogs?.();
  }

  async function handleLogout() {
    // Ferme le menu puis tente la déconnexion serveur ; quoi qu'il arrive, nettoie l'état client et redirige.
    requestClose();

    try {
      await fetch('/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } finally {
      onLogout?.();
      navigate('/login');
    }
  }

  return (
    <div
      className={`${styles.root}${variant === 'compact' ? ` ${styles.rootCompact}` : ''}`}
      ref={rootRef}
    >
      {isOpen &&
        (isMobile || popupPos) &&
        createPortal(
          <div className={styles.mobilePopupContainer}>
            {/* Scrim mobile : assombrit l'arrière-plan derrière la feuille. */}
            {isMobile && (
              <button
                type="button"
                className={`${styles.sheetBackdrop}${isClosing ? ` ${styles.sheetBackdropClosing}` : ''}`}
                aria-label="Fermer le menu du compte"
                onClick={requestClose}
              />
            )}
            <div
              ref={popupRef}
              className={`${styles.popup}${isMobile ? ` ${styles.popupSheet}` : ''}${isClosing ? ` ${styles.popupClosing}` : ''}`}
              role="menu"
              aria-label="Menu du compte"
              style={isMobile ? undefined : { left: popupPos?.left, bottom: popupPos?.bottom }}
              onAnimationEnd={handlePopupAnimationEnd}
            >
              {/* ── Section 1 : carte d'identité ── */}
              <section className={styles.identity}>
                <span
                  className={styles.identityAvatar}
                  style={{ background: user?.avatarColor || 'var(--brand-teal)', color: contrastingTextColor(user?.avatarColor || 'var(--brand-teal)') }}
                  aria-hidden="true"
                >
                  {initials}
                </span>
                <div className={styles.identityText}>
                  <span className={styles.identityName}>{displayName}</span>
                  <span className={styles.identityHandle}>{handle}</span>
                </div>
              </section>

              {/* ── Section 2 : préférences ── */}
              <section className={styles.actions}>
                <div className={styles.actionRow}>
                  <span className={styles.actionLabel}>
                    <Moon
                      className={styles.actionIcon}
                      width="1rem"
                      height="1rem"
                      aria-hidden="true"
                    />
                    Mode sombre
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={theme === 'dark'}
                    aria-label="Mode sombre"
                    className={`${styles.toggle}${theme === 'dark' ? ` ${styles.toggleOn}` : ''}`}
                    onClick={handleToggleTheme}
                  >
                    <span className={styles.toggleKnob} />
                  </button>
                </div>

                <button
                  type="button"
                  className={styles.actionButton}
                  role="menuitem"
                  onClick={handleEditProfile}
                >
                  <span className={styles.actionLabel}>
                    <Pencil
                      className={styles.actionIcon}
                      width="1rem"
                      height="1rem"
                      aria-hidden="true"
                    />
                    Modifier le profil
                  </span>
                </button>

                {onManageAdmins && (
                  <button
                    type="button"
                    className={styles.actionButton}
                    role="menuitem"
                    onClick={handleManageAdmins}
                  >
                    <span className={styles.actionLabel}>
                      <Sliders
                        className={styles.actionIcon}
                        width="1rem"
                        height="1rem"
                        aria-hidden="true"
                      />
                      Gérer les administrateurs
                    </span>
                  </button>
                )}

                {onViewAuditLogs && (
                  <button
                    type="button"
                    className={styles.actionButton}
                    role="menuitem"
                    onClick={handleViewAuditLogs}
                  >
                    <span className={styles.actionLabel}>
                      <AuditLog
                        className={styles.actionIcon}
                        width="1rem"
                        height="1rem"
                        aria-hidden="true"
                      />
                      Journalisation
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  className={styles.actionButton}
                  role="menuitem"
                  onClick={copyUsername}
                >
                  <span className={styles.actionLabel}>
                    {copied ? (
                      <Check
                        className={styles.actionIcon}
                        width="1rem"
                        height="1rem"
                        aria-hidden="true"
                      />
                    ) : (
                      <Copy
                        className={styles.actionIcon}
                        width="1rem"
                        height="1rem"
                        aria-hidden="true"
                      />
                    )}
                    {copied ? 'Nom copié' : "Copier le nom d'utilisateur"}
                  </span>
                </button>
              </section>

              {/* ── Section 3 : déconnexion ── */}
              <section className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.actionButton} ${styles.logout}`}
                  role="menuitem"
                  onClick={handleLogout}
                >
                  <span className={styles.actionLabel}>
                    <LogOut
                      className={styles.actionIcon}
                      width="1rem"
                      height="1rem"
                      aria-hidden="true"
                    />
                    Se déconnecter
                  </span>
                </button>
              </section>
            </div>
          </div>,
          document.body
        )}

      {loading ? (
        variant === 'compact' ? (
          <span
            className={`${styles.compactTrigger} ${styles.skeleton} ${styles.skeletonAvatarCompact}`}
            aria-hidden="true"
          />
        ) : (
          <div className={`${styles.userMenu} ${styles.userMenuLoading}`} aria-busy="true">
            <span
              className={`${styles.userAvatarInitials} ${styles.skeleton} ${styles.skeletonAvatar}`}
              aria-hidden="true"
            />
            <span className={styles.userInfo}>
              <span className={`${styles.skeleton} ${styles.skeletonName}`} aria-hidden="true" />
              <span className={`${styles.skeleton} ${styles.skeletonHandle}`} aria-hidden="true" />
            </span>
          </div>
        )
      ) : variant === 'compact' ? (
        <button
          ref={triggerRef}
          className={`${styles.compactTrigger}${isOpen ? ` ${styles.compactTriggerOpen}` : ''}`}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label="Compte utilisateur"
          style={{
            background: user?.avatarColor || 'var(--brand-teal)',
            color: contrastingTextColor(user?.avatarColor || 'var(--brand-teal)'),
          }}
        >
          {initials}
        </button>
      ) : (
        <button
          ref={triggerRef}
          className={`${styles.userMenu}${isOpen ? ` ${styles.userMenuOpen}` : ''}`}
          type="button"
          onClick={toggleOpen}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          aria-label="Compte utilisateur"
        >
          <span
            className={styles.userAvatarInitials}
            style={{
              background: user?.avatarColor || 'var(--brand-teal)',
              color: contrastingTextColor(user?.avatarColor || 'var(--brand-teal)'),
            }}
            aria-hidden="true"
          >
            {initials}
          </span>
          <span className={styles.userInfo}>
            <span className={styles.userName}>{displayName}</span>
            <span className={styles.userHandle}>{handle}</span>
          </span>
        </button>
      )}
    </div>
  );
}

function getDisplayName(user?: UserMenuUser | null): string {
  if (!user) return 'Utilisateur';

  const firstName = user.firstName?.trim() ?? '';
  const lastName = user.lastName?.trim() ?? '';
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;

  return user.username?.trim() || 'Utilisateur';
}

function getInitials(displayName: string): string {
  const words = displayName
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);

  if (words.length === 0) return 'U';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
