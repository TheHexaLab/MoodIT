import React from 'react';
import type { SVGProps } from 'react';

interface MagnifyingGlassProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function MagnifyingGlass(props: MagnifyingGlassProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <circle
        cx="7"
        cy="7"
        r="4.25"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M10.25 10.25L13.5 13.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
