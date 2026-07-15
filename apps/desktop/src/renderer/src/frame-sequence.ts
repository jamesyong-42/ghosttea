export interface AppliedFrameState {
  sessionEpoch: bigint;
  layoutEpoch: bigint;
  sequence: bigint;
  awaitingResync: boolean;
}

export interface IncomingFrameState {
  sessionEpoch: bigint;
  layoutEpoch: bigint;
  sequence: bigint;
  full: boolean;
}

export function classifyFrame(
  previous: AppliedFrameState,
  incoming: IncomingFrameState,
): "accept" | "stale" | "resync" {
  const sameSession = previous.sessionEpoch === 0n || incoming.sessionEpoch === previous.sessionEpoch;
  if (
    sameSession &&
    (incoming.layoutEpoch < previous.layoutEpoch ||
      (incoming.layoutEpoch === previous.layoutEpoch && incoming.sequence <= previous.sequence))
  )
    return "stale";
  if (previous.awaitingResync && !incoming.full) return "resync";
  const changedSession = !sameSession;
  const missingInitialSnapshot = previous.sessionEpoch === 0n && !incoming.full;
  const sequenceGap =
    previous.sessionEpoch === incoming.sessionEpoch &&
    previous.sequence !== 0n &&
    incoming.sequence !== previous.sequence + 1n;
  return !incoming.full && (changedSession || missingInitialSnapshot || sequenceGap) ? "resync" : "accept";
}
