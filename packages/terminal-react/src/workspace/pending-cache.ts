export class PendingPromiseCache<Owner extends object, Value> {
  readonly #entries = new WeakMap<Owner, Map<string, Promise<Value>>>();

  get(owner: Owner, key: string, create: () => Promise<Value>): Promise<Value> {
    let byKey = this.#entries.get(owner);
    if (!byKey) {
      byKey = new Map();
      this.#entries.set(owner, byKey);
    }

    const pending = byKey.get(key);
    if (pending) return pending;

    const created = create();
    byKey.set(key, created);
    const clear = (): void => {
      if (byKey?.get(key) === created) byKey.delete(key);
    };
    void created.then(clear, clear);
    return created;
  }
}
