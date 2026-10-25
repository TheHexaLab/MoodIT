/**
 * Premier caractère « visible » d'une chaîne, en itérant par point de code (et non par
 * unité UTF-16). Ainsi un prénom commençant par un emoji renvoie l'emoji entier plutôt
 * qu'une moitié de paire de substitution (surrogate), qui s'affichait « cassée » (�).
 */
export function firstGrapheme(value: string): string {
  for (const char of value.trim()) return char;
  return '';
}

/** Vrai si le caractère est un emoji / pictogramme (glyphe large et coloré). */
function isPictographic(char: string): boolean {
  return /\p{Extended_Pictographic}/u.test(char);
}

/**
 * Première initiale « lisible » d'un nom : la première lettre ou chiffre (on saute un
 * emoji, une ponctuation ou un espace en tête), et à défaut le premier caractère.
 */
function firstInitial(value: string): string {
  const chars = [...value.trim()];
  return chars.find((c) => /[\p{L}\p{N}]/u.test(c)) ?? chars[0] ?? '';
}

/**
 * Initiales d'avatar UNIFIÉES (messages, forum, recherche d'utilisateurs, menus, aperçu
 * de profil). On PRIVILÉGIE les vraies lettres : « 😀 Bob » / « Léa 🎉 » → « B » / « L ».
 * Si le nom ne contient AUCUNE lettre, on affiche UN SEUL emoji (deux emojis dans une
 * petite pastille rendent mal et se centrent mal — un seul glyphe se centre parfaitement,
 * sans bricolage CSS). Repli sur le nom d'utilisateur, puis sur `fallback`.
 */
export function avatarInitials(
  firstName?: string | null,
  lastName?: string | null,
  username?: string | null,
  fallback = '?'
): string {
  const parts = [firstInitial(firstName ?? ''), firstInitial(lastName ?? '')];
  const letters = parts.filter((c) => c && !isPictographic(c));
  if (letters.length) return letters.join('').toUpperCase();

  // Aucune lettre : un seul emoji (ou premier caractère non vide).
  const emoji = parts.find(Boolean);
  if (emoji) return emoji;

  const fromUsername = firstInitial(username ?? '');
  if (fromUsername) return isPictographic(fromUsername) ? fromUsername : fromUsername.toUpperCase();
  return fallback;
}
