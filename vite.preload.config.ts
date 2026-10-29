import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true,
    outDir: 'dist-electron',
    emptyOutDir: false,
    target: 'node22',
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: 'electron/preload.cts',
      external: ['electron'],
      output: {
        format: 'cjs',
        entryFileNames: 'preload.cjs',
        inlineDynamicImports: true,
      },
    },
  },
});
