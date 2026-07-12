import { describe, it, expect } from 'vitest';
import { contrastingTextColor } from './color';

/**
 * Choix d'une couleur de texte lisible selon la luminance du fond.
 * Défauts : dark='#000', light='#fff', threshold=0.6.
 */
describe('contrastingTextColor', () => {
  describe('fonds extrêmes (défauts)', () => {
    it('fond blanc (#ffffff, luminance=1 > 0.6) → texte sombre', () => {
      expect(contrastingTextColor('#ffffff')).toBe('#000');
    });

    it('fond noir (#000000, luminance=0) → texte clair', () => {
      expect(contrastingTextColor('#000000')).toBe('#fff');
    });
  });

  describe('forme courte #rgb (étendue en #rrggbb)', () => {
    it('#fff (blanc) → texte sombre', () => {
      expect(contrastingTextColor('#fff')).toBe('#000');
    });

    it('#000 (noir) → texte clair', () => {
      expect(contrastingTextColor('#000')).toBe('#fff');
    });

    it('#f00 (rouge, luminance≈0.299) → texte clair', () => {
      expect(contrastingTextColor('#f00')).toBe('#fff');
    });
  });

  describe('sans le préfixe #', () => {
    it('accepte "ffffff" sans dièse → texte sombre', () => {
      expect(contrastingTextColor('ffffff')).toBe('#000');
    });

    it('accepte "fff" (forme courte sans dièse) → texte sombre', () => {
      expect(contrastingTextColor('fff')).toBe('#000');
    });
  });

  describe('canal alpha (#rrggbbaa) : ignoré, seuls rgb comptent', () => {
    it('#ffffff00 (blanc, alpha nul) → toujours texte sombre', () => {
      expect(contrastingTextColor('#ffffff00')).toBe('#000');
    });

    it('#000000ff (proche noir) → texte clair', () => {
      expect(contrastingTextColor('#000000ff')).toBe('#fff');
    });
  });

  describe('couleurs intermédiaires autour du seuil', () => {
    it('vert pur #00ff00 (luminance≈0.587 < 0.6) → texte clair', () => {
      expect(contrastingTextColor('#00ff00')).toBe('#fff');
    });

    it('bleu pur #0000ff (luminance≈0.114) → texte clair', () => {
      expect(contrastingTextColor('#0000ff')).toBe('#fff');
    });

    it('jaune #ffff00 (luminance≈0.886 > 0.6) → texte sombre', () => {
      expect(contrastingTextColor('#ffff00')).toBe('#000');
    });
  });

  describe('options personnalisées', () => {
    it('utilise les couleurs dark/light fournies', () => {
      expect(contrastingTextColor('#ffffff', { dark: '#111', light: '#eee' })).toBe('#111');
      expect(contrastingTextColor('#000000', { dark: '#111', light: '#eee' })).toBe('#eee');
    });

    it('threshold=0 force presque toujours dark (luminance > 0)', () => {
      expect(contrastingTextColor('#010101', { threshold: 0 })).toBe('#000');
    });

    it('threshold=1 force presque toujours light (luminance jamais > 1)', () => {
      expect(contrastingTextColor('#ffffff', { threshold: 1 })).toBe('#fff');
    });

    it('objet vide utilise les défauts', () => {
      expect(contrastingTextColor('#ffffff', {})).toBe('#000');
    });

    it('seuls certains champs surchargés, les autres restent aux défauts', () => {
      // dark surchargé, light/threshold par défaut
      expect(contrastingTextColor('#ffffff', { dark: '#222' })).toBe('#222');
      expect(contrastingTextColor('#000000', { dark: '#222' })).toBe('#fff');
    });
  });

  describe('entrées invalides → repli sur light', () => {
    it('chaîne vide → light', () => {
      expect(contrastingTextColor('')).toBe('#fff');
    });

    it('trop courte (< 6 après expansion) → light', () => {
      expect(contrastingTextColor('#12')).toBe('#fff');
    });

    it('longueur 4 ou 5 (non 3, non >=6) → light', () => {
      expect(contrastingTextColor('#1234')).toBe('#fff');
      expect(contrastingTextColor('#12345')).toBe('#fff');
    });

    it('caractères hex non valides → NaN → light', () => {
      expect(contrastingTextColor('#zzzzzz')).toBe('#fff');
    });

    it('partiellement invalide (un canal NaN) → light', () => {
      expect(contrastingTextColor('#12zz56')).toBe('#fff');
    });

    it('repli invalide respecte le light personnalisé', () => {
      expect(contrastingTextColor('', { light: '#abc' })).toBe('#abc');
      expect(contrastingTextColor('#zzzzzz', { light: '#abc' })).toBe('#abc');
    });
  });

  describe("cas limites d'expansion", () => {
    it('#rgb à 3 chars étend correctement (#abc → #aabbcc)', () => {
      // #aabbcc : r=170,g=187,b=204 luminance≈0.716 > 0.6 → dark
      expect(contrastingTextColor('#abc')).toBe('#000');
    });

    it('chaîne longue (>6, sans alpha exact) utilise seulement les 6 premiers', () => {
      expect(contrastingTextColor('#ffffffabcdef')).toBe('#000');
    });
  });
});
