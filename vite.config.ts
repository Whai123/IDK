import { defineConfig } from 'vite';

const apiOrigin = `http://127.0.0.1:${process.env.STARTUP_PORT || '4174'}`;

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, req) => {
            const origin = req.headers.origin;
            if (!origin) return;
            try {
              if (new URL(origin).host === req.headers.host) proxyReq.setHeader('origin', apiOrigin);
            } catch {
              // The API rejects malformed and cross-origin requests.
            }
          });
        },
      },
    },
  },
});
