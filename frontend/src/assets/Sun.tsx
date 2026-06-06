import React from 'react';
import type { SVGProps } from 'react';

interface SunProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Sun(props: SunProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5V2.8M8 13.2V14.5M14.5 8H13.2M2.8 8H1.5M12.6 3.4L11.7 4.3M4.3 11.7L3.4 12.6M12.6 12.6L11.7 11.7M4.3 4.3L3.4 3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
