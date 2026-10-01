import * as vscode from 'vscode';

/**
 * Extension-host notification delivery for the VS Code runtime.
 *
 * Why this module exists: VS Code webviews render inside a subframe
 * (`window.top !== window`), and Chromium only displays `new Notification()`
 * from the top-level browsing context. The browser Notification API is
 * therefore a dead end here — it constructs without throwing and never shows
 * anything. The only viable surface is the extension host
 * (`vscode.window.show*Message`), which is what this module wraps.
 *
 * Design: small channel registry so new notification kinds can pick their own
 * VS Code surface without touching call sites. Payloads arrive over the
 * `api:notifications:show` bridge from the webview, which keeps all
 * filtering/templating/cooldown decisions and only delegates delivery.
 */

export type VSCodeNotificationKind = 'completion' | 'subtask' | 'error' | 'question' | 'test';

export interface VSCodeNotificationPayload {
  title?: unknown;
  body?: unknown;
  sessionId?: unknown;
  tag?: unknown;
  kind?: unknown;
  requireHidden?: unknown;
}

type ShowFn = (message: string, ...items: string[]) => Thenable<string | undefined>;

const CHANNELS: Record<string, ShowFn> = {
  error: (message, ...items) => vscode.window.showErrorMessage(message, ...items),
  question: (message, ...items) => vscode.window.showWarningMessage(message, ...items),
  completion: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
  subtask: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
  test: (message, ...items) => vscode.window.showInformationMessage(message, ...items),
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const normalizeKind = (value: unknown): VSCodeNotificationKind => {
  const kind = normalizeText(value).toLowerCase();
  if (kind === 'error' || kind === 'question' || kind === 'subtask' || kind === 'test') return kind;
  return 'completion';
};

const getClaimKey = (title: string, body: string, sessionId: string, tag: string): string => {
  if (tag) return `tag:${tag}`;
  const parts = [sessionId, title, body].filter((part) => part.length > 0);
  return parts.join('|');
};

const NOTIFICATION_CLAIM_TTL_MS = 10_000;
const notificationClaims = new Map<string, number>();

const pruneClaims = (now: number): void => {
  for (const [key, claimedAt] of notificationClaims) {
    if (now - claimedAt > NOTIFICATION_CLAIM_TTL_MS) {
      notificationClaims.delete(key);
    }
  }
};

/** Single-flight dedup for completion storms; moved here from the old webview claim bridge. */
const claimNotification = (key: string): boolean => {
  if (!key) return true;
  const now = Date.now();
  pruneClaims(now);
  const existing = notificationClaims.get(key);
  if (existing && now - existing <= NOTIFICATION_CLAIM_TTL_MS) {
    return false;
  }
  notificationClaims.set(key, now);
  return true;
};

export const __testOnly = {
  resetClaims: () => notificationClaims.clear(),
};

const formatMessage = (title: string, body: string): string => {
  if (title && body) return `${title}: ${body}`;
  return title || body || 'OpenChamber';
};

/**
 * Show a notification via the VS Code host UI.
 * @returns true when the toast was shown (or intentionally suppressed by
 * `requireHidden`/dedup, which is not a failure); false only when delivery
 * was impossible or threw, so the Settings test button reports honestly.
 */
export const showVSCodeNotification = async (payload?: VSCodeNotificationPayload): Promise<boolean> => {
  const title = normalizeText(payload?.title) || 'OpenChamber';
  const body = normalizeText(payload?.body);
  const sessionId = normalizeText(payload?.sessionId);
  const tag = normalizeText(payload?.tag);
  const kind = normalizeKind(payload?.kind);
  const requireHidden = payload?.requireHidden === true;

  if (requireHidden && vscode.window.state.focused) {
    return true;
  }

  if (!claimNotification(getClaimKey(title, body, sessionId, tag))) {
    return true;
  }

  const show: ShowFn = CHANNELS[kind] ?? CHANNELS.completion;
  try {
    const message = formatMessage(title, body);
    if (sessionId) {
      const picked = await show(message, 'Show');
      if (picked === 'Show') {
        await vscode.commands.executeCommand('openchamber.openSidebar').then(
          () => undefined,
          () => undefined,
        );
      }
    } else {
      await show(message);
    }
    return true;
  } catch {
    return false;
  }
};
