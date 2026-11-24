import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    outDir: resolve(repositoryRoot, 'dist/polaris-arquivos'),
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(repositoryRoot, 'plugins/polaris-arquivos/src/main.ts'),
      formats: ['es'],
      fileName: 'main',
    },
    rollupOptions: {
      output: { codeSplitting: false },
    },
  },
});
