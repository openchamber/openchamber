/** Coalesces directory reads and rejects completions superseded by refresh or scope changes. */
export class DirectoryRequests {
  private pending = new Map<string, Promise<void>>();

  has(path: string): boolean {
    return this.pending.has(path);
  }

  clear(): void {
    this.pending.clear();
  }

  run(path: string, load: (isCurrent: () => boolean) => Promise<void>, force = false): Promise<void> {
    const existing = this.pending.get(path);
    if (existing && !force) return existing;
    const isCurrent = (): boolean => this.pending.get(path) === promise;
    const promise: Promise<void> = Promise.resolve().then(() => isCurrent() ? load(isCurrent) : undefined).finally(() => {
      if (isCurrent()) this.pending.delete(path);
    });
    this.pending.set(path, promise);
    return promise;
  }
}
