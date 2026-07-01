import React from 'react';
import type { SVGProps } from 'react';

// Icône « log-in » (porte à droite, flèche entrante) — pendant de LogOut, pour « rejoindre ».
export function LogIn(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M10 2.5H12C12.83 2.5 13.5 3.17 13.5 4V12C13.5 12.83 12.83 13.5 12 13.5H10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 11L9 8L6 5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 8H1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
