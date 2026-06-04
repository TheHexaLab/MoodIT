import React from 'react';
import type { SVGProps } from 'react';

interface PencilProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Pencil(props: PencilProps): React.ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      min-width="16"
      min-height="16"
      viewBox="0 0 16 16"
      fill="none"
      {...props}
    >
      <path
        d="M10.5 2.5L13.5 5.5L6 13L3 13.5L3.5 10.5L10.5 2.5Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M9 4L12 7"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
