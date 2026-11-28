import type { TrackerContainer } from './types';

export type TrackerContainerRow = { container: TrackerContainer; depth: number };

export function trackerContainerRows(containers: readonly TrackerContainer[]): TrackerContainerRow[] {
  const byId = new Map(containers.map((container) => [container.id, container]));
  const children = new Map<string, TrackerContainer[]>();
  const roots: TrackerContainer[] = [];
  for (const container of containers) {
    const parentId = container.parent?.id;
    if (parentId && parentId !== container.id && byId.has(parentId)) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(container);
      children.set(parentId, siblings);
    } else {
      roots.push(container);
    }
  }
  const rows: TrackerContainerRow[] = [];
  const seen = new Set<string>();
  const visit = (container: TrackerContainer, depth: number) => {
    if (seen.has(container.id)) return;
    seen.add(container.id);
    rows.push({ container, depth });
    for (const child of children.get(container.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const container of containers) visit(container, 0);
  return rows;
}
