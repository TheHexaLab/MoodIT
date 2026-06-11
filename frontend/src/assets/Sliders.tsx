import React from 'react';
import type { SVGProps } from 'react';

/** Deux glissières horizontales avec leurs poignées (gestion des rôles). */
export function Sliders(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M2.25 5.5H13.75M2.25 10.5H13.75"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="5.5" cy="5.5" r="1.9" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="1.9" fill="currentColor" />
    </svg>
  );
}
