import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionTree, groupActiveSessions, sameDirectory, type AgentSession } from '../src/sessions.ts';

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 's1', title: 'Arbeit', projectId: 'p1', directory: '/project', parentId: 'parent',
  createdAt: 0, updatedAt: 0, archivedAt: null, worktree: null,
  activity: 'running', outcome: null, items: [], agent: 'fixer', ...overrides,
});

test('groups only active, unarchived subagents in the current project and directory', () => {
  const grouped = groupActiveSessions([
    session(), session({ id: 's2', activity: 'retrying' }),
    session({ id: 's3', activity: 'waiting-permission' }),
    session({ id: 's4', activity: 'waiting-question', agent: 'designer' }),
    session({ id: 'idle', activity: 'idle' }), session({ id: 'unknown', activity: 'unknown' }),
    session({ id: 'parent', parentId: null }), session({ id: 'archived', archivedAt: 1 }),
    session({ id: 'other-dir', directory: '/other' }), session({ id: 'other-project', projectId: 'p2' }),
    session({ id: 'no-agent', agent: undefined }),
  ], 'p1', '/project');
  assert.deepEqual([...grouped].map(([agent, entries]) => [agent, entries.map((entry) => entry.id)]), [
    ['fixer', ['s1', 's2', 's3']], ['designer', ['s4']],
  ]);
});

test('active sessions without an agent produce no groups', () => {
  const grouped = groupActiveSessions([
    session({ id: 'missing', agent: undefined }),
    session({ id: 'empty', agent: '' }),
    session({ id: 'blank', agent: '  ', activity: 'waiting-question' }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 0);
});

test('keeps named groups when unattributed sessions are present', () => {
  const grouped = groupActiveSessions([
    session({ id: 'missing', agent: undefined }),
    session({ id: 'named', agent: 'Subagenten' }),
    session({ id: 'fixer' }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get('Subagenten')?.map((item) => item.id), ['named']);
  assert.deepEqual(grouped.get('fixer')?.map((item) => item.id), ['fixer']);
});

test('no active subagents produces no groups', () => {
  const grouped = groupActiveSessions([
    session({ activity: 'idle' }),
    session({ activity: 'unknown' }),
    session({ archivedAt: 5 }),
    session({ parentId: null }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 0);
});

const current = { id: 'root', title: 'Aktuell', busy: false, agent: 'fixer', model: 'model/id' };

test('builds a tree rooted at the current session, including nested descendants', () => {
  const tree = buildSessionTree(current, [
    session({ id: 'root', title: 'Workspace-Titel', parentId: null }),
    session({ id: 'child', title: 'Kind', parentId: 'root', agent: undefined }),
    session({ id: 'grandchild', title: 'Enkel', parentId: 'child', directory: '/worktree', agent: undefined }),
    session({ id: 'sibling', title: 'Zweites Kind', parentId: 'root' }),
  ]);
  assert.equal(tree?.title, 'Aktuell');
  assert.deepEqual(tree?.children.map((node) => node.id), ['child', 'sibling']);
  assert.deepEqual(tree?.children[0].children.map((node) => node.id), ['grandchild']);
  assert.deepEqual(tree?.children[0].children[0].children, []);
});

test('excludes orphans and archived sessions with their descendants', () => {
  const tree = buildSessionTree(current, [
    session({ id: 'visible', parentId: 'root' }),
    session({ id: 'orphan', parentId: 'outside' }),
    session({ id: 'archived', parentId: 'root', archivedAt: 123 }),
    session({ id: 'archived-child', parentId: 'archived' }),
    session({ id: 'cycle', parentId: 'cycle' }),
  ]);
  assert.deepEqual(tree?.children.map((node) => node.id), ['visible']);
  assert.equal(buildSessionTree(current, [session({ id: 'root', archivedAt: 1 })]), null);
});

test('no current session is empty; a missing workspace root still shows available children', () => {
  const records = [session({ id: 'child', parentId: 'root' })];
  assert.equal(buildSessionTree(null, records), null);
  const tree = buildSessionTree(current, records);
  assert.equal(tree?.record, null);
  assert.deepEqual(tree?.children.map((node) => node.id), ['child']);
});

test('compares paths without confusing Windows case and POSIX case', () => {
  assert.equal(sameDirectory('C:\\Work\\Project\\', 'c:/work/project'), true);
  assert.equal(sameDirectory('C:\\', 'c:/'), true);
  assert.equal(sameDirectory('/Work/Project/', '/work/project'), false);
  assert.equal(sameDirectory('/', '/'), true);
});
