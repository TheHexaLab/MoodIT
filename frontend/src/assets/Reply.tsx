import React from 'react';
import type { SVGProps } from 'react';

interface ReplyProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Reply(props: ReplyProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M6.5 4L3 7.5L6.5 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 7.5H9.5C11.4 7.5 13 9.1 13 11V12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
