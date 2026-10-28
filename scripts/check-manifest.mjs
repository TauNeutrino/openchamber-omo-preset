import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isGuestFilesystemPattern } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

const text = await readFile('package.json', 'utf8');
const result = parseManifestJson(text);
if (!result.ok) {
  throw new Error(`package.json manifest is invalid: ${result.code} ${result.error}`);
}

const manifest = result.manifest;
if (manifest.apiVersion !== 1) {
  throw new Error(`Unexpected apiVersion ${String(manifest.apiVersion)}; the SDK documents 1.`);
}
if (!result.version) {
  throw new Error('package.json needs the semver version the catalog shows.');
}

const panel = manifest.contributes.panel;
if (!panel || panel.id !== 'omo-preset') {
  throw new Error('The panel contribution is missing or has the wrong id.');
}

const entries = new Set([panel.entry]);
const section = manifest.contributes.statusSection;
if (section && typeof section === 'object') {
  entries.add(section.entry);
}
for (const entry of entries) {
  const info = await stat(entry);
  if (!info.isFile()) throw new Error(`Entry ${entry} is not a file.`);
}

const scripts = await readFile(panel.entry, 'utf8');
const scriptSources = [...scripts.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
if (scriptSources.length === 0) {
  throw new Error('The panel HTML references no script.');
}
for (const source of scriptSources) {
  if (source.includes('..') || source.startsWith('/')) {
    throw new Error(`Script ${source} must stay inside the package.`);
  }
  const scriptPath = resolve(dirname(panel.entry), source);
  const info = await stat(scriptPath);
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Built script ${scriptPath} is missing or empty. Run npm run build.`);
  }
}

const filesystem = manifest.contributes.filesystem ?? [];
if (filesystem.length === 0) {
  throw new Error('The manifest declares no filesystem patterns; the global config is unreachable.');
}
for (const pattern of filesystem) {
  if (!isGuestFilesystemPattern(pattern)) {
    throw new Error(`Invalid filesystem pattern: ${pattern}`);
  }
}
if (!manifest.contributes.capabilities?.includes('files')) {
  throw new Error('Project-relative reads need the "files" capability.');
}
if (!manifest.contributes.capabilities?.includes('sessions')) {
  throw new Error('Opening sessions needs the "sessions" capability.');
}

console.log(`Manifest ok: apiVersion ${manifest.apiVersion}, panel ${panel.id}, ${filesystem.length} filesystem patterns, entries ${[...entries].join(', ')}.`);
