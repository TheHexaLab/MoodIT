import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useCoursesLoader } from './useCoursesLoader';

afterEach(cleanup);

describe('useCoursesLoader', () => {
  it('charge la liste au montage (loading passe true puis false, sans erreur)', async () => {
    const fetchCourses = vi.fn(async () => [{ id: 1 }]);
    const { result } = renderHook(() => useCoursesLoader(5, fetchCourses));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchCourses).toHaveBeenCalledTimes(1);
    expect(fetchCourses).toHaveBeenCalledWith(5);
    expect(result.current.loadError).toBeNull();
  });

  it('positionne loadError si le fetch rejette', async () => {
    const fetchCourses = vi.fn(async () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useCoursesLoader(5, fetchCourses));

    await waitFor(() => expect(result.current.loadError).toBe('Impossible de charger les cours. Réessayez.'));
    expect(result.current.loading).toBe(false);
  });

  it('reload relance le fetch et efface une erreur précédente', async () => {
    let shouldFail = true;
    const fetchCourses = vi.fn(async () => {
      if (shouldFail) throw new Error('boom');
      return [];
    });
    const { result } = renderHook(() => useCoursesLoader(5, fetchCourses));
    await waitFor(() => expect(result.current.loadError).not.toBeNull());

    shouldFail = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.loadError).toBeNull());
    expect(fetchCourses).toHaveBeenCalledTimes(2);
  });

  it('ne fetche pas quand enabled = false', async () => {
    const fetchCourses = vi.fn(async () => []);
    const { result } = renderHook(() => useCoursesLoader(5, fetchCourses, false));

    await act(async () => { await Promise.resolve(); });
    expect(fetchCourses).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('fetche dès que enabled passe à true', async () => {
    const fetchCourses = vi.fn(async () => []);
    const { result, rerender } = renderHook(
      ({ enabled }) => useCoursesLoader(5, fetchCourses, enabled),
      { initialProps: { enabled: false } }
    );
    await act(async () => { await Promise.resolve(); });
    expect(fetchCourses).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(fetchCourses).toHaveBeenCalledWith(5));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('ne fetche pas si programId < 0', async () => {
    const fetchCourses = vi.fn(async () => []);
    renderHook(() => useCoursesLoader(-1, fetchCourses));
    await act(async () => { await Promise.resolve(); });
    expect(fetchCourses).not.toHaveBeenCalled();
  });

  it('ne fetche pas si aucun fetch fourni (loading reste false)', async () => {
    const { result } = renderHook(() => useCoursesLoader(5, undefined));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loading).toBe(false);
    expect(result.current.loadError).toBeNull();
  });

  it('recharge quand programId change', async () => {
    const fetchCourses = vi.fn(async () => []);
    const { rerender } = renderHook(
      ({ id }) => useCoursesLoader(id, fetchCourses),
      { initialProps: { id: 1 } }
    );
    await waitFor(() => expect(fetchCourses).toHaveBeenCalledWith(1));
    rerender({ id: 2 });
    await waitFor(() => expect(fetchCourses).toHaveBeenCalledWith(2));
    expect(fetchCourses).toHaveBeenCalledTimes(2);
  });
});
