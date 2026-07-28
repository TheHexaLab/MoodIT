import { describe, it, expect } from 'vitest';
import { firstGrapheme, avatarInitials } from './text.ts';

describe('firstGrapheme', () => {
  it('renvoie la première lettre', () => {
    expect(firstGrapheme('Jean')).toBe('J');
  });

  it('ignore les espaces de tête', () => {
    expect(firstGrapheme('  Rosie')).toBe('R');
  });

  it('renvoie un emoji entier (pas une demi-paire de substitution)', () => {
    expect(firstGrapheme('😀Bob')).toBe('😀');
  });

  it('renvoie une chaîne vide pour une entrée vide', () => {
    expect(firstGrapheme('   ')).toBe('');
  });
});

describe('avatarInitials', () => {
  it('concatène prénom + nom en majuscules', () => {
    expect(avatarInitials('Jean', 'Dubois')).toBe('JD');
  });

  it('majuscule les accents', () => {
    expect(avatarInitials('éric', 'nadeau')).toBe('ÉN');
  });

  it('garde les emojis entiers et identiques partout', () => {
    expect(avatarInitials('😀', 'Bob')).toBe('😀B');
    expect(avatarInitials('🎨Design', '🚀Team')).toBe('🎨🚀');
  });

  it('se rabat sur le nom d’utilisateur quand prénom et nom sont vides', () => {
    expect(avatarInitials('', '', 'rlopez')).toBe('R');
  });

  it('utilise le repli fourni quand tout est vide', () => {
    expect(avatarInitials('', '', '', 'U')).toBe('U');
    expect(avatarInitials('')).toBe('?');
  });
});
