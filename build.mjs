import { build } from 'esbuild';

// The OpenChamber host serves `panel/main.js` as a classic script inside a
// sandboxed iframe: no ESM, no runtime compilation. An IIFE bundle is the only
// accepted shape.
await build({
  entryPoints: ['src/panel.ts'],
  outfile: 'panel/main.js',
  bundle: true,
  format: 'iife',
  globalName: undefined,
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
