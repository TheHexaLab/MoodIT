import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './QuizEditor.module.css';
import { Chevron } from '../../assets/Chevron';

export interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
}

/** Hauteur max estimée du menu (≈ 3 lignes + padding) pour décider du sens d'ouverture. */
const MENU_MAX_PX = 160;

/**
 * Liste déroulante personnalisée (même look que le sélecteur d'établissement de
 * `AddSubscriptionPopup`) : contrôle bordé + chevron animé, et menu flottant avec
 * surlignage de l'option active. Le menu est **porté dans `document.body`** en
 * position fixe (calculée sur le contrôle), pour ne jamais être rogné par le corps
 * défilant du popup ; il bascule vers le haut s'il manque de place en dessous.
 */
export function Dropdown({ value, options, onChange, ariaLabel }: DropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const controlRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>();

  const current = options.find((o) => o.value === value);

  // Position du menu (fixe) : sous le contrôle, ou au-dessus si la place manque.
  // Recalculée à l'ouverture, au défilement (capture, pour le corps du popup) et
  // au redimensionnement.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = controlRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 4;
      const spaceBelow = window.innerHeight - r.bottom;
      const openUp = spaceBelow < MENU_MAX_PX && r.top > spaceBelow;
      setMenuStyle({
        position: 'fixed',
        left: r.left,
        width: r.width,
        right: 'auto',
        zIndex: 2000,
        ...(openUp
          ? { bottom: window.innerHeight - r.top + gap, top: 'auto' }
          : { top: r.bottom + gap, bottom: 'auto' }),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Ferme au clic extérieur (contrôle ET menu porté exclus) ou sur Échap.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.dropdown} ref={wrapRef}>
      <button
        type="button"
        ref={controlRef}
        className={[styles.dropdownControl, open ? styles.dropdownOpen : ''].filter(Boolean).join(' ')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{current?.label ?? ''}</span>
        <Chevron
          className={[styles.dropdownChevron, open ? styles.dropdownChevronOpen : ''].filter(Boolean).join(' ')}
          width="1rem"
          height="1rem"
        />
      </button>
      {open &&
        createPortal(
          <ul className={styles.dropdownPicker} role="listbox" ref={menuRef} style={menuStyle}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <li key={option.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? styles.dropdownItemSelected : undefined}
                    onClick={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span>{option.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body
        )}
    </div>
  );
}
