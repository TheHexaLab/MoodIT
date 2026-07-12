import { describe, it, expect } from 'vitest';
import { formatScore } from './formatScore';

describe('formatScore', () => {
  it('formate les entiers sans décimale', () => {
    expect(formatScore(3)).toBe('3');
    expect(formatScore(0)).toBe('0');
    expect(formatScore(10)).toBe('10');
  });

  it('conserve un dixième significatif', () => {
    expect(formatScore(2.5)).toBe('2.5');
    expect(formatScore(0.1)).toBe('0.1');
  });

  it('arrondit au dixième (garde-fou flottants)', () => {
    expect(formatScore(2.499999)).toBe('2.5');
    expect(formatScore(2.44)).toBe('2.4');
    expect(formatScore(2.45)).toBe('2.5');
    expect(formatScore(0.1 + 0.2)).toBe('0.3');
  });

  it("supprime le zéro final superflu après arrondi", () => {
    expect(formatScore(3.04)).toBe('3');
    expect(formatScore(2.999)).toBe('3');
  });

  it('gère les négatifs', () => {
    expect(formatScore(-1.25)).toBe('-1.2');
    expect(formatScore(-3)).toBe('-3');
  });
});
