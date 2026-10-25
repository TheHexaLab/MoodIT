import { useLayoutEffect, useState, type ReactNode, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';

/**
 * Monte ses enfants dans un hôte ajouté à `document.body` : la popup passe au-dessus de tout et
 * reste centrée même si son parent React est transformé (tiroir mobile) ou défilant.
 * `useLayoutEffect` : l'hôte est attaché AVANT le paint et avant les mesures des enfants.
 */
export function Portal({ children }: { children: ReactNode }): ReactPortal | null {
  const [host] = useState(() =>
    typeof document !== 'undefined' ? document.createElement('div') : null
  );
  useLayoutEffect(() => {
    if (!host) return;
    document.body.appendChild(host);
    return () => {
      document.body.removeChild(host);
    };
  }, [host]);
  return host ? createPortal(children, host) : null;
}
