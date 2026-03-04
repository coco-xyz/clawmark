import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const basePath = env.VITE_BASE_PATH || '/clawmark-dashboard/';

  return {
    base: basePath,
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
  };
});
