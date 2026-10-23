import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const file = 'panel/main.js';
const artifact = await readFile(file, 'utf8');
if (!artifact.trim()) {
  throw new Error(`${file} is empty. Run npm run build first.`);
}

// `node --check` parses the file as a classic script. A top-level import or
// export statement fails there, which is exactly the host's requirement.
const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
if (check.status !== 0) {
  throw new Error(`${file} is not a classic script:\n${check.stderr || check.stdout}`);
}

if (/(^|[;}\n])\s*(import|export)\s/.test(artifact) || /(^|[^\w$])import\s*\(/.test(artifact)) {
  throw new Error(`${file} contains an import/export statement; the host cannot load ESM.`);
}

const head = artifact.slice(0, 80).replace(/\s+/g, ' ');
console.log(`${file}: ${artifact.length} bytes, classic IIFE. Head: ${head}…`);
