import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './CourseContextMenu.module.css';
import { Pencil } from '../../assets/Pencil.tsx';
import { Sparkles } from '../../assets/Sparkles.tsx';
import { LogOut } from '../../assets/LogOut.tsx';
import { defaultLabels } from './labels.ts';

interface CourseContextMenuProps {
  /** Position du clic droit (coordonnées viewport). */
  x: number;
  y: number;
  /** Code du cours ciblé (pour les libellés accessibles). */
  courseCode: string;
  /** Action « Modifier le cours » (absente → item masqué). */
  onEditCourse?: () => void;
  /** Action « Gestion MCP — Feedback du cours » (absente → item masqué). */
  onOpenMcp?: () => void;
  /** Action destructive « Quitter le cours » (absente → item + séparateur masqués). */
  onLeaveCourse?: () => void;
  /** Ferme le menu (clic extérieur, Échap, scroll, resize, après action). */
  onClose: () => void;
}

/**
 * Menu contextuel du sélecteur de cours (clic droit, réservé aux admins côté appelant).
 * Porté vers <body> en position fixe pour échapper à l'overflow de la sidebar ; recalé
 * dans le viewport après mesure. Se ferme au clic extérieur / Échap / scroll / resize.
 */
export function CourseContextMenu({
  x,
  y,
  courseCode,
  onEditCourse,
  onOpenMcp,
  onLeaveCourse,
  onClose,
}: CourseContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Recalage dans le viewport une fois la taille réelle connue (évite le débordement
  // à droite / en bas selon l'endroit du clic).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(gap, Math.min(x, window.innerWidth - width - gap));
    const top = Math.max(gap, Math.min(y, window.innerHeight - height - gap));
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={defaultLabels.contextMenuAria(courseCode)}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {onEditCourse && (
        <button type="button" role="menuitem" className={styles.item} onClick={onEditCourse}>
          <Pencil className={styles.icon} width="16" height="16" aria-hidden="true" />
          <span>{defaultLabels.contextEditCourse}</span>
        </button>
      )}
      {onOpenMcp && (
        <button
          type="button"
          role="menuitem"
          className={`${styles.item} ${styles.itemFeatured}`}
          onClick={onOpenMcp}
        >
          <Sparkles className={styles.icon} width="16" height="16" aria-hidden="true" />
          <span>{defaultLabels.contextMcpManagement}</span>
        </button>
      )}
      {onLeaveCourse && (
        <>
          {/* Séparateur seulement s'il y a des items au-dessus (pas pour un menu
              « quitter » seul, cas d'un utilisateur non-administrateur). */}
          {(onEditCourse || onOpenMcp) && <span className={styles.divider} role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`${styles.item} ${styles.itemDanger}`}
            onClick={onLeaveCourse}
          >
            <LogOut className={styles.icon} width="16" height="16" aria-hidden="true" />
            <span>{defaultLabels.contextLeaveCourse}</span>
          </button>
        </>
      )}
    </div>,
    document.body
  );
}
