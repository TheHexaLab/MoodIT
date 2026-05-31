import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../', '');
  const gatewayHost: string = env.GATEWAY_HOST || 'localhost';
  const gatewayPort: string = env.GATEWAY_PORT || '8080';
  const backendUrl: string = `http://${gatewayHost}:${gatewayPort}`;

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/auth': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/gateway': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/ws': {
          target: backendUrl,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
