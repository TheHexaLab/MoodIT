import React from 'react';
import type { SVGProps } from 'react';

export function X(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M12 4L4 12M4 4L12 12"
        stroke="currentColor"
        strokeWidth="1.6667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
