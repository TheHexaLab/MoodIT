import type { User } from './types.ts';
import { avatarInitials } from '../../helpers/text.ts';

/** Initiales d'un utilisateur (prénom + nom), unifiées et sûres pour les emojis. */
export function initials(user: User): string {
  return avatarInitials(user.firstName, user.lastName, user.username);
}
