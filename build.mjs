import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;

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

// Single source of truth for the version: package.json. Keep the cache-buster
// in panel/index.html in sync so the PWA/relay never serves a stale bundle.
const indexPath = 'panel/index.html';
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/main\.js\?v=[0-9A-Za-z._-]+/, `main.js?v=${version}`);
writeFileSync(indexPath, html);

// Keep the README version badge in sync too.
const readmePath = 'README.md';
let readme = readFileSync(readmePath, 'utf8');
readme = readme.replace(/version-[0-9A-Za-z._-]+/, `version-${version}`);
writeFileSync(readmePath, readme);

console.log(`Version ${version} injected into panel/index.html and README.md.`);