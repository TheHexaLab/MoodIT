import { describe, it, expect } from 'vitest';
import {
  parseUserSettings,
  serializeUserSettings,
  type UserSettings,
} from './userSettings';

/**
 * parseUserSettings : parse défensif du blob settings (tolère null/undefined/JSON corrompu).
 * serializeUserSettings : JSON.stringify simple.
 */
describe('parseUserSettings', () => {
  describe('entrées vides / absentes → objet vide', () => {
    it('undefined', () => {
      expect(parseUserSettings(undefined)).toEqual({});
    });
    it('null', () => {
      expect(parseUserSettings(null)).toEqual({});
    });
    it('sans argument', () => {
      expect(parseUserSettings()).toEqual({});
    });
    it('chaîne vide (falsy)', () => {
      expect(parseUserSettings('')).toEqual({});
    });
  });

  describe('JSON valide objet → renvoyé tel quel', () => {
    it('objet vide', () => {
      expect(parseUserSettings('{}')).toEqual({});
    });
    it('thème seul', () => {
      expect(parseUserSettings('{"theme":"dark"}')).toEqual({ theme: 'dark' });
    });
    it('thème + location complets', () => {
      const raw = JSON.stringify({
        theme: 'light',
        location: { programId: 1, courseId: 2, channel: { type: 'quiz', id: 9 } },
      });
      expect(parseUserSettings(raw)).toEqual({
        theme: 'light',
        location: { programId: 1, courseId: 2, channel: { type: 'quiz', id: 9 } },
      });
    });
    it('conserve les clés inconnues (pas de filtrage)', () => {
      expect(parseUserSettings('{"extra":42}')).toEqual({ extra: 42 });
    });
  });

  describe('JSON corrompu → objet vide (jamais de throw)', () => {
    it('accolade non fermée', () => {
      expect(parseUserSettings('{theme:')).toEqual({});
    });
    it('texte non JSON', () => {
      expect(parseUserSettings('pas du json')).toEqual({});
    });
  });

  describe('JSON valide mais non-objet → objet vide', () => {
    it('nombre', () => {
      expect(parseUserSettings('42')).toEqual({});
    });
    it('chaîne JSON', () => {
      expect(parseUserSettings('"dark"')).toEqual({});
    });
    it('booléen', () => {
      expect(parseUserSettings('true')).toEqual({});
    });
    it('null littéral JSON (parsed falsy)', () => {
      expect(parseUserSettings('null')).toEqual({});
    });
  });

  describe('cas particulier : tableau', () => {
    it('un tableau est typeof "object" → renvoyé tel quel (contrat actuel)', () => {
      // Documente le comportement : typeof [] === 'object' et [] est truthy.
      expect(parseUserSettings('[1,2,3]')).toEqual([1, 2, 3]);
    });
  });
});

describe('serializeUserSettings', () => {
  it('sérialise un objet vide', () => {
    expect(serializeUserSettings({})).toBe('{}');
  });

  it('sérialise thème seul', () => {
    expect(serializeUserSettings({ theme: 'dark' })).toBe('{"theme":"dark"}');
  });

  it('sérialise thème + location', () => {
    const s: UserSettings = {
      theme: 'light',
      location: { programId: 3, courseId: 4 },
    };
    expect(serializeUserSettings(s)).toBe(
      '{"theme":"light","location":{"programId":3,"courseId":4}}'
    );
  });

  it('round-trip : parse(serialize(x)) === x', () => {
    const s: UserSettings = {
      theme: 'dark',
      location: { programId: 7, courseId: 8, channel: { type: 'forum', id: 5 } },
    };
    expect(parseUserSettings(serializeUserSettings(s))).toEqual(s);
  });
});
