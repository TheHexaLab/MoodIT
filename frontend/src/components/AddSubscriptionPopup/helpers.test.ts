import { describe, it, expect } from 'vitest';
import { normalize, byName } from './helpers.ts';

describe('normalize', () => {
  it('met en minuscules', () => {
    expect(normalize('BONJOUR')).toBe('bonjour');
  });

  it('supprime les accents (NFD + diacritiques)', () => {
    expect(normalize('Génie Logiciel')).toBe('genie logiciel');
    expect(normalize('éàüçñ')).toBe('eaucn');
  });

  it('rogne les espaces de début et de fin', () => {
    expect(normalize('  Café  ')).toBe('cafe');
  });

  it('conserve les espaces internes', () => {
    expect(normalize('a b c')).toBe('a b c');
  });

  it('gère une chaîne vide', () => {
    expect(normalize('')).toBe('');
  });

  it('gère une chaîne uniquement composée d\'espaces', () => {
    expect(normalize('   ')).toBe('');
  });

  it('est idempotent sur une entrée déjà normalisée', () => {
    const once = normalize('Structures de Données');
    expect(normalize(once)).toBe(once);
  });

  it('conserve les chiffres et la ponctuation', () => {
    expect(normalize('GIF-456')).toBe('gif-456');
  });
});

describe('byName', () => {
  const wrap = (name: string) => ({ name });

  it('retourne une valeur négative quand a précède b', () => {
    expect(byName(wrap('alpha'), wrap('beta'))).toBeLessThan(0);
  });

  it('retourne une valeur positive quand a suit b', () => {
    expect(byName(wrap('gamma'), wrap('beta'))).toBeGreaterThan(0);
  });

  it('retourne 0 pour des noms équivalents (sensibilité base)', () => {
    expect(byName(wrap('Éléve'), wrap('eleve'))).toBe(0);
  });

  it('est insensible à la casse', () => {
    expect(byName(wrap('ABC'), wrap('abc'))).toBe(0);
  });

  it('trie un tableau alphabétiquement (accents-insensible)', () => {
    const items = [wrap('Zèbre'), wrap('avion'), wrap('École'), wrap('banane')];
    const sorted = [...items].sort(byName).map((i) => i.name);
    expect(sorted).toEqual(['avion', 'banane', 'École', 'Zèbre']);
  });

  it('fonctionne sur des objets porteurs de champs additionnels', () => {
    const a = { name: 'aaa', id: 1 };
    const b = { name: 'bbb', id: 2 };
    expect(byName(a, b)).toBeLessThan(0);
  });
});
