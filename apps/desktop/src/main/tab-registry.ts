export interface DesktopTabRecord<Window extends object> {
  id: string;
  groupId: string;
  window: Window;
  sessionIds: Set<string>;
  activeCwd: string | undefined;
}

export class DesktopTabRegistry<Window extends object> {
  readonly #byWindow = new Map<Window, DesktopTabRecord<Window>>();

  add(window: Window, id: string, groupId: string): DesktopTabRecord<Window> {
    const record = { id, groupId, window, sessionIds: new Set<string>(), activeCwd: undefined };
    this.#byWindow.set(window, record);
    return record;
  }

  get(window: Window): DesktopTabRecord<Window> | undefined {
    return this.#byWindow.get(window);
  }

  delete(window: Window): DesktopTabRecord<Window> | undefined {
    const record = this.#byWindow.get(window);
    this.#byWindow.delete(window);
    return record;
  }

  records(): DesktopTabRecord<Window>[] {
    return [...this.#byWindow.values()];
  }

  group(groupId: string): DesktopTabRecord<Window>[] {
    return this.records().filter((record) => record.groupId === groupId);
  }

  updateSessions(window: Window, sessionIds: readonly string[]): void {
    const record = this.#byWindow.get(window);
    if (record) record.sessionIds = new Set(sessionIds);
  }

  /**
   * Apply a pane removal and report whether its session has no remaining pane
   * attachment in any registered window. Unknown/stale requests fail closed.
   */
  closePaneSession(window: Window, sessionId: string, remainingSessionIds: readonly string[]): boolean {
    const record = this.#byWindow.get(window);
    if (!record?.sessionIds.has(sessionId)) return false;
    record.sessionIds = new Set(remainingSessionIds);
    return !this.records().some((candidate) => candidate.sessionIds.has(sessionId));
  }

  updateActiveCwd(window: Window, cwd: string | undefined): void {
    const record = this.#byWindow.get(window);
    if (record) record.activeCwd = cwd;
  }
}
