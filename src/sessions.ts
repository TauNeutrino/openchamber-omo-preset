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

/** Activities that mean the session is still doing something. */
export const ACTIVE_ACTIVITIES = ['running', 'retrying', 'waiting-permission', 'waiting-question'] as const;

const isSessionActive = (session: AgentSession): boolean => (
  // Ein gesetztes outcome gewinnt: ein 'running', das kurz vor dem Snapshot
  // endet, Parken in dieser Gruppe wäre falsch.
  session.outcome == null && (ACTIVE_ACTIVITIES as readonly string[]).includes(session.activity)
);

/** Finished sessions stay listed this long after their last update. */
export const FINISHED_WINDOW_MS = 8 * 60 * 60 * 1000;

/** ①–⑩, clamped at ⑩; counts above 10 get a `+` appended by the caller. */
export const countGlyph = (n: number): string => ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][Math.min(Math.max(n, 1), 10) - 1];

export type AgentSessionGroups = {
  /** Sessions still doing something. */
  active: AgentSession[];
  /** Finished within the recent window, newest first. */
  recent: AgentSession[];
};

export const groupAgentSessions = (
  sessions: AgentSession[], projectId: string, directory: string, now: number = Date.now(),
): Map<string, AgentSessionGroups> => {
  const groups = new Map<string, AgentSessionGroups>();
  const windowStart = now - FINISHED_WINDOW_MS;
  for (const session of sessions) {
    if (session.projectId !== projectId || !sameDirectory(session.directory, directory)
      || session.parentId === null || session.archivedAt !== null
      || (typeof session.agent !== 'string' || !session.agent.trim())) continue;
    if (!isSessionActive(session) && session.updatedAt < windowStart) continue;
    const entry = groups.get(session.agent) ?? { active: [], recent: [] };
    if (isSessionActive(session)) {
      entry.active.push(session);
    } else {
      entry.recent.push(session);
    }
    groups.set(session.agent, entry);
  }
  for (const entry of groups.values()) {
    entry.recent.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return groups;
};

export const groupActiveSessions = (
  sessions: AgentSession[], projectId: string, directory: string,
): Map<string, AgentSession[]> => {
  const groups = new Map<string, AgentSession[]>();
  for (const [agent, entry] of groupAgentSessions(sessions, projectId, directory)) {
    if (entry.active.length) groups.set(agent, entry.active);
  }
  return groups;
};
