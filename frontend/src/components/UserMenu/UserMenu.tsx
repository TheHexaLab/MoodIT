import React from 'react';
import styles from './UserMenu.module.css';

export interface UserMenuUser {
  id?: string | number;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  avatarUrl?: string;
}

interface UserMenuProps {
  /** Utilisateur actuellement connecte. */
  user?: UserMenuUser | null;
  /** Action de clic optionnelle (profil, menu contextuel, etc.). */
  onClick?: () => void;
}

/**
 * Affiche l'utilisateur connecte dans le pied de la barre laterale cours.
 * Le rendu reste robuste meme si certaines donnees utilisateur manquent.
 */
export default function UserMenu({ user, onClick }: UserMenuProps): React.ReactElement {
  const displayName = getDisplayName(user);
  const handle = user?.username?.trim() ? `@${user.username.trim()}` : '@utilisateur';
  const initials = getInitials(displayName);

  return (
    <button className={styles.userMenu} type="button" onClick={onClick} aria-label="Compte utilisateur">
      {user?.avatarUrl ? (
        <img src={user.avatarUrl} alt={displayName} className={styles.userAvatarImage} />
      ) : (
        <span className={styles.userAvatarInitials} aria-hidden="true">
          {initials}
        </span>
      )}
      <span className={styles.userInfo}>
        <span className={styles.userName}>{displayName}</span>
        <span className={styles.userHandle}>{handle}</span>
      </span>
    </button>
  );
}

function getDisplayName(user?: UserMenuUser | null): string {
  if (!user) return 'Utilisateur';
  if (user.displayName?.trim()) return user.displayName.trim();

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

