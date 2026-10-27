import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['demo/.morrow-tools/demo-vault.test.ts'],
  },
});
