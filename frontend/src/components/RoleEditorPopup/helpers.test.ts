import { describe, it, expect } from 'vitest';
import { initials } from './helpers.ts';
import { type User } from './types.ts';

const makeUser = (firstName: string, lastName: string): User => ({
  id: 1,
  username: 'u',
  firstName,
  lastName,
  email: 'u@example.com',
  avatarColor: '#000000',
  role_ids: [],
});

describe('initials', () => {
  it('concatène la première lettre du prénom et du nom, en majuscules', () => {
    expect(initials(makeUser('Jean', 'Dubois'))).toBe('JD');
  });

  it('met en majuscules des initiales minuscules', () => {
    expect(initials(makeUser('rosie', 'hg'))).toBe('RH');
  });

  it('gère un prénom vide (première lettre absente)', () => {
    expect(initials(makeUser('', 'Dubois'))).toBe('D');
  });

  it('gère un nom vide', () => {
    expect(initials(makeUser('Jean', ''))).toBe('J');
  });

  it('retourne une chaîne vide quand prénom et nom sont vides', () => {
    expect(initials(makeUser('', ''))).toBe('');
  });

  it('n\'utilise que le premier caractère de chaque champ', () => {
    expect(initials(makeUser('Alexandre', 'Tremblay'))).toBe('AT');
  });

  it('majuscule un caractère accentué', () => {
    expect(initials(makeUser('éric', 'nadeau'))).toBe('ÉN');
  });
});
