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

// The service runs under the host's Node (process.execPath + ELECTRON_RUN_AS_NODE):
// bundled ESM, node platform, no external module resolution at runtime.
await build({
  entryPoints: ['src/service.ts'],
  outfile: 'service/main.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
