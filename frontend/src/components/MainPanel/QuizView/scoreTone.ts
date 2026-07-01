/** Teinte d'un score : parfait (full), nul (zero) ou partiel (partial). */
export type ScoreTone = 'full' | 'zero' | 'partial';

export function scoreTone(earned: number, max: number): ScoreTone {
  if (max <= 0 || earned >= max) return 'full';
  if (earned <= 0) return 'zero';
  return 'partial';
}
