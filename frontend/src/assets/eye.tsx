//création de l'oeuil de la page de login
//date: 7 juin 2026
//Philip Pigeonimport React from 'react';
import type { SVGProps } from 'react';

interface EyeIconProps extends SVGProps<SVGSVGElement> {
  visible?: boolean;
}

export function EyeIcon({ visible = true, ...props }: EyeIconProps): React.ReactElement {
  if (visible) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M0.833496 9.99998C0.833496 9.99998 4.16683 3.33331 10.0002 3.33331C15.8335 3.33331 19.1668 9.99998 19.1668 9.99998C19.1668 9.99998 15.8335 16.6666 10.0002 16.6666C4.16683 16.6666 0.833496 9.99998 0.833496 9.99998Z"
          stroke="#A6A6BC"
          strokeWidth="1.66667"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10 12.5C11.3807 12.5 12.5 11.3807 12.5 10C12.5 8.61929 11.3807 7.5 10 7.5C8.61929 7.5 7.5 8.61929 7.5 10C7.5 11.3807 8.61929 12.5 10 12.5Z"
          stroke="#A6A6BC"
          strokeWidth="1.66667"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.33301 3.33331L16.6663 16.6666"
          stroke="#A6A6BC"
          strokeWidth="1.66667"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      {...props}
    >
      <path
        d="M0.833374 10C0.833374 10 4.16671 3.33334 10 3.33334C15.8334 3.33334 19.1667 10 19.1667 10C19.1667 10 15.8334 16.6667 10 16.6667C4.16671 16.6667 0.833374 10 0.833374 10Z"
        stroke="#9999AD"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 12.5C11.3807 12.5 12.5 11.3807 12.5 10C12.5 8.61929 11.3807 7.5 10 7.5C8.61929 7.5 7.5 8.61929 7.5 10C7.5 11.3807 8.61929 12.5 10 12.5Z"
        stroke="#9999AD"
        strokeWidth="1.66667"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
