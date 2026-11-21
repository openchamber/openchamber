import * as React from 'react';

const MAX_KEYS = 200;

const offsets = new Map<string, number>();

const writeOffset = (memory: Map<string, number>, key: string, top: number) => {
  memory.delete(key);
  memory.set(key, top);
  if (memory.size > MAX_KEYS) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
};

const readOffset = (memory: Map<string, number>, key: string) => {
  const top = memory.get(key);
  if (top === undefined) return 0;
  writeOffset(memory, key, top);
  return top;
};

export const savedListScrollOffset = (key: string | null | undefined): number => (key ? offsets.get(key) ?? 0 : 0);

type ListScrollMemoryOptions = {
  ready?: boolean;
  memory?: Map<string, number>;
};

export function useListScrollMemory(
  key: string | null | undefined,
  { ready = true, memory = offsets }: ListScrollMemoryOptions = {},
): React.RefCallback<HTMLElement> {
  const scroller = React.useRef<HTMLElement | null>(null);
  const currentKey = React.useRef<string | null>(key ?? null);
  const readyRef = React.useRef(ready);
  const restored = React.useRef<{ node: HTMLElement; key: string | null } | null>(null);

  const remember = React.useCallback(() => {
    const node = scroller.current;
    const current = currentKey.current;
    if (!node || current === null || !readyRef.current) return;
    writeOffset(memory, current, node.scrollTop);
  }, [memory]);

  const records = key !== undefined && key !== null;
  const bind = React.useCallback((node: HTMLElement | null) => {
    if (scroller.current === node) return;
    scroller.current?.removeEventListener('scroll', remember);
    scroller.current = node;
    if (records) node?.addEventListener('scroll', remember, { passive: true });
  }, [remember, records]);

  React.useLayoutEffect(() => {
    currentKey.current = key ?? null;
    readyRef.current = ready;
    if (key === undefined) return;
    const node = scroller.current;
    if (!node) return;
    const settled = restored.current?.node === node && restored.current.key === key;
    if (settled) return;
    if (key === null) {
      node.scrollTop = 0;
    } else if (ready) {
      node.scrollTop = readOffset(memory, key);
    } else {
      return;
    }
    restored.current = { node, key };
  }, [key, ready, memory]);

  return bind;
}
