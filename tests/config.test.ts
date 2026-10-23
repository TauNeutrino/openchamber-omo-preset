import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPresetToText,
  orchestratorModel,
  parseConfigText,
  resolvePresetView,
  resolveWriteTarget,
  sortedPresetNames,
  writeTargetAccepts,
  type ParsedLayer,
  type PresetLayerKind,
} from '../src/config.ts';

const GLOBAL = '~/.config/opencode/oh-my-opencode-slim.json';
const PROJECT = '.opencode/oh-my-opencode-slim.json';

const layer = (
  kind: PresetLayerKind,
  path: string,
  raw: string,
): ParsedLayer => {
  const parsed = parseConfigText(raw, path);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.error);
  if (!parsed.ok) throw new Error('unreachable');
  return { kind, path, raw, config: parsed.config };
};

const CONFIG = `{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "opencode-go",
  "presets": {
    "opencode-go": {
      "orchestrator": {
        "model": "opencode-go/glm-5.3-flash",
        "variant": "high"
      },
      "fixer": {
        "model": "opencode-go/deepseek-v4.1-flash"
      }
    },
    "free": {
      "orchestrator": {
        "model": "opencode/glm-5.3-flash-free"
      }
    }
  }
}
`;

test('parses the global .json shape with variants', () => {
  const parsed = parseConfigText(CONFIG, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.preset, 'opencode-go');
  assert.deepEqual(parsed.config.presetNames, ['opencode-go', 'free']);
  assert.equal(parsed.config.hasPresets, true);
  assert.deepEqual(parsed.config.presets['opencode-go'][0], {
    agent: 'orchestrator',
    model: 'opencode-go/glm-5.3-flash',
    variant: 'high',
  });
  assert.deepEqual(parsed.config.presets.free, [
    { agent: 'orchestrator', model: 'opencode/glm-5.3-flash-free' },
  ]);
});

test('parses .jsonc with comments and a trailing comma', () => {
  const raw = `{
    // Which preset is active.
    "preset": "free",
    "presets": {
      "free": { "orchestrator": { "model": "opencode/glm-5.3-flash-free" } }, // last
    },
  }`;
  const parsed = parseConfigText(raw, 'oh-my-opencode-slim.jsonc');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.preset, 'free');
  assert.deepEqual(parsed.config.presetNames, ['free']);
});

test('keeps a preset name whose block has no usable agent', () => {
  const raw = '{ "presets": { "half": { "orchestrator": { "model": "" } } } }';
  const parsed = parseConfigText(raw, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presetNames, ['half']);
  assert.deepEqual(parsed.config.presets.half, []);
});

test('reports unparseable files with a location', () => {
  const parsed = parseConfigText('{ "preset": "free", } trailing', GLOBAL);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /ungültiges JSONC/);
  assert.match(parsed.error, /offset/);
});

test('rejects a non-object root and invalid preset keys', () => {
  const array = parseConfigText('[]', GLOBAL);
  assert.equal(array.ok, false);
  const preset = parseConfigText('{ "preset": 42 }', GLOBAL);
  assert.equal(preset.ok, false);
  const presets = parseConfigText('{ "presets": [] }', GLOBAL);
  assert.equal(presets.ok, false);
});

test('treats a comment-only file as an empty config', () => {
  const parsed = parseConfigText('// nothing yet\n', GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.commentOnly, true);
  assert.equal(parsed.config.preset, null);
});

test('changes only the preset value and keeps ordering and formatting', () => {
  const next = applyPresetToText(CONFIG, 'free');
  assert.equal(next.includes('"preset": "free"'), true);
  const before = CONFIG.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length);
  const changed = before
    .map((line, index) => (line === after[index] ? null : index))
    .filter((index): index is number => index !== null);
  assert.deepEqual(changed, [2]);
});

test('keeps JSONC comments, trailing commas and order', () => {
  const raw = `{
  // header comment
  "$schema": "schema.json",
  "preset": "opencode-go", // active
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } },
    "opencode-go": { "orchestrator": { "model": "go/model", "variant": "high" }, },
  },
  "theme": "dark",
}
`;
  const next = applyPresetToText(raw, 'free');
  assert.equal(next.includes('// header comment'), true);
  assert.equal(next.includes('// active'), true);
  assert.equal(next.includes('"theme": "dark",'), true);
  assert.equal(next.includes('"preset": "free"'), true);
  assert.equal(next.includes('"variant": "high"'), true);
  assert.deepEqual(
    next.split('\n').filter((line) => line.includes('presets')),
    raw.split('\n').filter((line) => line.includes('presets')),
  );
});

test('inserts the preset key when the file does not have one', () => {
  const raw = `{
  "$schema": "schema.json",
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } }
  }
}
`;
  const next = applyPresetToText(raw, 'free');
  // A new key goes after the existing ones, so their order is untouched.
  assert.equal(next, `{
  "$schema": "schema.json",
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } }
  },
  "preset": "free"
}
`);
});

test('inserts into an empty .jsonc root and keeps its comments', () => {
  const raw = `// my presets
{
  // only presets, no active one
}
`;
  const next = applyPresetToText(raw, 'free');
  assert.match(next, /^\/\/ my presets\n\{\n {2}"preset": "free"\n/);
  assert.equal(next.includes('// only presets, no active one'), true);
});

test('appends a root object below a comment-only file', () => {
  const next = applyPresetToText('// keep me\n', 'free');
  assert.equal(next, '// keep me\n{\n  "preset": "free"\n}\n');
});

test('preserves CRLF line endings', () => {
  const raw = '{\r\n  "preset": "old",\r\n  "presets": {\r\n    "new": {}\r\n  }\r\n}\r\n';
  const next = applyPresetToText(raw, 'new');
  assert.equal(next.includes('"preset": "new"'), true);
  assert.equal(next.includes('\n') && !next.includes('\r\n'), false);
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(parseConfigText(next, GLOBAL).ok, true);
});

test('preserves a BOM', () => {
  const raw = `\uFEFF${CONFIG}`;
  const next = applyPresetToText(raw, 'free');
  assert.equal(next.startsWith('\uFEFF'), true);
  assert.equal(next.slice(1).startsWith('{'), true);
});

test('follows a four-space indentation when inserting', () => {
  const raw = '{\n    "$schema": "schema.json",\n    "presets": {}\n}\n';
  const next = applyPresetToText(raw, 'free');
  assert.match(next, /"presets": \{\},\n {4}"preset": "free"\n/);
});

test('refuses to write when the file cannot be parsed or verified', () => {
  assert.throws(() => applyPresetToText('{ "preset": "free"', GLOBAL), /ungültiges JSONC/);
  assert.throws(() => applyPresetToText(CONFIG, '   '), /nicht leer/);
  assert.throws(() => applyPresetToText('[]', GLOBAL), /JSON-Objekt/);
});

test('resolves the global preset when there is no project layer', () => {
  const result = resolvePresetView(layer('global', GLOBAL, CONFIG), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.active, { name: 'opencode-go', origin: 'global' });
  assert.equal(result.view.agents.length, 2);
  assert.equal(result.view.activePath, GLOBAL);
});

test('the project override wins and writes to the project file', () => {
  const projectRaw = '{ "preset": "free" }';
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, projectRaw);
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.active, { name: 'free', origin: 'project' });
  assert.deepEqual(result.view.agents, [
    { agent: 'orchestrator', model: 'opencode/glm-5.3-flash-free' },
  ]);
  const target = resolveWriteTarget(global, project);
  assert.equal(target.kind, 'project');
  assert.equal(target.path, PROJECT);
  assert.deepEqual(target.availableNames, ['opencode-go', 'free']);
});

test('a project preset map decides its own names', () => {
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, '{ "preset": "local", "presets": { "local": {} } }');
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.view.active.name, 'local');
  const target = resolveWriteTarget(global, project);
  assert.deepEqual(target.availableNames, ['local']);
  assert.equal(writeTargetAccepts(target, 'free'), false);
});

test('an unknown project preset is refused without a write target', () => {
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, '{ "preset": "free", "presets": { "local": {} } }');
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /"free" ist in \.opencode\/oh-my-opencode-slim\.json nicht definiert/);
});

test('an unknown global preset is refused', () => {
  const result = resolvePresetView(layer('global', GLOBAL, '{ "preset": "gone", "presets": {} }'), null);
  assert.equal(result.ok, false);
});

test('a missing preset key is refused', () => {
  const result = resolvePresetView(layer('global', GLOBAL, '{ "presets": { "free": {} } }'), null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /kein Preset gesetzt/);
});

test('sorted names and the orchestrator hint', () => {
  const parsed = parseConfigText(CONFIG, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(sortedPresetNames(parsed.config.presets), ['free', 'opencode-go']);
  assert.equal(orchestratorModel(parsed.config.presets, 'opencode-go'), 'opencode-go/glm-5.3-flash');
  assert.equal(orchestratorModel(parsed.config.presets, 'missing'), null);
});
