import { useCallback, useEffect, useRef, useState } from 'react';
import { type MaybePromise } from '../SectionEditorPopup/SectionEditorPopup';

/**
 * Pilote les états « API-ready » du chargement de la liste des cours d'un
 * programme (GET) : `loading`, `loadError`, `reload`. Volontairement MINIMAL —
 * il ne détient PAS les cours (Dashboard en reste propriétaire) : il orchestre
 * seulement l'appel et ses états, en déléguant l'effet de bord (mise à jour de
 * l'état parent) au callback `fetchCourses`.
 *
 * Modelé sur `reload` de useChannelMessages (ref sur le fetch pour ne pas se
 * relancer si la fonction parente est recréée ; garde anti-démontage).
 */
export interface CoursesLoaderApi {
  /** Chargement de la liste en cours. */
  loading: boolean;
  /** Erreur du dernier chargement (null = aucune). */
  loadError: string | null;
  /** Relance le chargement (bouton « Réessayer »). */
  reload: () => void;
}

export function useCoursesLoader(
  programId: number,
  fetchCourses?: (programId: number) => MaybePromise<unknown>,
  /**
   * Le chargement est-il autorisé ? Sert à chaîner : on attend que la liste des
   * programmes soit chargée (fetch programmes → fetch cours). Tant que `false`,
   * le loader reste en état « chargement » SANS lancer la requête (pas de flash de
   * la liste en cache), puis fetch dès qu'il passe à `true`. Défaut : true.
   */
  enabled: boolean = true
): CoursesLoaderApi {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  /** Composant monté ? Ignore les réponses async revenant après démontage. */
  const mountedRef = useRef(true);
  /** Dernière version du fetch (ref → l'effet ne se relance pas à chaque render). */
  const fetchRef = useRef(fetchCourses);
  useEffect(() => {
    fetchRef.current = fetchCourses;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const run = fetchRef.current;
    // Pas de fetch tant que le prérequis (programmes) n'est pas prêt (`enabled`) :
    // côté Dashboard, l'affichage « chargement » est maintenu via programsLoading.
    if (!run || programId < 0 || !enabled) return;
    setLoading(true);
    setLoadError(null);
    try {
      await run(programId);
    } catch {
      if (mountedRef.current) setLoadError('Impossible de charger les cours. Réessayez.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [programId, enabled]);

  // Chargement initial + à chaque changement de programme / passage à `enabled`.
  useEffect(() => {
    void reload();
  }, [reload]);

  return { loading, loadError, reload: () => void reload() };
}
