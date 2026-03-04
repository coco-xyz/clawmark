import { defineConfig } from 'vite';

export default defineConfig({
  base: '/clawmark-dashboard/',
  server: {
    port: 3465,
    proxy: {
      '/clawmark': {
        target: 'http://localhost:3462',
        rewrite: (path) => path.replace(/^\/clawmark/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
