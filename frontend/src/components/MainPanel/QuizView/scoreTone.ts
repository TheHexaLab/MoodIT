/**
 * Teinte d'un score selon le POURCENTAGE obtenu :
 *   - `bad`  (< 50 %)      → rouge, croix.
 *   - `warn` (50 % – 77 %) → jaune, avertissement.
 *   - `good` (≥ 78 %)      → vert, crochet.
 */
export type ScoreTone = 'good' | 'warn' | 'bad';

export function scoreTone(earned: number, max: number): ScoreTone {
  if (max <= 0) return 'good';
  const percent = (earned / max) * 100;
  if (percent >= 78) return 'good';
  if (percent >= 50) return 'warn';
  return 'bad';
}
