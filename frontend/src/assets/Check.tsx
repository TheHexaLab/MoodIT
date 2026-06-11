import React from 'react';
import type { SVGProps } from 'react';

export function Check(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3.5 8.5L6.5 11.5L12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
