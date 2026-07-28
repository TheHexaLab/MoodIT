/**
 * Premier caractère « visible » d'une chaîne, en itérant par point de code (et non par
 * unité UTF-16). Ainsi un prénom commençant par un emoji renvoie l'emoji entier plutôt
 * qu'une moitié de paire de substitution (surrogate), qui s'affichait « cassée » (�)
 * dans les bulles d'avatar.
 */
export function firstGrapheme(value: string): string {
  for (const char of value.trim()) return char;
  return '';
}

/**
 * Initiales d'avatar UNIFIÉES (à utiliser partout : messages, forum, recherche
 * d'utilisateurs, menus, aperçu de profil). Prend le premier point de code du prénom
 * puis du nom — donc un emoji s'affiche entier plutôt qu'en « moitié » cassée (�) —,
 * se rabat sur le nom d'utilisateur, puis sur `fallback`. Résultat en majuscules.
 */
export function avatarInitials(
  firstName?: string | null,
  lastName?: string | null,
  username?: string | null,
  fallback = '?'
): string {
  const initials = `${firstGrapheme(firstName ?? '')}${firstGrapheme(lastName ?? '')}`.trim();
  return (initials || firstGrapheme(username ?? '') || fallback).toUpperCase();
}
