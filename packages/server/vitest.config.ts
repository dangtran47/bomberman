import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default 'forks' pool trips over stray messages on the child-process
    // IPC channel while the Colyseus server is running; threads are clean.
    pool: 'threads',
  },
});
