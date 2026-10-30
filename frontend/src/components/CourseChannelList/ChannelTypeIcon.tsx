import React from 'react';
import type { SVGProps } from 'react';

/**
 * Icône de TYPE de canal (remplace les anciens glyphes en dur `#`, `⮡`, `○`) :
 * - `text`  → dièse (canal de discussion)
 * - `forum` → flèche coin bas-droit (fil / thread)
 * - `quiz`  → éclair (même tracé que l'en-tête de quiz)
 * - `announcement` → mégaphone (annonces du cours)
 *
 * SVG au trait via `currentColor`, auto-dimensionné (`1em` par défaut) : la couleur
 * et la taille suivent le texte parent, sans largeur codée en dur.
 */
export function ChannelTypeIcon({
  type,
  ...props
}: { type: string } & SVGProps<SVGSVGElement>): React.ReactElement {
  const common = {
    width: '1em',
    height: '1em',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...props,
  };

  switch (type) {
    case 'announcement':
      // Mégaphone (canal d'annonces du cours).
      return (
        <svg xmlns="http://www.w3.org/2000/svg" {...common}>
          <path d="M3 11v2a1 1 0 0 0 1 1h3l6 5V5L7 10H4a1 1 0 0 0-1 1z" />
          <path d="M17 8a5 5 0 0 1 0 8" />
        </svg>
      );
    case 'forum':
      // Flèche coin bas-droit, dessinée pour occuper la même hauteur (~18 unités)
      // que le dièse et l'éclair, à épaisseur de trait égale.
      return (
        <svg xmlns="http://www.w3.org/2000/svg" {...common}>
          <path d="M7 3v9a4 4 0 0 0 4 4h6" />
          <path d="M13 11l5 5-5 5" />
        </svg>
      );
    case 'quiz':
      return (
        <svg xmlns="http://www.w3.org/2000/svg" {...common}>
          {/* L'éclair est plus haut que le dièse : on le réduit (~0.9, centré) pour
              caler sa taille optique. `non-scaling-stroke` garde le trait à 2 (comme
              les autres icônes) malgré l'échelle. */}
          <path
            d="M13 2 3 14h9l-1 8 10-12h-9z"
            transform="translate(12 12) scale(0.9) translate(-12 -12)"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      );
    case 'text':
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" {...common}>
          <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
        </svg>
      );
  }
}
