import React from 'react';
import type { SVGProps } from 'react';

export function Copy(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <rect
        x="6"
        y="6"
        width="7.5"
        height="7.5"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M10 6V4C10 3.17 9.33 2.5 8.5 2.5H4C3.17 2.5 2.5 3.17 2.5 4V8.5C2.5 9.33 3.17 10 4 10H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
