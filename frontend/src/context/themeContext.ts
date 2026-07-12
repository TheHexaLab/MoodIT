// Contexte « thème » : source de vérité UNIQUE du mode clair/sombre pour toute l'app.
//
// Auparavant `helpers/theme.ts` était un hook autonome : chaque consommateur détenait
// SON état local (plusieurs `useState` indépendants synchronisés seulement via
// localStorage). Pour pouvoir réaligner le thème sur la BD (settings utilisateur) depuis
// un seul endroit, on centralise l'état dans un contexte fourni haut dans l'arbre
// (cf. ThemeProvider, monté dans main.tsx).
//
// Ce fichier ne contient AUCUN composant (contexte + hook + types uniquement) : le
// provider vit dans ThemeProvider.tsx. Séparation identique à currentUserContext.ts →
// garde le Fast Refresh fonctionnel.

import { createContext, useContext } from 'react';

export type Theme = 'light' | 'dark';

export interface ThemeApi {
  /** Thème courant appliqué (`data-theme` sur <html>). */
  theme: Theme;
  /** Force un thème précis (utilisé pour réaligner sur les settings BD au chargement). */
  setTheme: (theme: Theme) => void;
  /** Bascule clair ↔ sombre. */
  toggleTheme: () => void;
}

export const ThemeContext = createContext<ThemeApi | null>(null);

/** Accès au thème partagé. À utiliser sous <ThemeProvider>. */
export function useTheme(): ThemeApi {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme doit être utilisé dans <ThemeProvider>');
  }
  return ctx;
}
