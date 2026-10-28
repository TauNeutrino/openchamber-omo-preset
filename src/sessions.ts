import type { GuestSessionRecord } from '@openchamber/sdk';

// SDK 2.5.2 exposes agent on the current SessionSnapshot, but not yet on
// GuestSessionRecord. Newer hosts may include it in workspace snapshots; the
// SDK's host bridge passes those trusted messages through without stripping it.
export type AgentSession = GuestSessionRecord & { agent?: string };

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
