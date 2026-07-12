import { describe, it, expect } from 'vitest';
import { useTheme } from './theme';
import { useTheme as useThemeFromContext } from '../context/themeContext';

/**
 * helpers/theme.ts est un simple ré-export de compatibilité vers context/themeContext.
 * On vérifie que le hook exporté est BIEN celui du contexte (pas une réimplémentation).
 * (Invoquer le hook hors d'un composant lève au niveau du dispatcher React — comportement
 *  de React, non de ce module — on ne le teste donc pas ici.)
 */
describe('helpers/theme (ré-export)', () => {
  it('ré-exporte useTheme depuis context/themeContext (même référence)', () => {
    expect(useTheme).toBe(useThemeFromContext);
  });

  it('useTheme est une fonction', () => {
    expect(typeof useTheme).toBe('function');
  });
});
