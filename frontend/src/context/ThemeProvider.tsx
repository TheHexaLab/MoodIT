// Provider du thème clair/sombre. Reprend la logique de l'ancien hook `helpers/theme.ts`
// (seed depuis localStorage sinon préférence OS ; effet qui pose `data-theme` sur <html>
// et mémorise dans localStorage), mais en la centralisant dans un contexte partagé.
//
// localStorage (`moodit-theme`) reste le cache ANTI-FLASH : le script inline d'index.html
// le lit avant le premier rendu React. La BD (settings utilisateur) fait autorité et
// réaligne ce cache dès réception de /api/me (cf. CurrentUserProvider → setTheme).

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ThemeContext, type Theme, type ThemeApi } from './themeContext.ts';

const STORAGE_KEY = 'moodit-theme';

export default function ThemeProvider({ children }: { children: ReactNode }) {
  // État initial : choix sauvegardé (cache local), sinon préférence de l'OS.
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // À chaque changement : on pose data-theme sur <html> + on mémorise (cache anti-flash).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const value: ThemeApi = { theme, setTheme, toggleTheme };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
