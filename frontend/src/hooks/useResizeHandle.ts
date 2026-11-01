import { useEffect, useRef, useState } from 'react';
import type React from 'react';

interface ResizeHandleOptions {
  /** Largeur demandée (px) ; null = largeur par défaut (jamais redimensionné). */
  width: number | null;
  onChange: (width: number | null) => void;
  min: number;
  max: number;
  /** Largeur annoncée et point de départ si la largeur rendue est illisible. */
  fallback: number;
  /** Largeur rendue du panneau, au début d'un glissement. */
  getRenderedWidth: () => number | undefined;
}

/**
 * Poignée de redimensionnement d'un panneau (bord droit, façon Discord) : glissement, flèches du
 * clavier (±16 px), double-clic pour revenir à la largeur par défaut. Les `handleProps` vont sur
 * l'élément `role="separator"` ; son `aria-label` reste à l'appelant.
 */
export function useResizeHandle({
  width,
  onChange,
  min,
  max,
  fallback,
  getRenderedWidth,
}: ResizeHandleOptions) {
  /** Glissement en cours ? */
  const [isResizing, setIsResizing] = useState(false);
  /** État du glissement : position et largeur de départ. */
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const clamp = (px: number) => Math.min(max, Math.max(min, px));

  // Pendant le glissement : curseur col-resize global + sélection de texte désactivée.
  useEffect(() => {
    if (!isResizing) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isResizing]);

  const handleProps = {
    role: 'separator',
    'aria-orientation': 'vertical',
    // Séparateur focusable = « splitter » : sa valeur (largeur en px) est requise par ARIA.
    'aria-valuenow': width ?? fallback,
    'aria-valuemin': min,
    'aria-valuemax': max,
    tabIndex: 0,
    onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
      event.preventDefault();
      resizeStart.current = { x: event.clientX, width: getRenderedWidth() ?? width ?? fallback };
      setIsResizing(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
      const start = resizeStart.current;
      if (!start) return;
      onChange(clamp(start.width + (event.clientX - start.x)));
    },
    onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
      if (!resizeStart.current) return;
      resizeStart.current = null;
      setIsResizing(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onDoubleClick() {
      onChange(null);
    },
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      // La largeur demandée d'abord : celle rendue peut être en pleine transition.
      const base = width ?? getRenderedWidth() ?? fallback;
      onChange(clamp(base + (event.key === 'ArrowLeft' ? -16 : 16)));
    },
  } as const;

  return { isResizing, handleProps };
}
