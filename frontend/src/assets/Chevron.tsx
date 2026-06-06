import React from 'react';
import type { SVGProps } from 'react';

interface ChevronProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Chevron(props: ChevronProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path d="M4 10L8 6L12 10" stroke="currentColor" strokeWidth="1.6667" />
    </svg>
  );
}
