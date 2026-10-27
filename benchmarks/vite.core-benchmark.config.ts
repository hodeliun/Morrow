import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/core/database.ts',
      formats: ['es'],
      fileName: 'database',
    },
    outDir: 'node_modules/.cache/issue-6-core-benchmark',
    emptyOutDir: true,
  },
});
