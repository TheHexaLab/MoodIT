import React from 'react';
import type { SVGProps } from 'react';

interface MoonProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Moon(props: MoonProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
