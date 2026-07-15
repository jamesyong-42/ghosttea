export interface FrameResyncOptions {
  retryDelaysMs?: readonly number[];
  onExhausted?: (sessionHandle: string, error: unknown) => void;
}

interface ResyncState {
  attempt: number;
  exhausted: boolean;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastError: unknown;
}

const DEFAULT_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;

export class FrameResyncController {
  readonly #states = new Map<string, ResyncState>();
  readonly #retryDelaysMs: readonly number[];
  readonly #onExhausted: ((sessionHandle: string, error: unknown) => void) | undefined;

  constructor(
    readonly refresh: (sessionHandle: string) => Promise<void>,
    options: FrameResyncOptions = {},
  ) {
    this.#retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.#onExhausted = options.onExhausted;
  }

  request(sessionHandle: string): void {
    let state = this.#states.get(sessionHandle);
    if (!state) {
      state = { attempt: 0, exhausted: false, inFlight: false, timer: undefined, lastError: undefined };
      this.#states.set(sessionHandle, state);
    } else if (state.exhausted) {
      state.attempt = 0;
      state.exhausted = false;
      state.lastError = undefined;
    }
    void this.#drain(sessionHandle, state);
  }

  complete(sessionHandle: string): void {
    this.cancel(sessionHandle);
  }

  cancel(sessionHandle: string): void {
    const state = this.#states.get(sessionHandle);
    if (!state) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    this.#states.delete(sessionHandle);
  }

  dispose(): void {
    for (const sessionHandle of this.#states.keys()) this.cancel(sessionHandle);
  }

  async #drain(sessionHandle: string, state: ResyncState): Promise<void> {
    if (this.#states.get(sessionHandle) !== state || state.inFlight || state.timer !== undefined || state.exhausted)
      return;
    state.inFlight = true;
    state.attempt += 1;
    try {
      await this.refresh(sessionHandle);
      state.lastError = undefined;
    } catch (error) {
      state.lastError = error;
    } finally {
      state.inFlight = false;
    }
    if (this.#states.get(sessionHandle) !== state) return;
    const retryIndex = state.attempt - 1;
    const delay = this.#retryDelaysMs[retryIndex];
    if (delay === undefined) {
      state.exhausted = true;
      this.#onExhausted?.(sessionHandle, state.lastError);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.#drain(sessionHandle, state);
    }, delay);
  }
}
