/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adapted from VS Code's SCM history graph model:
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/browser/scmHistory.ts
// https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/scm/common/history.ts

import type { GitHistoryItem, GitHistoryRef } from '@/lib/api/types';

const SCMIncomingHistoryItemId = 'scm-graph-incoming-changes';
const SCMOutgoingHistoryItemId = 'scm-graph-outgoing-changes';

export const historyItemRefColor = 'var(--status-info)';
export const historyItemRemoteRefColor = 'var(--chart-5)';
export const historyItemBaseRefColor = 'var(--status-warning)';

const colorRegistry = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export type { GitHistoryItem, GitHistoryRef };

export type GitHistoryGraphRef = GitHistoryRef & { color?: string };
export type GitHistoryGraphItem = GitHistoryItem & {
  displayId?: string;
  references?: GitHistoryGraphRef[];
};

export interface GitHistoryGraphNode { id: string; color: string }

export interface GitHistoryItemViewModel {
  historyItem: GitHistoryGraphItem;
  inputSwimlanes: GitHistoryGraphNode[];
  outputSwimlanes: GitHistoryGraphNode[];
  kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes';
}

function cloneNode(node: GitHistoryGraphNode): GitHistoryGraphNode {
  return { ...node };
}

function rotate(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) {
      return index;
    }
  }

  return -1;
}

function findLastNodeIndex(nodes: readonly GitHistoryGraphNode[], id: string): number {
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].id === id) {
      return index;
    }
  }

  return -1;
}

function getLabelColor(
  historyItem: GitHistoryItem | GitHistoryGraphItem,
  colorMap: Map<string, string | undefined>,
): string | undefined {
  if (historyItem.id === SCMIncomingHistoryItemId) {
    return historyItemRemoteRefColor;
  }

  if (historyItem.id === SCMOutgoingHistoryItemId) {
    return historyItemRefColor;
  }

  for (const ref of historyItem.references ?? []) {
    const color = colorMap.get(ref.id);
    if (color !== undefined) {
      return color;
    }
  }

  return undefined;
}

function compareGitHistoryRefs(
  ref1: GitHistoryGraphRef,
  ref2: GitHistoryGraphRef,
  current?: GitHistoryRef | null,
  upstream?: GitHistoryRef | null,
  base?: GitHistoryRef | null,
): number {
  const orderOf = (ref: GitHistoryGraphRef): number => {
    if (ref.id === current?.id) return 1;
    if (ref.id === upstream?.id) return 2;
    if (ref.id === base?.id) return 3;
    if (ref.color !== undefined) return 4;
    return 99;
  };

  return orderOf(ref1) - orderOf(ref2);
}

function addIncomingOutgoingChangesHistoryItems(
  viewModels: GitHistoryItemViewModel[],
  current: GitHistoryRef | null,
  upstream: GitHistoryRef | null,
  addIncomingChanges: boolean,
  addOutgoingChanges: boolean,
  mergeBase: string | null,
): void {
  if (current?.revision === upstream?.revision || !mergeBase) {
    return;
  }

  if (addIncomingChanges && upstream?.revision && upstream.revision !== mergeBase) {
    const beforeHistoryItemIndex = findLastIndex(
      viewModels,
      (viewModel) => viewModel.outputSwimlanes.some((node) => node.id === mergeBase),
    );
    const afterHistoryItemIndex = viewModels.findIndex((viewModel) => viewModel.historyItem.id === mergeBase);

    if (beforeHistoryItemIndex !== -1 && afterHistoryItemIndex !== -1) {
      const incomingChangeMerged =
        viewModels[beforeHistoryItemIndex].historyItem.parentIds.length === 2 &&
        viewModels[beforeHistoryItemIndex].historyItem.parentIds.includes(mergeBase);

      if (!incomingChangeMerged) {
        viewModels[beforeHistoryItemIndex] = {
          ...viewModels[beforeHistoryItemIndex],
          inputSwimlanes: viewModels[beforeHistoryItemIndex].inputSwimlanes.map((node) => (
            node.id === mergeBase && node.color === historyItemRemoteRefColor
              ? { ...node, id: SCMIncomingHistoryItemId }
              : node
          )),
          outputSwimlanes: viewModels[beforeHistoryItemIndex].outputSwimlanes.map((node) => (
            node.id === mergeBase && node.color === historyItemRemoteRefColor
              ? { ...node, id: SCMIncomingHistoryItemId }
              : node
          )),
        };

        const inputSwimlanes = viewModels[beforeHistoryItemIndex].outputSwimlanes.map(cloneNode);
        const outputSwimlanes = viewModels[afterHistoryItemIndex].inputSwimlanes.map(cloneNode);
        const displayIdLength = viewModels[0]?.historyItem.displayId?.length ?? 0;

        viewModels.splice(afterHistoryItemIndex, 0, {
          historyItem: {
            id: SCMIncomingHistoryItemId,
            displayId: displayIdLength > 0 ? '0'.repeat(displayIdLength) : undefined,
            parentIds: [mergeBase],
            author: upstream.name,
            authorEmail: '',
            subject: '',
            message: '',
            timestamp: '',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          },
          kind: 'incoming-changes',
          inputSwimlanes,
          outputSwimlanes,
        });
      }
    }
  }

  if (addOutgoingChanges && current?.revision && current.revision !== mergeBase) {
    const currentIndex = viewModels.findIndex(
      (viewModel) => viewModel.kind === 'HEAD' && viewModel.historyItem.id === current.revision,
    );

    if (currentIndex !== -1) {
      const inputSwimlanes = viewModels[currentIndex].inputSwimlanes.map(cloneNode);
      const outputSwimlanes = inputSwimlanes.concat({
        id: current.revision,
        color: historyItemRefColor,
      });
      const displayIdLength = viewModels[0]?.historyItem.displayId?.length ?? 0;

      viewModels.splice(currentIndex, 0, {
          historyItem: {
            id: SCMOutgoingHistoryItemId,
            displayId: displayIdLength > 0 ? '0'.repeat(displayIdLength) : undefined,
            parentIds: [current.revision],
            author: current.name,
            authorEmail: '',
            subject: '',
            message: '',
            timestamp: '',
            statistics: { files: 0, insertions: 0, deletions: 0 },
            references: [],
          },
        kind: 'outgoing-changes',
        inputSwimlanes,
        outputSwimlanes,
      });

      viewModels[currentIndex + 1].inputSwimlanes.push({
        id: current.revision,
        color: historyItemRefColor,
      });
    }
  }
}

export function buildGitHistoryViewModels(
  items: GitHistoryItem[],
  refs: {
    current: GitHistoryRef | null;
    upstream: GitHistoryRef | null;
    base: GitHistoryRef | null;
  },
  options: { showIncoming: boolean; showOutgoing: boolean; mergeBase: string | null },
): GitHistoryItemViewModel[] {
  let colorIndex = -1;
  const viewModels: GitHistoryItemViewModel[] = [];
  const colorMap = new Map<string, string | undefined>();

  if (refs.current) colorMap.set(refs.current.id, historyItemRefColor);
  if (refs.upstream) colorMap.set(refs.upstream.id, historyItemRemoteRefColor);
  if (refs.base) colorMap.set(refs.base.id, historyItemBaseRefColor);

  for (const historyItem of items) {
    const graphHistoryItem: GitHistoryGraphItem = {
      ...historyItem,
      displayId: historyItem.id.slice(0, 8),
    };
    const kind = historyItem.id === refs.current?.revision ? 'HEAD' : 'node';
    const inputSwimlanes = (viewModels.at(-1)?.outputSwimlanes ?? []).map(cloneNode);
    const outputSwimlanes: GitHistoryGraphNode[] = [];
    let firstParentAdded = false;

    if (graphHistoryItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === graphHistoryItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: graphHistoryItem.parentIds[0],
              color: getLabelColor(graphHistoryItem, colorMap) ?? node.color,
            });
            firstParentAdded = true;
          }
          continue;
        }

        outputSwimlanes.push(cloneNode(node));
      }
    }

    for (let index = firstParentAdded ? 1 : 0; index < graphHistoryItem.parentIds.length; index++) {
      let color = index === 0 ? getLabelColor(graphHistoryItem, colorMap) : undefined;

      if (index > 0) {
        const parentItem = items.find((candidate) => candidate.id === graphHistoryItem.parentIds[index]);
        color = parentItem ? getLabelColor(parentItem, colorMap) : undefined;
      }

      if (!color) {
        colorIndex = rotate(colorIndex + 1, colorRegistry.length);
        color = colorRegistry[colorIndex];
      }

      outputSwimlanes.push({
        id: graphHistoryItem.parentIds[index],
        color,
      });
    }

    const references = (graphHistoryItem.references ?? []).map((ref) => {
      let color = colorMap.get(ref.id);
      if (colorMap.has(ref.id) && color === undefined) {
        const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);
        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
        color = outputSwimlanes[circleIndex]?.color
          ?? inputSwimlanes[circleIndex]?.color
          ?? historyItemRefColor;
      }

      return {
        ...ref,
        color,
      };
    });

    references.sort((ref1, ref2) => compareGitHistoryRefs(ref1, ref2, refs.current, refs.upstream, refs.base));

    viewModels.push({
      historyItem: {
        ...graphHistoryItem,
        references,
      },
      kind,
      inputSwimlanes,
      outputSwimlanes,
    });
  }

  addIncomingOutgoingChangesHistoryItems(
    viewModels,
    refs.current,
    refs.upstream,
    options.showIncoming,
    options.showOutgoing,
    options.mergeBase,
  );

  return viewModels;
}

export function getHistoryItemColumn(viewModel: GitHistoryItemViewModel): number {
  const inputIndex = viewModel.inputSwimlanes.findIndex((node) => node.id === viewModel.historyItem.id);
  return inputIndex !== -1 ? inputIndex : viewModel.inputSwimlanes.length;
}

export function getHistoryItemMaxColumns(viewModel: GitHistoryItemViewModel): number {
  return Math.max(viewModel.inputSwimlanes.length, viewModel.outputSwimlanes.length, getHistoryItemColumn(viewModel) + 1, 1);
}

export function getHistoryItemSecondaryParentColumns(viewModel: GitHistoryItemViewModel): number[] {
  const secondaryParentColumns: number[] = [];

  for (let index = 1; index < viewModel.historyItem.parentIds.length; index++) {
    const column = findLastNodeIndex(viewModel.outputSwimlanes, viewModel.historyItem.parentIds[index]);
    if (column !== -1) {
      secondaryParentColumns.push(column);
    }
  }

  return secondaryParentColumns;
}
