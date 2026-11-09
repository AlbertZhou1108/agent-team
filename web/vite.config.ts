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
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 覆盖率按需开启（npm run coverage:web）；npm test 不传 --coverage，所以不产出报告、不阻断。
    // 测试统一在 web/tests/，覆盖率只统计产品代码 web/src/。
    coverage: {
      provider: 'v8',
      reportsDirectory: '../coverage/web',
      reporter: ['text', 'text-summary', 'json-summary', 'html'],
      include: ['src/**/*.{ts,vue}'],
      exclude: ['src/**/*.d.ts'],
    },
  },
});
