export type DesktopUpdateIdle = { state: 'idle' | 'busy' | 'unknown' };
type State = DesktopUpdateIdle['state'];

export type SessionStateReader = {
  getSessionStateSnapshot: () => Readonly<Record<string, { status: string }>>;
  getSessionActivitySnapshot: () => Readonly<Record<string, { type: string }>>;
  getPendingBlockingRequestsSnapshot: () => Readonly<Record<string, {
    permissions: readonly unknown[]; forms: readonly unknown[]; pages: readonly unknown[];
  }>>;
};

export function readSessionActivity(runtime: SessionStateReader): State {
  const sessions = runtime.getSessionStateSnapshot();
  const active = new Set<string>();
  for (const [id, phase] of Object.entries(runtime.getSessionActivitySnapshot())) {
    if (phase.type === 'busy') active.add(id);
  }
  for (const [id, pending] of Object.entries(runtime.getPendingBlockingRequestsSnapshot())) {
    if (pending.permissions.length || pending.forms.length || pending.pages.length) active.add(id);
  }
  for (const [id, { status }] of Object.entries(sessions)) {
    if (status === 'busy' || status === 'retry') active.add(id);
    else if (status !== 'idle' && !active.has(id)) return 'unknown';
  }
  return active.size ? 'busy' : 'idle';
}
