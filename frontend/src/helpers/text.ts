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
