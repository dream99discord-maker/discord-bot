import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(webRoot, '..');
const projectRootGlob = projectRoot.replaceAll('\\', '/');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    root: webRoot,
    plugins: [react()],
    server: {
      host: env['VITE_HOST'] || '127.0.0.1',
      port: 5173,
      strictPort: true,
      fs: {
        strict: true,
        allow: [webRoot, resolve(projectRoot, 'node_modules')],
        deny: [
          '.env', '.env.*',
          ...['data', 'backup', 'backups', 'migrations', 'src', 'test', 'scripts', 'docs'].map((directory) => `${projectRootGlob}/${directory}/**`),
          `${projectRootGlob}/**/*.sqlite*`, `${projectRootGlob}/**/*.db`, `${projectRootGlob}/**/*.bak`,
        ],
      },
      proxy: {
        '/api': { target: `http://127.0.0.1:${env['PORT'] || '3000'}`, changeOrigin: false },
        '/health': { target: `http://127.0.0.1:${env['PORT'] || '3000'}`, changeOrigin: false },
        '/docs': { target: `http://127.0.0.1:${env['PORT'] || '3000'}`, changeOrigin: false },
      },
    },
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  };
});
