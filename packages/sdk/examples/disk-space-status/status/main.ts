import { connectHost, HostRequestError, type SessionLifecycleEvent } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountProgress } from '@openchamber/sdk/ui';
import { diskSpaceMessages } from './messages.ts';
import { parseCapacity, formatBytes, type Capacity } from './capacity.ts';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('Missing extension root');
root.className = 'disk-space';
const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: transparent; }
  .disk-space { display: flex; flex-direction: column; gap: 6px; padding: 2px 4px; }
  .disk-space [hidden] { display: none; }
  .disk-space .capacity { color: var(--oc-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .disk-space .controls { display: flex; justify-content: flex-end; }
  .disk-space .oc-sdk-progress-track { background: var(--oc-subtle); }
  .disk-space .oc-sdk-progress-fill:not([data-tone]) { background: var(--oc-muted); }
  html[dir="rtl"] .disk-space .oc-sdk-progress-fill { transform-origin: right; }
  @media (prefers-reduced-motion: reduce) {
    .disk-space .oc-sdk-spinner-ring { animation: none; }
    .disk-space .oc-sdk-progress-fill { transition: none; }
  }
`;
document.head.append(style);
const progress = mountProgress(root, { value: 0 });
const caption = document.createElement('div');
caption.className = 'capacity';
caption.dir = 'auto';
root.append(caption);
const controls = document.createElement('div');
controls.className = 'controls';
root.append(controls);
const refreshButton = mountButton(controls, { label: '', size: 'xs', variant: 'ghost', onClick: () => { void refresh(); } });

let directory: string | null = null;
let locale = 'en';
let capacity: Capacity | null = null;
let failure: 'unavailable' | 'grant' | null = null;
let inFlight = false;
let generation = 0;
let disposed = false;
let lastReadAt = 0;
let activityTimer: ReturnType<typeof setTimeout> | undefined;
let lifecycle: SessionLifecycleEvent | null = null;

const render = (): void => {
  const text = diskSpaceMessages(locale);
  const percent = capacity ? (1 - capacity.availableBytes / capacity.totalBytes) * 100 : 0;
  progress.update({ value: percent, label: text.used, tone: percent >= 95 ? 'error' : percent >= 85 ? 'warning' : 'neutral' });
  const meter = root.querySelector<HTMLElement>('.oc-sdk-progress');
  if (meter) meter.hidden = !capacity;
  caption.textContent = capacity
    ? text.available.replace('{available}', formatBytes(capacity.availableBytes, locale)).replace('{total}', formatBytes(capacity.totalBytes, locale))
    : !directory ? text.project : failure ? text[failure] : text.loading;
  refreshButton.update({ label: text.refresh, loading: inFlight, disabled: !directory });
  void host.setHeight(Math.ceil(root.getBoundingClientRect().height)).catch(() => undefined);
};

const clearActivity = (): void => {
  clearTimeout(activityTimer);
  activityTimer = undefined;
};

const refresh = async (): Promise<void> => {
  if (disposed || !directory || inFlight || document.visibilityState === 'hidden') return;
  clearActivity();
  const requestedDirectory = directory;
  const current = generation;
  inFlight = true;
  lastReadAt = Date.now();
  render();
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/disk-space', query: { directory: requestedDirectory } });
    if (result.status !== 200) throw new Error('Disk space is unavailable');
    const data = parseCapacity(result.body);
    if (disposed || current !== generation) return;
    capacity = data;
    failure = null;
  } catch (error) {
    if (disposed || current !== generation) return;
    capacity = null;
    failure = error instanceof HostRequestError && (error.code === 'NO_SERVICE' || error.code === 'NOT_GRANTED') ? 'grant' : 'unavailable';
  } finally {
    inFlight = false;
    if (!disposed) {
      render();
      if (current !== generation) void refresh();
    }
  }
};

const setDirectory = (next: string | null): void => {
  if (next === directory) return;
  generation += 1;
  clearActivity();
  lifecycle = null;
  directory = next;
  capacity = null;
  failure = null;
  render();
  void refresh();
};

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  locale = context.locale;
  document.documentElement.lang = locale;
  document.documentElement.dir = /^(ar|he)(-|$)/i.test(locale) ? 'rtl' : 'ltr';
  setDirectory(context.directory);
  render();
});
host.onDirectory(setDirectory);
host.onSessionLifecycle((event) => {
  // The initial replay is a baseline; mount already requested capacity.
  const previous = lifecycle;
  lifecycle = event;
  if (!previous || previous.sessionId !== event.sessionId || previous.phase === event.phase) return;
  if (!directory || disposed || document.visibilityState === 'hidden' || activityTimer !== undefined) return;
  activityTimer = setTimeout(() => {
    activityTimer = undefined;
    void refresh();
  }, Math.max(0, 30_000 - (Date.now() - lastReadAt)));
});
const onFocus = (): void => { void refresh(); };
const onVisibility = (): void => { if (document.visibilityState === 'hidden') clearActivity(); else void refresh(); };
window.addEventListener('focus', onFocus);
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', () => {
  disposed = true;
  generation += 1;
  clearActivity();
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('visibilitychange', onVisibility);
  host.dispose();
}, { once: true });
