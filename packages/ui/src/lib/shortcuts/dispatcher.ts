import {
  eventMatchesShortcut,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
} from './bindings';
import { type ShortcutHandler, ShortcutRegistry } from './registry';
import type { ShortcutActionId } from './schema';
import { isIMECompositionEvent } from '../ime';

const SEQUENCE_TIMEOUT_MS = 3000;
const MODIFIER_KEYS = new Set(['alt', 'control', 'meta', 'shift']);

export interface ShortcutDispatcherOptions {
  registry: ShortcutRegistry;
  getBinding: (actionId: ShortcutActionId) => ShortcutCombo;
  now?: () => number;
  timeoutMs?: number;
}

interface BindingMatch {
  chords: string[];
  handler: ShortcutHandler;
}

/** Stateless with respect to the DOM; callers decide whether a consumed event is prevented. */
export class ShortcutDispatcher {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private prefix: string | undefined;
  // The target the leader chord was pressed on. DOM-agnostic (opaque
  // EventTarget): callers use it to decide whether an unmodified completion
  // key arriving from an EDITABLE target is a deliberate sequence (same
  // target as the arming press) or typing that must not be swallowed.
  private prefixTarget: EventTarget | null = null;
  private expiresAt = 0;
  private prefixSuspensionVersion = 0;
  private readonly capturedPrefixEvents = new WeakSet<KeyboardEvent>();

  constructor(private readonly options: ShortcutDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? SEQUENCE_TIMEOUT_MS;
  }

  dispatch(event: KeyboardEvent): boolean {
    if (event.repeat || isIMECompositionEvent(event) || MODIFIER_KEYS.has(event.key.toLowerCase())) {
      return false;
    }
    if (event.key === 'Escape' && this.hasActivePrefix()) {
      return this.handleEscape();
    }
    this.hasActivePrefix();

    const matches = this.getMatches();
    if (this.prefix) {
      const pending = this.getPrefixMatches(matches, event);
      if (pending.length > 0) {
        this.clear();
        return this.invoke(pending, event);
      }
      this.clear();
    }

    const singles = matches.filter((match) => (
      match.chords.length === 1 && eventMatchesShortcut(event, match.chords[0])
    ));
    if (singles.length > 0 && this.invoke(singles, event)) {
      return true;
    }

    const leader = matches.find((match) => (
      match.chords.length === 2 && eventMatchesShortcut(event, match.chords[0])
    ));
    if (leader) {
      this.prefix = leader.chords[0];
      this.prefixTarget = event.target;
      this.expiresAt = this.now() + this.timeoutMs;
      this.prefixSuspensionVersion = this.options.registry.getSuspensionVersion();
      return true;
    }
    return false;
  }

  clear(): void {
    this.prefix = undefined;
    this.prefixTarget = null;
    this.expiresAt = 0;
    this.prefixSuspensionVersion = 0;
  }

  getActivePrefixTarget(): EventTarget | null {
    return this.hasActivePrefix() ? this.prefixTarget : null;
  }

  handleBlur(): void {
    this.clear();
  }

  handleEscape(): boolean {
    const hadPrefix = this.hasActivePrefix();
    this.clear();
    return hadPrefix;
  }

  hasActivePrefix(): boolean {
    if (!this.prefix) return false;
    if (
      this.now() >= this.expiresAt
      || this.prefixSuspensionVersion !== this.options.registry.getSuspensionVersion()
    ) {
      this.clear();
      return false;
    }
    return true;
  }

  dispatchActivePrefix(event: KeyboardEvent): boolean {
    this.capturedPrefixEvents.add(event);
    if (isIMECompositionEvent(event)) {
      if (event.repeat || MODIFIER_KEYS.has(event.key.toLowerCase()) || !this.hasActivePrefix()) {
        return false;
      }
      const pending = this.getPrefixMatches(this.getMatches(), event);
      this.clear();
      return pending.length > 0 ? this.invoke(pending, event) : false;
    }
    return this.dispatch(event);
  }

  consumeCapturedPrefixEvent(event: KeyboardEvent): boolean {
    if (!this.capturedPrefixEvents.has(event)) return false;
    this.capturedPrefixEvents.delete(event);
    return true;
  }

  private invoke(matches: BindingMatch[], event: KeyboardEvent): boolean {
    for (const match of matches) {
      if (match.handler(event) !== false) {
        return true;
      }
    }
    return false;
  }

  private getPrefixMatches(matches: BindingMatch[], event: KeyboardEvent): BindingMatch[] {
    return matches.filter((match) => (
      match.chords.length === 2
      && match.chords[0] === this.prefix
      && eventMatchesShortcut(event, match.chords[1])
    ));
  }

  private getMatches(): BindingMatch[] {
    const matches: BindingMatch[] = [];
    for (const actionId of this.options.registry.actionIds()) {
      const handler = this.options.registry.get(actionId);
      if (!handler) continue;

      const binding = normalizeCombo(this.options.getBinding(actionId));
      const parsed = parseShortcut(binding);
      if (!parsed || parsed.chords.some((chord) => !chord.key || chord.key === UNASSIGNED_SHORTCUT)) {
        continue;
      }

      matches.push({ chords: binding.split(' '), handler });
    }
    return matches;
  }
}
