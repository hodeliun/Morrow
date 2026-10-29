// the desktop shell main process and its lazy chunks; the sandboxed preload is built separately as one file
// so the packaged app carries no node_modules folder and the preload never requires a relative chunk
import { defineConfig } from 'vite';
import { thirdPartyLicenses } from './scripts/licenses.ts';

export default defineConfig({
  publicDir: false,
  plugins: [thirdPartyLicenses()],
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: true,
    outDir: 'dist-electron',
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: { main: 'electron/main.cts' },
      external: ['electron'],
      // parts of the assistant's sdk that load only when used stay in files of their own
      output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' },
    },
  },
});
