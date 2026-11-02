import { defineConfig } from 'tsdown';

// Everything is bundled (effect and @effect/platform-node are devDependencies): the published CLI
// installs with zero dependencies, since platform-node's `redis` peer would otherwise land on every
// user's machine.
export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  platform: 'node',
  // A bin-only package: no declarations (tsdown would otherwise infer them from `composite`).
  dts: false,
  sourcemap: false,
  minify: true,
  clean: true,
  outputOptions: {
    entryFileNames: '[name].js',
  },
});
