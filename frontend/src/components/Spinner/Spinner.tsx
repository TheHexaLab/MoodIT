import React from 'react';
import styles from './Spinner.module.css';

interface SpinnerProps {
  /** Diamètre en px (défaut 32). */
  size?: number;
  /**
   * Tonalité :
   * - `brand` (défaut) : anneau `--border` + arc `--brand-teal`. Pour un spinner
   *   AUTONOME (page, liste, rail, icône).
   * - `current` : hérite de `currentColor`. Pour un spinner DANS un bouton plein
   *   (ex. blanc sur fond teal), où il doit prendre la couleur du texte.
   */
  tone?: 'brand' | 'current';
  /** Classe additionnelle (positionnement par le parent). */
  className?: string;
}

/**
 * Spinner inline purement visuel (`aria-hidden`) : l'état accessible (role="status",
 * aria-busy + texte) est porté par le conteneur appelant. Composant UNIQUE de
 * chargement de l'app (cf. `LoadingPage` pour le plein écran, qui partage le design).
 */
export function Spinner({ size = 32, tone = 'brand', className }: SpinnerProps): React.ReactElement {
  return (
    <span
      className={[styles.spinner, tone === 'current' ? styles.current : '', className]
        .filter(Boolean)
        .join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
