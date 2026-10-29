// Vue courante du Dashboard (programme → cours → canal) portée par l'URL (#63) :
//   /home                                      aucun programme
//   /home/p/:programId                         programme (son premier cours s'affiche)
//   /home/p/:programId/c/:courseId             cours
//   /home/p/:programId/c/:courseId/:type/:id   canal du cours (type : text, quiz, forum)
// Le bouton « back » du navigateur navigue ainsi entre les vues, au lieu de quitter l'app, et
// une vue se partage par son lien. Les choix de l'utilisateur AJOUTENT une entrée à l'historique ;
// les replis automatiques (programme quitté, cours supprimé, restauration) la REMPLACENT.

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ChannelRef } from '../../components/CourseChannelList/CourseChannelList.tsx';

export interface ViewLocation {
  /** -1 : aucun programme sélectionné. */
  programId: number;
  courseId?: number;
  channel?: ChannelRef;
}

export const NO_VIEW: ViewLocation = { programId: -1 };

const VIEW_PATH = /\/p\/(\d+)(?:\/c\/(\d+)(?:\/([a-z]+)\/(\d+))?)?\/?$/;

/** Vue décrite par un chemin ; {@link NO_VIEW} si le chemin n'en décrit aucune (ex. /home). */
export function parseViewPath(pathname: string): ViewLocation {
  const m = VIEW_PATH.exec(pathname);
  if (!m) return NO_VIEW;
  const view: ViewLocation = { programId: Number(m[1]) };
  if (m[2] != null) view.courseId = Number(m[2]);
  if (m[3] != null && m[4] != null) view.channel = { type: m[3], id: Number(m[4]) };
  return view;
}

/** Chemin d'une vue. Un canal sans cours, ou un cours sans programme, n'est pas représentable. */
export function viewPath(view: ViewLocation): string {
  if (view.programId < 0) return '/home';
  let path = `/home/p/${view.programId}`;
  if (view.courseId == null) return path;
  path += `/c/${view.courseId}`;
  if (view.channel) path += `/${view.channel.type}/${view.channel.id}`;
  return path;
}

export type ViewUpdate = ViewLocation | ((previous: ViewLocation) => ViewLocation);

/**
 * Vue lue dans l'URL, et son setter. Le setter part de la DERNIÈRE vue demandée, même si
 * l'URL n'est pas encore rendue : deux mises à jour dans le même tick se composent. Une vue
 * identique à l'actuelle n'ajoute rien à l'historique.
 *
 * Le setter est STABLE (même fonction pour toute la vie du composant). `navigate` de React Router,
 * lui, change à chaque navigation (hors routeur de données, il dépend du chemin courant) : un
 * setter qui en dépendait changeait à chaque clic, et chaque effet qui le liste se rejouait. Celui
 * de l'abonnement WebSocket à la room de l'utilisateur se désabonnait et se réabonnait alors à
 * chaque changement de vue, avec un trou où un évènement pouvait être manqué.
 */
export function useViewLocation(): [
  ViewLocation,
  (update: ViewUpdate, options?: { replace?: boolean }) => void,
] {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const view = useMemo(() => parseViewPath(pathname), [pathname]);
  const latestRef = useRef(view);
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    latestRef.current = view;
    navigateRef.current = navigate;
  }, [view, navigate]);

  const setView = useCallback((update: ViewUpdate, options?: { replace?: boolean }) => {
    const next = typeof update === 'function' ? update(latestRef.current) : update;
    const path = viewPath(next);
    if (path === viewPath(latestRef.current)) return;
    latestRef.current = parseViewPath(path);
    navigateRef.current(path, { replace: options?.replace ?? false });
  }, []);

  return [view, setView];
}
