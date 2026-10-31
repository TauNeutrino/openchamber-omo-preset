import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  auditModelRefs,
  collectModelRefs,
  parseCatalogLine,
  parseCatalogOutput,
} from '../src/model-audit.ts';

test('parseCatalogLine keeps provider/model pairs', () => {
  assert.equal(parseCatalogLine('opencode-go/glm-5.3-flash'), 'opencode-go/glm-5.3-flash');
  assert.equal(parseCatalogLine('  openai/gpt-5.5  '), 'openai/gpt-5.5');
});

test('parseCatalogLine drops prose and malformed lines', () => {
  assert.equal(parseCatalogLine(''), null);
  assert.equal(parseCatalogLine('#comment'), null);
  assert.equal(parseCatalogLine('DESCRIPTION'), null);
  assert.equal(parseCatalogLine('no slash here'), null);
  assert.equal(parseCatalogLine('/leading'), null);
  assert.equal(parseCatalogLine('trailing/'), null);
  assert.equal(parseCatalogLine('openai /gpt-5'), null);
  assert.equal(parseCatalogLine('openai/some model'), null);
});

test('parseCatalogOutput dedupes and keeps order (case-sensitive ids)', () => {
  assert.deepEqual(
    parseCatalogOutput('a/b\nA/B\nc/d\n\ngarbage\na/b'),
    ['a/b', 'A/B', 'c/d'],
  );
});

test('auditModelRefs flags missing models and reports ok otherwise', () => {
  const refs = ['opencode-go/glm-5.3-flash', 'opencode/glm-5.3-flash-free'];
  const withCatalog = auditModelRefs(refs, ['opencode-go/glm-5.3-flash', 'opencode/glm-5.3-flash-free'], '2026-10-31T00:00:00Z');
  assert.equal(withCatalog.ok, true);
  assert.deepEqual(withCatalog.missing, []);

  const broken = auditModelRefs(refs, ['opencode-go/glm-5.3-flash'], '2026-10-31T00:00:00Z');
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.missing.map((entry) => entry.ref), ['opencode/glm-5.3-flash-free']);
});

test('auditModelRefs is not ok before the first successful catalog', () => {
  const pending = auditModelRefs(['a/b'], [], null);
  assert.equal(pending.ok, false);
  assert.deepEqual(pending.missing, []);
});

test('auditModelRefs strips a variant suffix before the lookup', () => {
  const audited = auditModelRefs(['a/b#fast'], ['a/b'], '2026-10-31T00:00:00Z');
  assert.equal(audited.ok, true);
});

test('auditModelRefs dedupes repeated references', () => {
  const audited = auditModelRefs(['a/b', 'a/b', 'c/d'], ['c/d'], '2026-10-31T00:00:00Z');
  assert.equal(audited.checked, 3);
  assert.deepEqual(audited.missing.map((entry) => entry.ref), ['a/b']);
});

test('collectModelRefs merges active agents and both layers, deduped', () => {
  const refs = collectModelRefs(
    [{ model: 'x/y' }, { model: 'x/z', variant: 'high' }],
    [[{ model: 'x/y' }], [{ model: 'x/z' }], null],
  );
  assert.deepEqual(refs, ['x/y', 'x/z']);
});

test('collectModelRefs ignores empty and invalid model entries', () => {
  const refs = collectModelRefs(
    [{ model: '' }, { model: '   ' } as never, null as never],
    [null, [null as never, { model: 'a/b' }]],
  );
  assert.deepEqual(refs, ['a/b']);
});
