import { useCallback, useEffect, useRef, useState } from 'react';
import { type MaybePromise } from './programsApi';

/**
 * Pilote les états « API-ready » du chargement de la liste des programmes de
 * l'utilisateur (GET) : `loading`, `loadError`, `reload`. Volontairement MINIMAL —
 * il ne détient PAS les programmes (Dashboard en reste propriétaire) : il
 * orchestre seulement l'appel et ses états, en déléguant l'effet de bord (mise à
 * jour de l'état parent) au callback `fetchPrograms`.
 *
 * Miroir de useCoursesLoader, mais sans clé : la liste est celle de l'utilisateur
 * connecté, chargée une fois au montage.
 */
export interface ProgramsLoaderApi {
  /** Chargement de la liste en cours. */
  loading: boolean;
  /** Erreur du dernier chargement (null = aucune). */
  loadError: string | null;
  /** Relance le chargement (bouton « Réessayer »). */
  reload: () => void;
}

export function useProgramsLoader(fetchPrograms?: () => MaybePromise<unknown>): ProgramsLoaderApi {
  // Démarre en « chargement » si un fetch est fourni : sinon, au tout premier
  // render, `loading` serait false et un consommateur chaîné (fetch programmes →
  // fetch cours) se déclencherait à tort avant que les programmes ne chargent.
  const [loading, setLoading] = useState<boolean>(Boolean(fetchPrograms));
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Composant monté ? Ignore les réponses async revenant après démontage. */
  const mountedRef = useRef(true);
  /** Dernière version du fetch (ref → l'effet ne se relance pas à chaque render). */
  const fetchRef = useRef(fetchPrograms);
  useEffect(() => {
    fetchRef.current = fetchPrograms;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const run = fetchRef.current;
    if (!run) return;
    setLoading(true);
    setLoadError(null);
    try {
      await run();
    } catch {
      if (mountedRef.current) setLoadError('Impossible de charger les programmes. Réessaie.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // Chargement initial au montage.
  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, loadError, reload: () => void reload() };
}
