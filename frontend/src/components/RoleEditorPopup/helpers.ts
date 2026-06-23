import type { User } from './types.ts';

/** Initiales d'un utilisateur (première lettre du prénom + du nom), en majuscules. */
export function initials(user: User): string {
  return `${user.firstName[0] ?? ''}${user.lastName[0] ?? ''}`.toUpperCase();
}
