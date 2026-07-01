import React from 'react';
import type { SVGProps } from 'react';

// Icône « cercle + ! » (point à améliorer), 16×16, couleur via currentColor.
export function AlertCircle(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75V8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M8 11.1H8.007" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
