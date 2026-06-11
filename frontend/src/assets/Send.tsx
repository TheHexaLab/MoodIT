import React from 'react';
import type { SVGProps } from 'react';

interface SendProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Send(props: SendProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M14.6667 1.33337L7.33337 8.66671"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14.6667 1.33337L10 14.6667L7.33337 8.66671L1.33337 6.00004L14.6667 1.33337Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}