/**
 * Choisit une couleur de texte lisible sur un fond donné selon sa luminance :
 * fond clair → texte sombre, fond sombre → texte clair.
 *
 * @param bg     Couleur de fond au format hex ('#rgb', `#rrggbb` ou `#rrggbbaa').
 * @param dark   Couleur retournée si le fond est clair (défaut `#000').
 * @param light  Couleur retournée si le fond est sombre (défaut `#fff').
 * @param threshold seuil de luminance (0–1) ; plus haut = favorise la couleur claire.
 */
export function contrastingTextColor(
  bg: string,
  { dark = '#000', light = '#fff', threshold = 0.6 }: {
    dark?: string;
    light?: string;
    threshold?: number;
  } = {}
): string {
  let hex = bg.replace('#', '');
  // Forme courte (#rgb) → étendue (#rrggbb).
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (hex.length < 6) return light;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return light;

  // Luminance perçue (pondération YIQ), normalisée 0–1.
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > threshold ? dark : light;
}
