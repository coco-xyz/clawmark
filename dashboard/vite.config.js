import { execFileSync } from 'node:child_process';
import { defineConfig, loadEnv } from 'vite';

function readGitValue(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const basePath = env.VITE_BASE_PATH || '/clawmark-dashboard/';
  const pkg = JSON.parse(execFileSync('node', ['-p', "JSON.stringify(require('./package.json'))"], { encoding: 'utf8' }));
  const commit = readGitValue(['rev-parse', '--short=8', 'HEAD']);
  const buildTime = readGitValue(['show', '-s', '--format=%cI', 'HEAD']);

  return {
    base: basePath,
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version || ''),
      __APP_COMMIT__: JSON.stringify(commit),
      __APP_BUILD_TIME__: JSON.stringify(buildTime),
    },
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
