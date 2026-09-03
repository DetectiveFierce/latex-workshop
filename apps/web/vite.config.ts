import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/latex-workshop/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '^/latex-workshop/api/v1/projects/[^/]+/lsp$': {
        target: process.env.VITE_LSP_PROXY_TARGET ?? 'ws://localhost:3002',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/latex-workshop/, ''),
      },
      '^/api/v1/projects/[^/]+/lsp$': {
        target: process.env.VITE_LSP_PROXY_TARGET ?? 'ws://localhost:3002',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
      '^/latex-workshop/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/latex-workshop/, ''),
      },
    },
  },
  build: { sourcemap: true },
});
