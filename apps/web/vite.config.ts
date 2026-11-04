import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/latex-workshop/',
  plugins: [
    react(),
    {
      name: 'mind-palace-ui',
      configureServer(server) {
        const workspaceUi = fileURLToPath(new URL('../../../design-system', import.meta.url));
        const uiRoot = existsSync(workspaceUi)
          ? workspaceUi
          : fileURLToPath(new URL('../../tests/fixtures/ui', import.meta.url));
        server.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith('/ui/v1/')) return next();
          let pathname: string;
          try {
            pathname = decodeURIComponent(req.url.split('?')[0]!.slice(7));
          } catch {
            res.statusCode = 400;
            res.end();
            return;
          }
          const file = resolve(uiRoot, pathname);
          if (!file.startsWith(uiRoot + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const ext = file.split('.').pop();
          res.setHeader(
            'Content-Type',
            ext === 'css'
              ? 'text/css'
              : ext === 'woff2'
                ? 'font/woff2'
                : ext === 'svg'
                  ? 'image/svg+xml'
                  : ext === 'png'
                    ? 'image/png'
                    : 'application/octet-stream',
          );
          res.setHeader('Cache-Control', 'no-cache');
          createReadStream(file).pipe(res);
        });
      },
    },
  ],
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
