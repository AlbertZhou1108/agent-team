import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const apiPort = process.env.AGENT_TEAM_API_PORT ?? '62048';
const apiOrigin = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            // Preserve same-origin validation across the local development proxy.
            // Cross-origin input is never rewritten into a trusted origin.
            if (request.headers.origin === `http://${request.headers.host}`) {
              proxyRequest.setHeader('Origin', apiOrigin);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // 禁止将字体/SVG 等静态资源内联为 data: URI，避免被 src/server.mjs 的严格 CSP (default-src 'self') 拦截
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
