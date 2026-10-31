import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSidebarCollapsed, storeSidebarCollapsed } from './sidebarPreference';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('sidebarPreference', () => {
  it('rien de mémorisé : barre complète', () => {
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('relit le choix mémorisé', () => {
    storeSidebarCollapsed(true);
    expect(readSidebarCollapsed()).toBe(true);
    storeSidebarCollapsed(false);
    expect(readSidebarCollapsed()).toBe(false);
  });

  it('stockage indisponible : aucune erreur', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqué');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqué');
    });
    expect(readSidebarCollapsed()).toBe(false);
    expect(() => storeSidebarCollapsed(true)).not.toThrow();
  });
});
