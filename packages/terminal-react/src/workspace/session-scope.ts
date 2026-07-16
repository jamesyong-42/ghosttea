import type { SessionSummary } from "@vibecook/ghosttea-protocol";

export function sessionsToClaim(
  sessions: readonly SessionSummary[],
  attachedSessionIds: ReadonlySet<string>,
  claimExistingSessions: boolean,
): SessionSummary[] {
  if (!claimExistingSessions) return [];
  return sessions.filter((session) => !session.exited && !attachedSessionIds.has(session.id));
}
