import { defineConfig, type UserConfig } from 'tsdown';

const shared: UserConfig = {
  format: ['esm'],
  platform: 'node',
  // A bin-only package: no declarations (tsdown would otherwise infer them from `composite`).
  dts: false,
  sourcemap: false,
  minify: true,
  clean: true,
};

// Everything is bundled (effect and @effect/platform-node are devDependencies): the published CLI
// installs with zero dependencies, since platform-node's `redis` peer would otherwise land on every
// user's machine.
export default defineConfig([
  {
    ...shared,
    entry: { bin: 'src/bin.ts' },
    outputOptions: { entryFileNames: '[name].js' },
  },
  // What the action runs. GitHub runs it from a checkout with no install, on the runner's Node.
  {
    ...shared,
    entry: { action: 'src/action.ts' },
    outDir: '../../upload/dist',
    target: 'node24',
    outputOptions: { entryFileNames: '[name].mjs' },
  },
]);
