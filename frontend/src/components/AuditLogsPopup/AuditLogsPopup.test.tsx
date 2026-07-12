import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AuditLogsPopup } from './AuditLogsPopup';
import { defaultLabels } from './labels';
import type { AuditLogEntry } from './types';

// Fermeture immédiate (pas d'attente d'animationend, non émis par jsdom) via reduced-motion.
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reduce : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

/** Génère `count` entrées d'ids décroissants à partir de `startId` (comme le backend, récent→ancien). */
function makeEntries(startId: number, count: number): AuditLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: startId - i,
    createdAt: '2026-07-11T10:00:00Z',
    actorEmail: 'a@moodit.ca',
    action: 'COURSE_UPDATE',
    entityType: 'COURSE',
    entityId: startId - i,
    summary: `Action ${startId - i}`,
    details: null,
  }));
}

const PAGE = 30;

beforeEach(() => {
  stubReducedMotion(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuditLogsPopup', () => {
  it('charge la première page au montage (q vide, type null, limit)', async () => {
    const load = vi.fn().mockResolvedValue([]);
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(load.mock.calls[0][0]).toEqual(
      expect.objectContaining({ q: '', type: null, limit: PAGE })
    );
  });

  it('rend les entrées (résumé + acteur + badge de type)', async () => {
    const load = vi.fn().mockResolvedValue(makeEntries(100, 2));
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    expect(await screen.findByText('Action 100')).toBeTruthy();
    expect(screen.getAllByText('a@moodit.ca').length).toBeGreaterThan(0);
    expect(screen.getAllByText(defaultLabels.entityTypes.COURSE).length).toBeGreaterThan(0);
  });

  it('affiche « Système » quand l’acteur est null', async () => {
    const e = { ...makeEntries(5, 1)[0], actorEmail: null };
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([e])} />);
    expect(await screen.findByText(defaultLabels.unknownActor)).toBeTruthy();
  });

  it('état vide (sans filtre) quand la page est vide', async () => {
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([])} />);
    expect(await screen.findByText(defaultLabels.empty)).toBeTruthy();
  });

  it('affiche les filtres fixes par type (toujours présents)', async () => {
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([])} />);
    expect(await screen.findByRole('button', { name: defaultLabels.filterAll })).toBeTruthy();
    expect(screen.getByRole('button', { name: defaultLabels.entityTypes.ENROLLMENT })).toBeTruthy();
  });

  it('cliquer un filtre relance une requête serveur avec ce type', async () => {
    const load = vi.fn().mockResolvedValue(makeEntries(10, 2));
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await screen.findByText('Action 10');
    fireEvent.click(screen.getByRole('button', { name: defaultLabels.entityTypes.ROLE }));
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ type: 'ROLE' }))
    );
  });

  it('la recherche (debouncée) part au réseau avec q', async () => {
    const load = vi.fn().mockResolvedValue(makeEntries(10, 2));
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await screen.findByText('Action 10');
    fireEvent.change(screen.getByPlaceholderText(defaultLabels.searchPlaceholder), {
      target: { value: 'gif201' },
    });
    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(expect.objectContaining({ q: 'gif201' }))
    );
  });

  it('le bouton effacer réinitialise la recherche', async () => {
    const load = vi.fn().mockResolvedValue(makeEntries(10, 2));
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await screen.findByText('Action 10');
    fireEvent.change(screen.getByPlaceholderText(defaultLabels.searchPlaceholder), {
      target: { value: 'x' },
    });
    await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ q: 'x' })));
    fireEvent.click(screen.getByRole('button', { name: defaultLabels.searchClear }));
    await waitFor(() => expect(load).toHaveBeenCalledWith(expect.objectContaining({ q: '' })));
  });

  it('affiche « aucune action pour ce filtre » après une recherche sans résultat', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(makeEntries(10, 2))
      .mockResolvedValue([]);
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await screen.findByText('Action 10');
    fireEvent.change(screen.getByPlaceholderText(defaultLabels.searchPlaceholder), {
      target: { value: 'zzz' },
    });
    expect(await screen.findByText(defaultLabels.emptyFiltered)).toBeTruthy();
  });

  it('pagination on-scroll : charge la page suivante avec le curseur beforeId', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(makeEntries(100, PAGE)) // page pleine → hasMore
      .mockResolvedValueOnce(makeEntries(70, 5)); // dernière page
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    await screen.findByText('Action 100');
    fireEvent.scroll(screen.getByRole('list'));
    expect(await screen.findByText('Action 70')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    // Dernier id de la 1re page (100-29 = 71) devient le curseur.
    expect(load.mock.calls[1][0]).toEqual(expect.objectContaining({ beforeId: 71 }));
  });

  it('en cas d’échec de la 1re page, ErrorPopup + « réessayer » relance', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeEntries(10, 2));
    render(<AuditLogsPopup onClose={vi.fn()} load={load} />);
    expect(await screen.findByText(defaultLabels.loadError)).toBeTruthy();
    fireEvent.click(screen.getByText(defaultLabels.errorRetry));
    expect(await screen.findByText('Action 10')).toBeTruthy();
  });

  it('cliquer une entrée déplie son contexte (details + identifiant)', async () => {
    const e = {
      ...makeEntries(5, 1)[0],
      details: 'Programmes : Génie · Établissements : UdeS',
      entityId: 5,
    };
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([e])} />);
    await screen.findByText('Action 5');
    expect(screen.queryByText('Programmes : Génie')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Action 5/ }));
    expect(screen.getByText('Programmes : Génie')).toBeTruthy();
    expect(screen.getByText('Établissements : UdeS')).toBeTruthy();
    expect(screen.getByText(/Identifiant : #5/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Action 5/ }));
    expect(screen.queryByText('Programmes : Génie')).toBeNull();
  });

  it('une entrée sans contexte n’affiche que l’identifiant (pas de message)', async () => {
    const e = { ...makeEntries(7, 1)[0], details: null, entityId: 7 };
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([e])} />);
    await screen.findByText('Action 7');
    fireEvent.click(screen.getByRole('button', { name: /Action 7/ }));
    expect(screen.getByText(/Identifiant : #7/)).toBeTruthy();
  });

  it('affiche le type « Inscription » pour un enrollment', async () => {
    const e = {
      ...makeEntries(50, 1)[0],
      entityType: 'ENROLLMENT',
      summary: 'Inscription au cours « Algo »',
    };
    render(<AuditLogsPopup onClose={vi.fn()} load={vi.fn().mockResolvedValue([e])} />);
    await screen.findByText('Inscription au cours « Algo »');
    // Le libellé « Inscription » apparaît en chip (fixe) ET en badge de l'entrée.
    expect(screen.getAllByText(defaultLabels.entityTypes.ENROLLMENT).length).toBeGreaterThan(1);
  });

  it('le bouton fermer appelle onClose', async () => {
    const onClose = vi.fn();
    render(<AuditLogsPopup onClose={onClose} load={vi.fn().mockResolvedValue(makeEntries(9, 1))} />);
    await screen.findByText('Action 9');
    fireEvent.click(screen.getByRole('button', { name: defaultLabels.close }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surcharge des libellés via labels', async () => {
    render(
      <AuditLogsPopup
        onClose={vi.fn()}
        load={vi.fn().mockResolvedValue([])}
        labels={{ empty: 'Rien à voir' }}
      />
    );
    expect(await screen.findByText('Rien à voir')).toBeTruthy();
  });
});
