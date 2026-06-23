//création de l'image pour le changement de couleur de la page de login
//date: 9 juin 2026
//Philip Pigeon
import React from 'react';
import type { SVGProps } from 'react';

interface LightanddarkProps extends SVGProps<SVGSVGElement> {
  isDark?: boolean;
}

export function Lightanddark({ isDark = false }: LightanddarkProps): React.ReactElement {
  if (isDark) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
      >
        <path
          d="M10 13.75C12.0711 13.75 13.75 12.0711 13.75 10C13.75 7.92893 12.0711 6.25 10 6.25C7.92893 6.25 6.25 7.92893 6.25 10C6.25 12.0711 7.92893 13.75 10 13.75Z"
          stroke="currentColor"
          strokeWidth="1.66667"
        />
        <path
          d="M9.99996 1.66667V4.16667M9.99996 15.8333V18.3333M1.66663 10H4.16663M15.8333 10H18.3333M3.99996 4L5.74996 5.75M14.25 14.25L16 16M3.99996 16L5.74996 14.25M14.25 5.75L16 4"
          stroke="currentColor"
          strokeWidth="1.66667"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <path
        d="M17.5 10.6667C17.2829 11.9483 16.7173 13.1455 15.8652 14.1272C15.0131 15.1088 13.9073 15.8371 12.6689 16.2321C11.4305 16.6272 10.1073 16.6739 8.84411 16.3671C7.58094 16.0602 6.42657 15.4117 5.5074 14.4926C4.58823 13.5734 3.93973 12.419 3.6329 11.1559C3.32606 9.89269 3.37274 8.56945 3.76782 7.33104C4.1629 6.09264 4.89114 4.98683 5.87279 4.13472C6.85444 3.28261 8.05164 2.71706 9.33329 2.5C8.25032 3.58297 7.64192 5.05179 7.64192 6.58333C7.64192 8.11488 8.25032 9.5837 9.33329 10.6667C10.4163 11.7496 11.8851 12.358 13.4166 12.358C14.9482 12.358 16.417 11.7496 17.5 10.6667Z"
        stroke="currentColor"
        strokeWidth="1.66667"
        strokeLinejoin="round"
      />
    </svg>
  );
}
