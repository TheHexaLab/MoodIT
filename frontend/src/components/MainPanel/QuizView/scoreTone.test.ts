import { describe, it, expect } from 'vitest';
import { scoreTone } from './scoreTone';

describe('scoreTone', () => {
  it("retourne 'good' quand max <= 0 (division impossible)", () => {
    expect(scoreTone(0, 0)).toBe('good');
    expect(scoreTone(5, 0)).toBe('good');
    expect(scoreTone(3, -1)).toBe('good');
    expect(scoreTone(-2, -4)).toBe('good');
  });

  it("retourne 'good' pour >= 78 %", () => {
    expect(scoreTone(78, 100)).toBe('good');
    expect(scoreTone(100, 100)).toBe('good');
    expect(scoreTone(9, 10)).toBe('good');
    // au-delà de 100 % (surcrédit théorique)
    expect(scoreTone(120, 100)).toBe('good');
  });

  it("retourne 'warn' pour 50 % .. < 78 %", () => {
    expect(scoreTone(50, 100)).toBe('warn');
    expect(scoreTone(77, 100)).toBe('warn');
    expect(scoreTone(77.9, 100)).toBe('warn');
    expect(scoreTone(1, 2)).toBe('warn');
  });

  it("retourne 'bad' pour < 50 %", () => {
    expect(scoreTone(49, 100)).toBe('bad');
    expect(scoreTone(0, 100)).toBe('bad');
    expect(scoreTone(0, 10)).toBe('bad');
    expect(scoreTone(49.999, 100)).toBe('bad');
  });

  it('gère les bornes exactes 78 et 50', () => {
    expect(scoreTone(78, 100)).toBe('good');
    expect(scoreTone(50, 100)).toBe('warn');
  });
});
