import type { ShortcutActionId } from './schema';

export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

interface RegisteredHandler {
  handler: ShortcutHandler;
}

/** Active application command handlers, keyed by shortcut action ID. */
export class ShortcutRegistry {
  private readonly handlers = new Map<ShortcutActionId, RegisteredHandler[]>();
  private suspensionCount = 0;
  private suspensionVersion = 0;

  register(actionId: ShortcutActionId, handler: ShortcutHandler): () => void {
    const registration = { handler };
    const registered = this.handlers.get(actionId) ?? [];
    if (registered.length > 0 && typeof console !== 'undefined' && import.meta.env?.DEV) {
      // First registration wins at dispatch; a silent second registration is
      // almost always two components fighting over one action.
      console.warn(`[shortcuts] duplicate handler registration for "${actionId}" — only the first will dispatch`);
    }
    registered.push(registration);
    this.handlers.set(actionId, registered);
    return () => {
      const current = this.handlers.get(actionId);
      if (!current) return;
      const index = current.indexOf(registration);
      if (index === -1) return;
      current.splice(index, 1);
      if (current.length === 0) {
        this.handlers.delete(actionId);
      }
    };
  }

  get(actionId: ShortcutActionId): ShortcutHandler | undefined {
    if (this.suspensionCount > 0) return undefined;
    return this.handlers.get(actionId)?.[0]?.handler;
  }

  /** Runs an action outside keyboard dispatch (command palette). Bypasses
      suspension: the invoking surface, not the keyboard, owns the gesture. */
  invoke(actionId: ShortcutActionId): boolean {
    const handler = this.handlers.get(actionId)?.[0]?.handler;
    if (!handler) return false;
    return handler(new KeyboardEvent('keydown')) !== false;
  }

  /** Temporarily disables every registered application shortcut. */
  suspend(): () => void {
    this.suspensionCount += 1;
    this.suspensionVersion += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.suspensionCount -= 1;
      if (this.suspensionCount === 0) {
        this.suspensionVersion += 1;
      }
    };
  }

  getSuspensionVersion(): number {
    return this.suspensionVersion;
  }

  isSuspended(): boolean {
    return this.suspensionCount > 0;
  }

  actionIds(): IterableIterator<ShortcutActionId> {
    return this.handlers.keys();
  }
}

/** Shared registry for application commands registered by React surfaces. */
export const shortcutRegistry = new ShortcutRegistry();
