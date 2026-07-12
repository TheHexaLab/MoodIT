import { describe, it, expect } from 'vitest';
import { defaultTypeDefinitions } from './channelTypeDefinitions.ts';

describe('defaultTypeDefinitions', () => {
  it('expose exactement 3 définitions', () => {
    expect(defaultTypeDefinitions).toHaveLength(3);
  });

  it('conserve l\'ordre d\'affichage quiz, text, forum', () => {
    expect(defaultTypeDefinitions.map((d) => d.type)).toEqual(['quiz', 'text', 'forum']);
  });

  it('associe chaque type à son label et emptyLabel attendus', () => {
    expect(defaultTypeDefinitions).toEqual([
      { type: 'quiz', label: 'QUIZ', emptyLabel: 'Aucun quiz' },
      { type: 'text', label: 'CANAUX', emptyLabel: 'Aucun canal' },
      { type: 'forum', label: 'FORUMS', emptyLabel: 'Aucun forum' },
    ]);
  });

  it('chaque définition porte les trois champs non vides', () => {
    for (const def of defaultTypeDefinitions) {
      expect(def.type).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.emptyLabel).toBeTruthy();
    }
  });

  it('les types sont uniques', () => {
    const types = defaultTypeDefinitions.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});
