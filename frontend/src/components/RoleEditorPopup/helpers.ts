import type { User } from './types.ts';

/** Initiales d'un utilisateur (première lettre du prénom + du nom), en majuscules. */
export function initials(user: User): string {
  return `${user.first_name[0] ?? ''}${user.last_name[0] ?? ''}`.toUpperCase();
}
