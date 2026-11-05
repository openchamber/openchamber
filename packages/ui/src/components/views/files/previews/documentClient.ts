import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import type {
  BookOpened, CellNote, CellPatch, DocumentCalls, DocumentChunk, DocumentRequest, DocumentResponse, DocumentResult, SheetLayout,
} from './documentProtocol';
import type { CellInput, CellRestore } from './workbook/workbookSession';
import type { StructureChange } from './workbook/model';

/**
 * The way to the code that parses documents. A big workbook takes seconds to
 * read, and every edit reads it again to prove the write, so that runs in a
 * worker and the app stays live. Where no worker starts it runs here instead.
 */
type Transport = <Op extends keyof DocumentCalls>(
  op: Op,
  args: DocumentCalls[Op]['args'],
  onChunk?: (chunk: DocumentCalls[Op]['chunk']) => void,
) => Promise<DocumentCalls[Op]['result']>;

const WORKER_START_MS = 10_000;

const localTransport: Transport = async (op, args, onChunk) => {
  const { handleDocumentCall } = await import('./documentHost');
  return handleDocumentCall(op, args, (chunk) => onChunk?.(chunk));
};

type Pending = { resolve: (value: DocumentResult) => void; reject: (error: Error) => void; onChunk?: (chunk: DocumentChunk) => void };

const startWorker = (onDeath: () => void): Promise<Transport | null> => new Promise((settle) => {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let dead = false;
  const worker = new Worker(new URL('./document.worker.ts', import.meta.url), { type: 'module', name: 'documents' });
  const send = (request: Omit<DocumentRequest, 'id'>, onChunk?: (chunk: DocumentChunk) => void) => new Promise<DocumentResult>((resolve, reject) => {
    if (dead) {
      reject(new Error('The document worker stopped'));
      return;
    }
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject, onChunk });
    worker.postMessage({ id, ...request } satisfies DocumentRequest);
  });
  // SAFETY: the host answers each op with its own types, which the pending map forgets.
  const call = ((op, args, onChunk) => send({ op, args }, onChunk as (chunk: DocumentChunk) => void)) as Transport;
  const timer = setTimeout(() => settle(null), WORKER_START_MS);
  worker.addEventListener('message', (event: MessageEvent<DocumentResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === 'chunk') {
      entry.onChunk?.(message.value);
      return;
    }
    pending.delete(message.id);
    if (message.type === 'done') entry.resolve(message.value);
    else entry.reject(new Error(message.message));
  });
  worker.addEventListener('error', () => {
    clearTimeout(timer);
    dead = true;
    worker.terminate();
    for (const entry of pending.values()) entry.reject(new Error('The document worker stopped'));
    pending.clear();
    onDeath();
    settle(null);
  });
  void call('ping', null).then(() => {
    clearTimeout(timer);
    settle(call);
  }, () => undefined);
});

let transport: Promise<Transport> | null = null;

export const documentTransport = (): Promise<Transport> => {
  transport ??= (async () => {
    // Bun's test runtime has no bundler for the worker, and a webview cannot load it from its origin.
    if ('Bun' in globalThis || !('Worker' in globalThis) || isVSCodeRuntime(null)) return localTransport;
    try {
      return await startWorker(() => { transport = null; }) ?? localTransport;
    } catch {
      return localTransport;
    }
  })();
  return transport;
};

let nextName = 1;
export const newDocumentId = (): string => {
  nextName += 1;
  return `document-${nextName}`;
};

/** A sheet as the grid draws it, with what is held about its cells. */
export type SheetView = SheetLayout & { sheet: number; rows: string[][]; notes: Map<string, CellNote>; lockedCells: Set<string> };

/** Applies changed cells; null when one falls outside the grid or on its spare edge, which then has to grow. */
export const patchSheetView = (view: SheetView, patches: CellPatch[], allowEdge = false): SheetView | null => {
  const index = new Map(view.rowNumbers.map((row, rowIndex) => [row, rowIndex]));
  const rows = view.rows.slice();
  const copied = new Set<number>();
  for (const { sheet: target, row, column, display, note } of patches) {
    if (target !== view.sheet) continue;
    const rowIndex = index.get(row);
    if (rowIndex === undefined || column >= view.columnCount) return null;
    if (!allowEdge && (rowIndex === rows.length - 1 || column === view.columnCount - 1)) return null;
    if (!copied.has(rowIndex)) {
      rows[rowIndex] = rows[rowIndex].slice();
      copied.add(rowIndex);
    }
    rows[rowIndex][column] = display;
    const key = `${row}:${column}`;
    if (note) view.notes.set(key, note);
    else view.notes.delete(key);
  }
  return { ...view, rows };
};

/** One open workbook behind the transport. */
export class WorkbookBook {
  constructor(
    private readonly call: Transport,
    private readonly id: string,
    readonly opened: BookOpened,
  ) {}

  async layout(sheet: number, editable: boolean): Promise<SheetView> {
    const rows: string[][] = [];
    const notes = new Map<string, CellNote>();
    const layout = await this.call('workbook.layout', { book: this.id, sheet, editable }, (chunk) => {
      for (const row of chunk.rows) rows.push(row);
      for (const [key, note] of chunk.notes) notes.set(key, note);
    });
    return { ...layout, sheet, rows, notes, lockedCells: new Set(layout.locked) };
  }

  edit(sheet: number, cells: CellInput[]) {
    return this.call('workbook.edit', { book: this.id, sheet, cells });
  }

  restore(sheet: number, cells: CellRestore[]) {
    return this.call('workbook.restore', { book: this.id, sheet, cells });
  }

  restructure(change: StructureChange) {
    return this.call('workbook.restructure', { book: this.id, change });
  }

  restoreBytes(bytes: Uint8Array<ArrayBuffer>) {
    return this.call('workbook.restoreBytes', { book: this.id, bytes });
  }

  seen(keys: string[]) {
    return this.call('workbook.seen', { book: this.id, keys });
  }

  close(): void {
    void this.call('workbook.close', { book: this.id });
  }
}

export const openWorkbook = async (path: string, name: string, bytes: Uint8Array<ArrayBuffer>): Promise<WorkbookBook | null> => {
  const call = await documentTransport();
  const id = newDocumentId();
  const opened = await call('workbook.open', { book: id, path, name, bytes });
  return opened ? new WorkbookBook(call, id, opened) : null;
};

/** Rows that arrive in pieces, so reading them never stops the app. */
export const collectRows = () => {
  const rows: string[][] = [];
  return {
    rows,
    add: (chunk: { rows: string[][] }) => {
      for (const row of chunk.rows) rows.push(row);
    },
  };
};
