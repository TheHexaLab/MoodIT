import React from 'react';
import type { SVGProps } from 'react';

interface PlayProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

/** Triangle « lecture » contour (bouton d'exécution). */
export function Play(props: PlayProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M4 2.5L13 8L4 13.5V2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
