import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Configuration des tests unitaires/intégration (Vitest). Séparée de vite.config.ts
// (qui porte le proxy du serveur de dev) pour ne pas mélanger dev et tests.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Couverture (#90) : `npm run test:coverage` → coverage/ (texte, HTML, lcov, résumé JSON pour la CI).
    // Mesurée sur tout src/ (fichiers non importés par un test compris), hors tests, types et mocks.
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/**/*.d.ts', 'src/mocks/**', 'src/main.tsx', 'src/pages/PopupTests.tsx'],
      reporter: ['text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
