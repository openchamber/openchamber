import {
  surfaceInspectorMessageSchema,
  type SurfaceConsoleEntry, type SurfaceNetworkEntry, type SurfaceInspectorCommand,
  type SurfaceInspectorErrorCode, type SurfaceInspectorEvaluation,
  type SurfaceInspectorRequestDetails, type SurfaceInspectorScope,
} from './remoteSurfaceInspectorProtocol';
import { RemoteSurfaceInspectorError, RemoteSurfaceInspectorRequest } from './remoteSurfaceInspectorRequest';

export { RemoteSurfaceInspectorError } from './remoteSurfaceInspectorRequest';

export type RemoteSurfaceInspectorState = {
  readonly open: boolean;
  readonly phase: 'closed' | 'starting' | 'capturing' | 'error';
  readonly tabId: string | null;
  readonly captureId: string | null;
  readonly console: readonly SurfaceConsoleEntry[];
  readonly network: readonly SurfaceNetworkEntry[];
  readonly droppedConsole: number;
  readonly droppedNetwork: number;
  readonly errorMessage: string | null;
  readonly errorCode: SurfaceInspectorErrorCode | null;
};

const emptyState: RemoteSurfaceInspectorState = {
  open: false, phase: 'closed', tabId: null, captureId: null, console: [], network: [],
  droppedConsole: 0, droppedNetwork: 0, errorMessage: null, errorCode: null,
};
const encoder = new TextEncoder();

function upsertRows<T extends { readonly id: string }>(
  current: readonly T[], incoming: readonly T[], limit: number,
) {
  if (incoming.length === 0) return { rows: current, dropped: 0 };
  const entries = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) entries.set(row.id, row);
  const rows = [...entries.values()];
  let bytes = 2;
  let start = rows.length;
  while (start > Math.max(0, rows.length - limit)) {
    const rowBytes = encoder.encode(JSON.stringify(rows[start - 1])).byteLength + (bytes > 2 ? 1 : 0);
    if (bytes + rowBytes > 1024 * 1024) break;
    bytes += rowBytes;
    start -= 1;
  }
  return { rows: rows.slice(start), dropped: start };
}

export class RemoteSurfaceInspector {
  private state: RemoteSurfaceInspectorState = emptyState;
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private starting: { readonly requestId: string; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly clearing = new Map<SurfaceInspectorScope, string>();
  private readonly evaluation = new RemoteSurfaceInspectorRequest<SurfaceInspectorEvaluation>();
  private readonly details = new RemoteSurfaceInspectorRequest<SurfaceInspectorRequestDetails>();
  private clientDropped = { console: 0, network: 0 };

  constructor(private readonly send: (command: SurfaceInspectorCommand) => boolean) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getState = (): RemoteSurfaceInspectorState => this.state;

  setOpen(open: boolean): void {
    if (open === this.state.open && this.state.phase !== 'error') return;
    this.stopCapture();
    this.publish({ ...emptyState, open, tabId: this.state.tabId });
    if (open) this.startCapture();
  }

  setAttachment(tabId: string | null): void {
    if (tabId === this.state.tabId) return;
    this.stopCapture();
    this.publish({ ...emptyState, open: this.state.open, tabId });
    if (this.state.open) this.startCapture();
  }

  clear(scope: SurfaceInspectorScope): void {
    const identity = this.captureIdentity();
    if (!identity) return;
    if (scope === 'network') this.details.cancel('CANCELLED');
    this.clearing.set(scope, identity.requestId);
    if (!this.send({ type: 'inspectorClear', ...identity, scope })) this.setError('UNAVAILABLE');
  }

  invalidateRequests(): void {
    this.evaluation.cancel('CANCELLED');
    this.details.cancel('CANCELLED');
  }

  evaluate(expression: string): Promise<SurfaceInspectorEvaluation> {
    const identity = this.captureIdentity();
    if (!identity) return Promise.reject(new RemoteSurfaceInspectorError('UNAVAILABLE'));
    if (!expression.trim() || expression.length > 16_000) {
      return Promise.reject(new RemoteSurfaceInspectorError('INVALID_REQUEST'));
    }
    const command: SurfaceInspectorCommand = { type: 'inspectorEvaluate', ...identity, expression };
    if (encoder.encode(JSON.stringify(command)).byteLength > 64 * 1024) {
      return Promise.reject(new RemoteSurfaceInspectorError('INVALID_REQUEST'));
    }
    return this.evaluation.start(identity, () => this.send(command));
  }

  requestDetails(entryId: string, includeBody: boolean): Promise<SurfaceInspectorRequestDetails> {
    const identity = this.captureIdentity();
    if (!identity) return Promise.reject(new RemoteSurfaceInspectorError('UNAVAILABLE'));
    if (!this.state.network.some((row) => row.id === entryId)) {
      return Promise.reject(new RemoteSurfaceInspectorError('REQUEST_GONE'));
    }
    return this.details.start({ ...identity, entryId },
      () => this.send({ type: 'inspectorRequest', ...identity, entryId, includeBody }));
  }

  receive(raw: string): void {
    if (encoder.encode(raw).byteLength > 64 * 1024) return;
    let parsed: ReturnType<typeof surfaceInspectorMessageSchema.safeParse>;
    try { parsed = surfaceInspectorMessageSchema.safeParse(JSON.parse(raw)); }
    catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.tabId !== this.state.tabId || !this.state.open) return;
    if (message.type === 'inspectorStarted') {
      if (message.requestId !== this.starting?.requestId) return;
      clearTimeout(this.starting.timer);
      this.starting = null;
      this.publish({ ...this.state, phase: 'capturing', captureId: message.captureId });
      return;
    }
    if (message.type === 'inspectorError') {
      if (message.requestId === this.starting?.requestId) {
        this.stopCapture();
        this.setError(message.code);
        return;
      }
      if (message.captureId !== this.state.captureId) return;
      this.evaluation.fail(message.requestId, message.code);
      this.details.fail(message.requestId, message.code);
      if ([...this.clearing.values()].includes(message.requestId)) this.publish({ ...this.state,
        errorCode: message.code, errorMessage: new RemoteSurfaceInspectorError(message.code).message });
      return;
    }
    if (message.captureId !== this.state.captureId || this.state.phase !== 'capturing') return;
    switch (message.type) {
      case 'inspectorEvents': {
        const consoleRows = upsertRows(this.state.console, message.console, 300);
        const networkRows = upsertRows(this.state.network, message.network, 200);
        this.clientDropped.console += consoleRows.dropped;
        this.clientDropped.network += networkRows.dropped;
        this.publish({ ...this.state, console: consoleRows.rows, network: networkRows.rows,
          droppedConsole: message.droppedConsole + this.clientDropped.console,
          droppedNetwork: message.droppedNetwork + this.clientDropped.network });
        return;
      }
      case 'inspectorEvaluated': this.evaluation.receive(message); return;
      case 'inspectorRequestResult': this.details.receive(message); return;
      case 'inspectorCleared':
        if (this.clearing.get(message.scope) !== message.requestId) return;
        this.clearing.delete(message.scope);
        this.clientDropped[message.scope] = 0;
        if (message.scope === 'console') this.publish({ ...this.state, console: [], droppedConsole: 0 });
        else this.publish({ ...this.state, network: [], droppedNetwork: 0 });
        return;
      default: return message satisfies never;
    }
  }

  private captureIdentity() {
    const { tabId, captureId, phase } = this.state;
    return tabId && captureId && phase === 'capturing'
      ? { tabId, captureId, requestId: String(++this.sequence) } : null;
  }

  private startCapture(): void {
    const tabId = this.state.tabId;
    if (!tabId) return;
    const requestId = String(++this.sequence);
    const timer = setTimeout(() => {
      if (this.starting?.requestId !== requestId) return;
      this.stopCapture();
      this.setError('TIMEOUT');
    }, 10_000);
    this.starting = { requestId, timer };
    this.publish({ ...this.state, phase: 'starting' });
    if (!this.send({ type: 'inspectorStart', tabId, requestId })) {
      this.stopCapture();
      this.setError('UNAVAILABLE');
    }
  }

  private stopCapture(): void {
    const { tabId, captureId } = this.state;
    if (tabId && (captureId || this.starting)) this.send({
      type: 'inspectorStop', tabId, requestId: String(++this.sequence),
      captureId: captureId ?? undefined,
    });
    if (this.starting) clearTimeout(this.starting.timer);
    this.starting = null;
    this.clearing.clear();
    this.invalidateRequests();
    this.clientDropped = { console: 0, network: 0 };
  }

  private setError(code: SurfaceInspectorErrorCode): void {
    this.publish({ ...this.state, phase: 'error', errorCode: code,
      errorMessage: new RemoteSurfaceInspectorError(code).message });
  }

  private publish(state: RemoteSurfaceInspectorState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
