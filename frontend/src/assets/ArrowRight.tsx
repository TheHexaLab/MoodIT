import React from 'react';
import type { SVGProps } from 'react';

export function ArrowRight(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3 8H13M13 8L9 4M13 8L9 12"
        stroke="currentColor"
        strokeWidth="1.6667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
