/**
 * Teintes des tuiles de cours, sous du texte blanc. Variables fixes d'un thème à l'autre : celles
 * qui s'éclaircissent en sombre (--brand-teal, --text-label) passeraient sous 4,5:1 de contraste.
 */
const TILE_COLORS = [
  'var(--brand-teal-strong)',
  'var(--brand-deep)',
  'var(--tile-slate)',
  'var(--tile-teal-deep)',
  'var(--text-active)',
];

/** Couleur d'un cours, stable d'une version de la barre à l'autre. */
export function courseTileColor(courseId: number): string {
  return TILE_COLORS[courseId % TILE_COLORS.length];
}
