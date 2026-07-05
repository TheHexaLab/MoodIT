/**
 * Formate un score au dixième près (format X.X), sans zéro final superflu :
 * 3 → « 3 », 2.5 → « 2.5 », 2.499999 → « 2.5 ». Garde-fou contre les artefacts de flottants.
 */
export function formatScore(n: number): string {
  return String(Math.round(n * 10) / 10);
}
