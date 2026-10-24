import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Popup.module.css';
import { Portal } from './Portal';
import { PopupVariant } from './popupVariant';
import type { CloseAction, PopupController } from './popupController';

export interface PopupProps {
  /** Conteneur : largeur, hauteur maximale, défilement, rang d'empilement. */
  variant: PopupVariant;
  /** Nom accessible du dialogue (son titre, tel qu'affiché dans l'en-tête). */
  label: string;
  /** Fermeture par défaut : Échap, clic sur le voile, et `requestClose()` sans action. */
  onClose: CloseAction;
  /** Poignée pour fermer avec animation depuis le contenu (`usePopupController`). */
  controller?: PopupController;
  /**
   * Classe posée sur le voile. Les feuilles des popups ciblent leur contenu par
   * `div.<classe> > div > …` : le panneau est le `div` enfant direct du voile.
   */
  className?: string;
  /** Classe et style du panneau (ex. largeur animée de l'éditeur de quiz). */
  panelClassName?: string;
  panelStyle?: React.CSSProperties;
  /** Échap ferme la popup (défaut : oui). */
  closeOnEscape?: boolean;
  /** Un clic qui commence ET finit sur le voile ferme la popup (défaut : oui). */
  closeOnBackdrop?: boolean;
  /**
   * `'visible'` : le panneau ne défile pas et laisse déborder son contenu flottant (liste de
   * recherche ancrée sous un champ). Par défaut, la variante décide (les formulaires défilent).
   */
  overflow?: 'visible';
  children: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  '[contenteditable="true"]';

/** Éléments atteignables par Tab dans `root` (jsdom n'a pas de géométrie : on garde tout). */
function tabbables(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden], [aria-hidden="true"]')
  );
  const visible = all.filter((el) => el.getClientRects().length > 0);
  return visible.length > 0 ? visible : all;
}

/** Délai de secours si `animationend` n'arrive pas (animation neutralisée par une feuille). */
const CLOSE_FALLBACK_MS = 400;

/**
 * Popup centralisée : voile + panneau selon la `variant`, portée dans `document.body`, avec la
 * sémantique de dialogue modal (rôle, nom, `aria-modal`), le focus déplacé dedans à l'ouverture
 * et rendu au déclencheur à la fermeture, Tab et Maj+Tab confinés, Échap et clic sur le voile qui
 * ferment, et l'animation de sortie avant d'exécuter l'action de fermeture (immédiate si
 * `prefers-reduced-motion`). Le contenu (en-tête, champs, boutons) est fourni par les enfants.
 */
export function Popup({
  variant,
  label,
  onClose,
  controller,
  className,
  panelClassName,
  panelStyle,
  closeOnEscape = true,
  closeOnBackdrop = true,
  overflow,
  children,
}: PopupProps): React.ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const pending = useRef<CloseAction | null>(null);
  const fallbackTimer = useRef<number | null>(null);
  // Le clic de fond ne ferme que si le geste a COMMENCÉ sur le fond : une sélection de texte
  // démarrée dans le panneau et relâchée dehors déclenche sinon un « click » sur le voile.
  const backdropMouseDown = useRef(false);
  // Élément qui avait le focus avant l'ouverture (lu au premier rendu, avant tout `autoFocus`).
  const [opener] = useState(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  );

  // `onClose` peut changer à chaque rendu du parent : on garde la dernière valeur hors du rendu.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const finishClose = useCallback(() => {
    if (fallbackTimer.current != null) {
      window.clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
    const action = pending.current;
    pending.current = null;
    action?.();
  }, []);

  const requestClose = useCallback(
    (action?: CloseAction) => {
      const run = action ?? onCloseRef.current;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        run();
        return;
      }
      if (pending.current) return; // fermeture déjà en cours
      pending.current = run;
      setIsClosing(true);
      fallbackTimer.current = window.setTimeout(finishClose, CLOSE_FALLBACK_MS);
    },
    [finishClose]
  );

  useEffect(() => {
    controller?.bind(requestClose);
    return () => controller?.bind(null);
  }, [controller, requestClose]);

  // Focus initial : `[data-autofocus]`, sinon le premier champ, sinon le premier élément
  // focalisable, sinon le panneau. Un focus déjà posé dans le panneau (ex. par un effet enfant)
  // est respecté. Attention : l'attribut `autoFocus` d'un enfant est SANS effet à l'ouverture
  // (le portail attache son hôte au document après le montage des enfants) : utiliser
  // `data-autofocus` pour choisir l'élément focalisé.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (panel.contains(document.activeElement) && document.activeElement !== panel) return;
    const explicit = panel.querySelector<HTMLElement>('[data-autofocus]');
    const candidates = tabbables(panel);
    const field = candidates.find((el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    (explicit ?? field ?? candidates[0] ?? panel).focus({ preventScroll: true });
  }, []);

  // Fermeture : le focus revient à l'élément qui a ouvert la popup, s'il est toujours affiché.
  useEffect(() => {
    const timer = fallbackTimer;
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        opener.focus({ preventScroll: true });
      }
    };
  }, [opener]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      if (!closeOnEscape) return;
      event.preventDefault();
      event.stopPropagation(); // une popup imbriquée ne ferme pas sa parente
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = tabbables(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inside = active ? panel.contains(active) && active !== panel : false;
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      event.preventDefault();
      first.focus();
    }
    event.stopPropagation();
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) finishClose();
  }

  const overlayClass = [styles.overlay, className, isClosing ? styles.closing : null]
    .filter(Boolean)
    .join(' ');
  const panelClass = [styles.panel, panelClassName].filter(Boolean).join(' ');

  return (
    <Portal>
      <div
        className={overlayClass}
        data-variant={variant}
        onMouseDown={(event) => {
          backdropMouseDown.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          if (closeOnBackdrop && event.target === event.currentTarget && backdropMouseDown.current) {
            requestClose();
          }
          backdropMouseDown.current = false;
        }}
        onKeyDown={handleKeyDown}
      >
        <div
          ref={panelRef}
          className={panelClass}
          style={panelStyle}
          data-overflow={overflow}
          role={variant === PopupVariant.Alert ? 'alertdialog' : 'dialog'}
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          onAnimationEnd={handleAnimationEnd}
        >
          {children}
        </div>
      </div>
    </Portal>
  );
}
