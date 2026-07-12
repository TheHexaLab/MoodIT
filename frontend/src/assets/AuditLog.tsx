import React from 'react';
import type { SVGProps } from 'react';

/** Feuille avec lignes (journal d'audit / journalisation). */
export function AuditLog(props: SVGProps<SVGSVGElement>): React.ReactElement {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" {...props}>
      <path
        d="M3.75 1.75h5.5L12.25 4.75v9.5H3.75V1.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9 1.75V5h3.25M5.75 8h4.5M5.75 10.75h4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
