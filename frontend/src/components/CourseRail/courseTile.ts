/** Teintes des tuiles de cours : toutes à 4,5:1 mini sous du texte blanc. */
const TILE_COLORS = ['#0f766e', '#1f4799', '#454559', '#115e59', '#0a5cc0'];

/** Couleur d'un cours, stable d'un écran à l'autre (barre du portail et rail). */
export function courseTileColor(courseId: number): string {
  return TILE_COLORS[courseId % TILE_COLORS.length];
}
