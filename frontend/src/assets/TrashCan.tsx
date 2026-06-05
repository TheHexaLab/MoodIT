import React from 'react';
import type { SVGProps } from 'react';

interface TrashCanProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function TrashCan(props: TrashCanProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M2.75 4.5H13.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 4.5V3.2C6 2.73333 6.23333 2.5 6.7 2.5H9.3C9.76667 2.5 10 2.73333 10 3.2V4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 4.5L4.6 12.8C4.66667 13.2667 4.93333 13.5 5.4 13.5H10.6C11.0667 13.5 11.3333 13.2667 11.4 12.8L12 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.5 7V11M9.5 7V11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
