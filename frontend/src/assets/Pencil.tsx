import React from 'react';
import type { SVGProps } from 'react';

interface PencilProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Pencil(props: PencilProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M10.5 2.5L13.5 5.5L6 13L3 13.5L3.5 10.5L10.5 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 4L12 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
