import type { GuestSessionRecord, SessionSnapshot } from '@openchamber/sdk';

// SDK 2.5.2 exposes agent on the current SessionSnapshot, but not yet on
// GuestSessionRecord. Newer hosts may include it in workspace snapshots; the
// SDK's host bridge passes those trusted messages through without stripping it.
export type AgentSession = GuestSessionRecord & { agent?: string };

export type SessionTreeNode = {
  id: string;
  title: string;
  record: GuestSessionRecord | null;
  children: SessionTreeNode[];
};

// Only descendants reachable from the current session are included. Archived
// parents are not traversed, so their descendants do not become false roots.
export const buildSessionTree = (
  current: SessionSnapshot | null, sessions: GuestSessionRecord[],
): SessionTreeNode | null => {
  if (!current) return null;
  const rootRecord = sessions.find((session) => session.id === current.id) ?? null;
  if (rootRecord?.archivedAt != null) return null;
  const childrenByParent = new Map<string, GuestSessionRecord[]>();
  for (const session of sessions) {
    if (session.archivedAt !== null || session.parentId === null) continue;
    const siblings = childrenByParent.get(session.parentId) ?? [];
    siblings.push(session);
    childrenByParent.set(session.parentId, siblings);
  }
  const seen = new Set([current.id]);
  const descendants = (parentId: string): SessionTreeNode[] => {
    const children: SessionTreeNode[] = [];
    for (const record of childrenByParent.get(parentId) ?? []) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      children.push({ id: record.id, title: record.title, record, children: descendants(record.id) });
    }
    return children;
  };
  return { id: current.id, title: current.title, record: rootRecord, children: descendants(current.id) };
};

export const sameDirectory = (a: string, b: string): boolean => {
  const normalize = (path: string): string => {
    const slashes = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
    return /^[a-z]:(?:\/|$)/i.test(slashes) || slashes.startsWith('//') ? slashes.toLowerCase() : slashes;
  };
  return normalize(a) === normalize(b);
};

export const groupActiveSessions = (
  sessions: AgentSession[], projectId: string, directory: string,
): Map<string, AgentSession[]> => {
  const groups = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    if (session.projectId !== projectId || !sameDirectory(session.directory, directory)
      || session.parentId === null || session.archivedAt !== null
      || !['running', 'retrying', 'waiting-permission', 'waiting-question'].includes(session.activity)) continue;
    if (typeof session.agent !== 'string' || !session.agent.trim()) continue;
    const agent = session.agent;
    const group = groups.get(agent) ?? [];
    group.push(session);
    groups.set(agent, group);
  }
  return groups;
};
