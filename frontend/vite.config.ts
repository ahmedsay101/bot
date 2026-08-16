import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ command }) => {
  const isDev = command === 'serve';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: [
        'mockworlds.com',
        'www.mockworlds.com',
        'localhost',
      ],
      // Proxy is only active in dev; Nginx handles routing in production
      ...(isDev && {
        proxy: {
          '/api': {
            target: 'http://backend:5000',
            changeOrigin: true,
          },
          '/ws': {
            target: 'ws://backend:5000',
            ws: true,
            changeOrigin: true,
          },
        },
      }),
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            mui: ['@mui/material', '@mui/icons-material', '@emotion/react', '@emotion/styled'],
            charts: ['recharts'],
            query: ['@tanstack/react-query'],
          },
        },
      },
    },
  };
});
