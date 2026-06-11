import React from 'react';
import type { SVGProps } from 'react';

interface CameraProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Camera(props: CameraProps): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14" fill="none" {...props}>
      <path d="M1.75 4.66665C1.75 4.35723 1.87292 4.06048 2.09171 3.84169C2.3105 3.6229 2.60725 3.49998 2.91667 3.49998H4.08333L4.95833 2.33331H9.04167L11.0833 3.49998C11.3928 3.49998 11.6895 3.6229 11.9083 3.84169C12.1271 4.06048 12.25 4.35723 12.25 4.66665V9.91665C12.25 10.2261 12.1271 10.5228 11.9083 10.7416C11.6895 10.9604 11.3928 11.0833 11.0833 11.0833H2.91667C2.60725 11.0833 2.3105 10.9604 2.09171 10.7416C1.87292 10.5228 1.75 10.2261 1.75 9.91665V4.66665Z" stroke="currentColor" strokeWidth="1.16667" strokeLinejoin="round"/>
      <path d="M7 9.33331C7.9665 9.33331 8.75 8.54981 8.75 7.58331C8.75 6.61681 7.9665 5.83331 7 5.83331C6.0335 5.83331 5.25 6.61681 5.25 7.58331C5.25 8.54981 6.0335 9.33331 7 9.33331Z" stroke="currentColor" strokeWidth="1.16667"/>
    </svg>
  );
}
