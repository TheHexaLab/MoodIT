import React from 'react';
import type { SVGProps } from 'react';

// Poignée de glissement (⠿) : deux colonnes de trois points.
export function GripVertical(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" {...props}>
      <circle cx="6" cy="3.5" r="1.25" />
      <circle cx="6" cy="8" r="1.25" />
      <circle cx="6" cy="12.5" r="1.25" />
      <circle cx="10" cy="3.5" r="1.25" />
      <circle cx="10" cy="8" r="1.25" />
      <circle cx="10" cy="12.5" r="1.25" />
    </svg>
  );
}
