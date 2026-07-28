import { useRef, type MouseEvent } from 'react';

/**
 * Fermeture au clic de fond d'un overlay, SANS fermer sur une sélection de texte
 * démarrée DANS le popup et relâchée sur le fond. Sans ça, une sélection (drag) dans
 * un champ de saisie qui se termine hors du popup déclenche un « click » sur l'overlay
 * (ancêtre commun) et fermait le popup par erreur.
 *
 * On ne ferme que si le geste a COMMENCÉ ET s'est TERMINÉ sur le fond lui-même.
 * Renvoie des props à étaler sur l'élément overlay : `<div {...useBackdropClose(close)} />`.
 */
export function useBackdropClose(onBackdrop: () => void) {
  const downOnBackdrop = useRef(false);
  return {
    onMouseDown(event: MouseEvent) {
      downOnBackdrop.current = event.target === event.currentTarget;
    },
    onClick(event: MouseEvent) {
      if (event.target === event.currentTarget && downOnBackdrop.current) onBackdrop();
      downOnBackdrop.current = false;
    },
  };
}
