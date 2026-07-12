import { describe, it, expect } from 'vitest';
import { normalizeCourseChannelsFromSources } from './courseChannelSources.ts';
import { type Forum, type Quiz } from '../../types/domain.ts';

describe('normalizeCourseChannelsFromSources', () => {
  it('retourne une liste vide quand aucune source n\'est fournie', () => {
    expect(normalizeCourseChannelsFromSources({})).toEqual([]);
  });

  it('retourne une liste vide pour des collections vides', () => {
    expect(normalizeCourseChannelsFromSources({ quizzes: [], forums: [] })).toEqual([]);
  });

  it('mappe un quiz vers un canal de type "quiz" (id + title→name)', () => {
    const quizzes: Quiz[] = [{ id: 7, title: 'Quiz A' }];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result).toEqual([{ id: 7, name: 'Quiz A', type: 'quiz' }]);
  });

  it('mappe un forum Discussion vers le type "text" et conserve messages', () => {
    const forums: Forum[] = [
      { id: 3, title: 'Général', fType: 'Discussion', messages: [{ id: 1, content: 'hi', createdAt: 'x', author: { id: 9, username: 'auteur', firstName: 'A', lastName: 'B' } }] },
    ];
    const result = normalizeCourseChannelsFromSources({ forums });
    expect(result).toEqual([
      { id: 3, name: 'Général', type: 'text', messages: [{ id: 1, content: 'hi', createdAt: 'x', author: { id: 9, username: 'auteur', firstName: 'A', lastName: 'B' } }] },
    ]);
  });

  it('mappe un forum Thread vers le type "forum"', () => {
    const forums: Forum[] = [{ id: 4, title: 'Entraide', fType: 'Thread' }];
    const result = normalizeCourseChannelsFromSources({ forums });
    expect(result[0].type).toBe('forum');
    expect(result[0]).toMatchObject({ id: 4, name: 'Entraide' });
  });

  it('traite un forum sans fType comme Thread (défaut) → type "forum"', () => {
    const forums: Forum[] = [{ id: 5, title: 'Sans type' }];
    const result = normalizeCourseChannelsFromSources({ forums });
    expect(result[0].type).toBe('forum');
  });

  it('inclut la clé messages (undefined) même quand le forum n\'en a pas', () => {
    const forums: Forum[] = [{ id: 6, title: 'X', fType: 'Thread' }];
    const [channel] = normalizeCourseChannelsFromSources({ forums });
    expect('messages' in channel).toBe(true);
    expect(channel.messages).toBeUndefined();
  });

  it('place tous les quiz avant tous les forums', () => {
    const quizzes: Quiz[] = [{ id: 1, title: 'Q' }];
    const forums: Forum[] = [{ id: 2, title: 'F', fType: 'Thread' }];
    const result = normalizeCourseChannelsFromSources({ quizzes, forums });
    expect(result.map((c) => c.type)).toEqual(['quiz', 'forum']);
  });

  it('trie les quiz par position croissante', () => {
    const quizzes: Quiz[] = [
      { id: 1, title: 'B', position: 2 },
      { id: 2, title: 'A', position: 1 },
      { id: 3, title: 'C', position: 3 },
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result.map((c) => c.name)).toEqual(['A', 'B', 'C']);
  });

  it('trie les forums par position croissante', () => {
    const forums: Forum[] = [
      { id: 1, title: 'F2', fType: 'Thread', position: 5 },
      { id: 2, title: 'F1', fType: 'Thread', position: 1 },
    ];
    const result = normalizeCourseChannelsFromSources({ forums });
    expect(result.map((c) => c.name)).toEqual(['F1', 'F2']);
  });

  it('tri stable : positions égales départagées par l\'ordre d\'insertion', () => {
    const quizzes: Quiz[] = [
      { id: 1, title: 'premier', position: 1 },
      { id: 2, title: 'second', position: 1 },
      { id: 3, title: 'troisieme', position: 1 },
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result.map((c) => c.name)).toEqual(['premier', 'second', 'troisieme']);
  });

  it('les entrées sans position gardent leur index comme clé de tri', () => {
    // sans position → clé = index ; donc a(0), b(1), c(2)
    const quizzes: Quiz[] = [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
      { id: 3, title: 'c' },
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('mélange position définie et absente (index utilisé comme fallback)', () => {
    // positions : p0=index0=0, p1=explicite 0, p2=index2=2 → tie entre 0(index0) et 0(index1) départagé par index
    const quizzes: Quiz[] = [
      { id: 1, title: 'a' }, // clé 0 (index)
      { id: 2, title: 'b', position: 0 }, // clé 0 (explicite)
      { id: 3, title: 'c' }, // clé 2 (index)
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('gère des positions négatives et non contiguës', () => {
    const quizzes: Quiz[] = [
      { id: 1, title: 'zero', position: 0 },
      { id: 2, title: 'neg', position: -5 },
      { id: 3, title: 'big', position: 100 },
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes });
    expect(result.map((c) => c.name)).toEqual(['neg', 'zero', 'big']);
  });

  it('ne mute pas les tableaux sources', () => {
    const quizzes: Quiz[] = [
      { id: 1, title: 'B', position: 2 },
      { id: 2, title: 'A', position: 1 },
    ];
    const snapshot = [...quizzes];
    normalizeCourseChannelsFromSources({ quizzes });
    expect(quizzes).toEqual(snapshot);
  });

  it('combine quiz et forums, chacun trié dans son groupe', () => {
    const quizzes: Quiz[] = [
      { id: 1, title: 'Q2', position: 2 },
      { id: 2, title: 'Q1', position: 1 },
    ];
    const forums: Forum[] = [
      { id: 3, title: 'F2', fType: 'Discussion', position: 2 },
      { id: 4, title: 'F1', fType: 'Thread', position: 1 },
    ];
    const result = normalizeCourseChannelsFromSources({ quizzes, forums });
    expect(result.map((c) => c.name)).toEqual(['Q1', 'Q2', 'F1', 'F2']);
    expect(result.map((c) => c.type)).toEqual(['quiz', 'quiz', 'forum', 'text']);
  });
});
