import React, { useEffect, useRef, useState } from 'react';
import styles from './Dropdown.module.css';

const ChevronDown = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path
      d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export interface DropdownItem {
  key: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** Corbeille à côté de l'élément (types de séance de l'Horaire, par exemple). */
  onDelete?: () => void;
  deleteLabel?: string;
}

interface DropdownProps {
  id: string;
  /** Id du libellé du champ : avec le choix affiché, il forme le nom lu du bouton. */
  labelId: string;
  /** Le choix affiché dans le bouton. */
  display: string;
  /** Nom de la liste ouverte, pour les lecteurs d'écran. */
  menuLabel: string;
  items: DropdownItem[];
  /** Une ligne en bas de la liste (« Ajouter un type… ») ; elle reçoit de quoi la refermer. */
  footer?: (close: () => void) => React.ReactNode;
  /** Classe du conteneur (largeur, par exemple). */
  className?: string;
}

/**
 * Liste déroulante maison, celle de l'Horaire, à réutiliser à la place d'un `<select>` : un bouton
 * qui montre le choix, et une liste de boutons dessous. Choisir referme la liste et rend le focus au
 * bouton ; une corbeille la garde ouverte. Flèches pour passer d'un élément à l'autre, Échap pour
 * refermer (sans fermer la fenêtre qui la contient), clic ailleurs aussi.
 */
export function Dropdown({
  id,
  labelId,
  display,
  menuLabel,
  items,
  footer,
  className,
}: DropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const options = () => [
    ...(menuRef.current?.querySelectorAll<HTMLElement>('[data-kind-option]') ?? []),
  ];

  // Liste ouverte : le focus va à l'élément choisi ; un clic ailleurs la referme.
  useEffect(() => {
    if (!open) return;
    (options().find((el) => el.getAttribute('aria-pressed') === 'true') ?? options()[0])?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={rootRef} className={`${styles.picker} ${className ?? ''}`}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={styles.trigger}
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${id}-value`}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span id={`${id}-value`}>{display}</span>
        <ChevronDown />
      </button>
      {open && (
        <div
          ref={menuRef}
          className={styles.menu}
          role="group"
          aria-label={menuLabel}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const all = options();
              const index = all.indexOf(document.activeElement as HTMLElement);
              const step = event.key === 'ArrowDown' ? 1 : -1;
              all[(index + step + all.length) % all.length]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <div key={item.key} className={styles.row}>
              <button
                type="button"
                className={styles.option}
                data-kind-option
                aria-pressed={item.selected}
                onClick={() => {
                  item.onSelect();
                  close();
                }}
              >
                {item.label}
              </button>
              {item.onDelete && (
                <button
                  type="button"
                  className={styles.delete}
                  aria-label={item.deleteLabel}
                  onClick={() => {
                    item.onDelete?.();
                    // La liste reste ouverte ; le focus revient au premier élément.
                    window.requestAnimationFrame(() => options()[0]?.focus());
                  }}
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
          {footer?.(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Ligne d'action en bas d'une liste déroulante (« ＋ Ajouter un type… »), en bleu. */
export function DropdownAddButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button type="button" className={styles.add} data-kind-option onClick={onClick}>
      {children}
    </button>
  );
}
