export interface FrameResyncOptions {
  retryDelaysMs?: readonly number[];
  maxConcurrent?: number;
  startIntervalMs?: number;
  onExhausted?: (sessionHandle: string, error: unknown) => void;
}

interface ResyncState {
  attempt: number;
  exhausted: boolean;
  inFlight: boolean;
  queued: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastError: unknown;
}

const DEFAULT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_START_INTERVAL_MS = 25;

export class FrameResyncController {
  readonly #states = new Map<string, ResyncState>();
  readonly #queue: string[] = [];
  readonly #retryDelaysMs: readonly number[];
  readonly #maxConcurrent: number;
  readonly #startIntervalMs: number;
  readonly #onExhausted: ((sessionHandle: string, error: unknown) => void) | undefined;
  #active = 0;
  #nextStartAt = 0;
  #pumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly refresh: (sessionHandle: string) => Promise<void>,
    options: FrameResyncOptions = {},
  ) {
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const requestedConcurrency = options.maxConcurrent ?? 2;
    this.#maxConcurrent =
      Number.isSafeInteger(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 2;
    const requestedStartInterval = options.startIntervalMs ?? DEFAULT_START_INTERVAL_MS;
    this.#startIntervalMs =
      Number.isSafeInteger(requestedStartInterval) && requestedStartInterval >= 0
        ? requestedStartInterval
        : DEFAULT_START_INTERVAL_MS;
    this.#onExhausted = options.onExhausted;
  }

  request(sessionHandle: string): void {
    let state = this.#states.get(sessionHandle);
    if (!state) {
      state = {
        attempt: 0,
        exhausted: false,
        inFlight: false,
        queued: false,
        timer: undefined,
        lastError: undefined,
      };
      this.#states.set(sessionHandle, state);
    } else if (state.exhausted) {
      state.attempt = 0;
      state.exhausted = false;
      state.lastError = undefined;
    }
    this.#enqueue(sessionHandle, state);
  }

  complete(sessionHandle: string): void {
    this.cancel(sessionHandle);
  }

  cancel(sessionHandle: string): void {
    const state = this.#states.get(sessionHandle);
    if (!state) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (state.queued) {
      state.queued = false;
      const queueIndex = this.#queue.indexOf(sessionHandle);
      if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    }
    this.#states.delete(sessionHandle);
    if (this.#queue.length === 0 && this.#pumpTimer !== undefined) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = undefined;
    }
  }

  dispose(): void {
    for (const sessionHandle of [...this.#states.keys()]) this.cancel(sessionHandle);
    this.#queue.length = 0;
    if (this.#pumpTimer !== undefined) clearTimeout(this.#pumpTimer);
    this.#pumpTimer = undefined;
  }

  #enqueue(sessionHandle: string, state: ResyncState): void {
    if (
      this.#states.get(sessionHandle) !== state ||
      state.inFlight ||
      state.queued ||
      state.timer !== undefined ||
      state.exhausted
    )
      return;
    state.queued = true;
    this.#queue.push(sessionHandle);
    this.#pump();
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrent) {
      while (this.#queue.length > 0) {
        const queuedHandle = this.#queue[0]!;
        const queuedState = this.#states.get(queuedHandle);
        if (queuedState?.queued && !queuedState.inFlight && queuedState.timer === undefined && !queuedState.exhausted)
          break;
        this.#queue.shift();
      }
      const sessionHandle = this.#queue[0];
      if (sessionHandle === undefined) return;
      const delay = this.#nextStartAt - Date.now();
      if (delay > 0) {
        this.#schedulePump(delay);
        return;
      }
      this.#queue.shift();
      const state = this.#states.get(sessionHandle);
      if (!state || !state.queued || state.inFlight || state.timer !== undefined || state.exhausted) continue;
      state.queued = false;
      state.inFlight = true;
      this.#active += 1;
      this.#nextStartAt = Date.now() + this.#startIntervalMs;
      void this.#attempt(sessionHandle, state);
      if (this.#startIntervalMs > 0) {
        if (this.#queue.length > 0) this.#schedulePump(this.#startIntervalMs);
        return;
      }
    }
  }

  #schedulePump(delay: number): void {
    if (this.#pumpTimer !== undefined) return;
    this.#pumpTimer = setTimeout(() => {
      this.#pumpTimer = undefined;
      this.#pump();
    }, delay);
  }

  async #attempt(sessionHandle: string, state: ResyncState): Promise<void> {
    state.attempt += 1;
    try {
      await this.refresh(sessionHandle);
      state.lastError = undefined;
    } catch (error) {
      state.lastError = error;
    } finally {
      state.inFlight = false;
      this.#active -= 1;
    }
    if (this.#states.get(sessionHandle) !== state) {
      this.#pump();
      return;
    }
    const retryIndex = state.attempt - 1;
    const delay = this.#retryDelaysMs[retryIndex];
    if (delay === undefined) {
      state.exhausted = true;
      try {
        this.#onExhausted?.(sessionHandle, state.lastError);
      } finally {
        this.#pump();
      }
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.#enqueue(sessionHandle, state);
    }, delay);
    this.#pump();
  }
}
