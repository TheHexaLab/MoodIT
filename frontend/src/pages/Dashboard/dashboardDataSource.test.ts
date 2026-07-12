import { describe, it, expect } from 'vitest';
import {
  dashboardDataSource,
  getDashboardPrograms,
} from './dashboardDataSource.ts';
import { dashboardProgramsMock } from '../../mocks/dashboardData.ts';

/**
 * Tests du point de bascule des données du Dashboard (dashboardDataSource.ts).
 * Module purement synchrone : pas de réseau. On vérifie le mode courant et la
 * sélection de jeu de données associée.
 */

describe('dashboardDataSource', () => {
  it('est fixé sur "demo" (mode de développement courant)', () => {
    expect(dashboardDataSource).toBe('demo');
  });
});

describe('getDashboardPrograms', () => {
  it('retourne le mock de démonstration pour le mode "demo"', () => {
    const out = getDashboardPrograms();
    expect(out).toBe(dashboardProgramsMock);
  });

  it('retourne une liste non vide de programmes', () => {
    const out = getDashboardPrograms();
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });
});
