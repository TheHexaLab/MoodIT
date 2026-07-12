// Le thème est désormais géré par un contexte partagé (source de vérité unique, réalignée
// sur les settings BD). Ce fichier ne fait que ré-exporter le hook pour préserver les
// imports existants (`import { useTheme } from '../helpers/theme'`).
//
// Nouveau code : préférer `import { useTheme } from '../context/themeContext'`.

export { useTheme, type Theme, type ThemeApi } from '../context/themeContext.ts';
