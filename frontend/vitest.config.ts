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
  },
});
