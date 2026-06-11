import React from 'react';
import type { SVGProps } from 'react';

interface EditProps extends SVGProps<SVGSVGElement> {
  color?: string;
}

export function Edit(props: EditProps): React.ReactElement {
  return (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 13 13" fill="none" {...props}>
    <path d="M6.5 10.8333H11.375" stroke="currentColor" strokeWidth="1.08333" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8.9375 1.89583C9.15299 1.68034 9.44525 1.55928 9.75 1.55928C9.9009 1.55928 10.0503 1.589 10.1897 1.64675C10.3291 1.70449 10.4558 1.78913 10.5625 1.89583C10.6692 2.00253 10.7538 2.1292 10.8116 2.26861C10.8693 2.40802 10.899 2.55743 10.899 2.70833C10.899 2.85922 10.8693 3.00864 10.8116 3.14805C10.7538 3.28746 10.6692 3.41413 10.5625 3.52083L3.79167 10.2917L1.625 10.8333L2.16667 8.66666L8.9375 1.89583Z" stroke="currentColor" strokeWidth="1.08333" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
  );
}
