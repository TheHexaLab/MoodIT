/** Utilitaires de recherche et de tri partagés par les étapes du AddSubscriptionPopup. */

/** Minuscule + suppression des accents : base de comparaison pour la recherche. */
export function normalize(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase('fr');
}

/** Tri par nom (alphabétique, accents-insensible). */
export function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
}
