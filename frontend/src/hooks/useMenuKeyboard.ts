import type React from 'react';
import { useEffect, type RefObject } from 'react';

/** Sélecteur des éléments d'un menu WAI-ARIA (menuitem, case à cocher, bouton radio). */
export const MENU_ITEM_SELECTOR =
  '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

/** Sélecteur des options d'une liste (listbox WAI-ARIA). */
export const OPTION_SELECTOR = '[role="option"]';

/**
 * Où placer le focus à l'ouverture :
 * - `first` : premier élément (patron « Menu Button ») ;
 * - `selected` : option `aria-selected="true"`, sinon la première (patron « Listbox ») ;
 * - `container` : le conteneur lui-même (il doit porter `tabIndex={-1}`) ; la première flèche
 *   mène alors au premier (↓) ou au dernier (↑) élément ;
 * - `none` : ne déplace pas le focus (ex. champ de recherche déjà en `autoFocus`).
 */
export type MenuInitialFocus = 'first' | 'selected' | 'container' | 'none';

interface MenuKeyboardOptions {
  /** Menu ouvert ? Le focus initial est posé à chaque passage à `true`. */
  open: boolean;
  /** Conteneur du menu (souvent porté dans `document.body`). */
  containerRef: RefObject<HTMLElement | null>;
  /** Éléments parcourus aux flèches (défaut : éléments de menu). */
  itemSelector?: string;
  initialFocus?: MenuInitialFocus;
  /** Ferme le menu sur Échap ; absent → Échap n'est pas traité ici. */
  onEscape?: () => void;
  /** Élément qui reprend le focus après Échap (le déclencheur du menu). */
  returnFocus?: () => HTMLElement | null | undefined;
}

/** Éléments navigables du conteneur, dans l'ordre du document (désactivés exclus). */
function itemsOf(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true'
  );
}

/**
 * Navigation au clavier d'un menu ou d'une liste (patrons WAI-ARIA « Menu Button » et
 * « Listbox ») : focus posé à l'ouverture, ↓/↑ (circulaires), Début/Fin, Échap qui ferme et
 * rend le focus au déclencheur. Entrée et Espace restent le clic natif des boutons.
 * Tab garde son comportement natif (les éléments sont des boutons atteignables).
 *
 * Renvoie le gestionnaire `onKeyDown` à poser sur le conteneur. Échap y est arrêté
 * (`stopPropagation`) pour ne pas fermer aussi la popup ou le tiroir parent.
 */
export function useMenuKeyboard({
  open,
  containerRef,
  itemSelector = MENU_ITEM_SELECTOR,
  initialFocus = 'first',
  onEscape,
  returnFocus,
}: MenuKeyboardOptions): (event: React.KeyboardEvent) => void {
  useEffect(() => {
    if (!open || initialFocus === 'none') return;
    const container = containerRef.current;
    if (!container) return;
    if (initialFocus === 'container') {
      container.focus();
      return;
    }
    const items = itemsOf(container, itemSelector);
    const target =
      (initialFocus === 'selected' &&
        items.find((el) => el.getAttribute('aria-selected') === 'true')) ||
      items[0];
    target?.focus();
    // Le focus initial ne dépend que de l'ouverture (pas des re-rendus du menu ouvert).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (event: React.KeyboardEvent) => {
    const container = containerRef.current;
    if (!container) return;
    if (event.key === 'Escape') {
      if (!onEscape) return;
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      returnFocus?.()?.focus();
      return;
    }
    // Dans un champ texte, Début/Fin déplacent le curseur : on ne les détourne pas.
    const target = event.target as HTMLElement;
    const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
    if ((event.key === 'Home' || event.key === 'End') && inField) return;

    const items = itemsOf(container, itemSelector);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next].focus();
  };
}

/**
 * Touche d'ouverture d'un menu contextuel au clavier : la touche Menu ou Maj+F10. Seul
 * Chromium les convertit en évènement `contextmenu` ; on les traite donc nous-mêmes au
 * `keydown` pour que le menu s'ouvre sur tous les moteurs.
 */
export function isContextMenuKey(event: React.KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}
