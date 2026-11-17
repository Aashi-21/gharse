import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Production build goes into server/public so Fastify serves the SPA (one deployable).
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': 'http://localhost:3000' } },
});
