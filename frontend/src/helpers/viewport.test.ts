import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTouchDevice } from './viewport';

// isTouchDevice décide de l'auto-focus des recherches : sur écran tactile (pointeur « grossier »),
// pas d'auto-focus, pour ne pas ouvrir le clavier virtuel à l'ouverture d'une popup.
describe('isTouchDevice', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubMatchMedia(matches: (query: string) => boolean) {
    const matchMedia = vi.fn((query: string) => ({ matches: matches(query), media: query }));
    vi.stubGlobal('matchMedia', matchMedia);
    return matchMedia;
  }

  it('pointeur grossier (tactile : téléphone ou tablette) → vrai', () => {
    const matchMedia = stubMatchMedia((q) => q === '(pointer: coarse)');
    expect(isTouchDevice()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  });

  it('pointeur fin (souris) → faux', () => {
    stubMatchMedia(() => false);
    expect(isTouchDevice()).toBe(false);
  });

  it('matchMedia absent (certains environnements) → faux, sans erreur', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isTouchDevice()).toBe(false);
  });

  it('matchMedia qui n’est pas une fonction → faux', () => {
    vi.stubGlobal('matchMedia', { matches: true });
    expect(isTouchDevice()).toBe(false);
  });

  it('hors navigateur (window absent, rendu serveur) → faux, sans erreur', () => {
    vi.stubGlobal('window', undefined);
    expect(isTouchDevice()).toBe(false);
  });
});
