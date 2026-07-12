import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useProgramsLoader } from './useProgramsLoader';

afterEach(cleanup);

describe('useProgramsLoader', () => {
  it('démarre en loading quand un fetch est fourni, puis charge au montage', async () => {
    const fetchPrograms = vi.fn(async () => [{ id: 1 }]);
    const { result } = renderHook(() => useProgramsLoader(fetchPrograms));

    // loading initialisé à true (Boolean(fetchPrograms))
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchPrograms).toHaveBeenCalledTimes(1);
    expect(result.current.loadError).toBeNull();
  });

  it('positionne loadError si le fetch rejette', async () => {
    const fetchPrograms = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useProgramsLoader(fetchPrograms));

    await waitFor(() => expect(result.current.loadError).toBe('Impossible de charger les programmes. Réessaie.'));
    expect(result.current.loading).toBe(false);
  });

  it('reload relance le fetch et efface une erreur précédente', async () => {
    let shouldFail = true;
    const fetchPrograms = vi.fn(async () => {
      if (shouldFail) throw new Error('boom');
      return [];
    });
    const { result } = renderHook(() => useProgramsLoader(fetchPrograms));
    await waitFor(() => expect(result.current.loadError).not.toBeNull());

    shouldFail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loadError).toBeNull());
    expect(fetchPrograms).toHaveBeenCalledTimes(2);
  });

  it('sans fetch : loading démarre à false et rien n\'est appelé', async () => {
    const { result } = renderHook(() => useProgramsLoader(undefined));
    expect(result.current.loading).toBe(false);
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeNull();
  });
});
