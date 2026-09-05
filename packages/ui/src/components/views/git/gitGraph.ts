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

const colorRegistry = [
  'var(--git-graph-1)',
  'var(--git-graph-2)',
  'var(--git-graph-3)',
  'var(--git-graph-4)',
  'var(--git-graph-5)',
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
  nodeColor: string;
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

function hashGraphIdentity(identity: string): number {
  let hash = 2166136261;

  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function getIdentityRef(
  historyItem: GitHistoryItem | GitHistoryGraphItem,
): GitHistoryRef | GitHistoryGraphRef | undefined {
  const nonTagRefs = (historyItem.references ?? []).filter((ref) => ref.category !== 'tags');
  return nonTagRefs.find((ref) => ref.id.startsWith('refs/')) ?? nonTagRefs[0];
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
  currentColor: string | undefined,
  upstreamColor: string | undefined,
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
            node.id === mergeBase && node.color === upstreamColor
              ? { ...node, id: SCMIncomingHistoryItemId }
              : node
          )),
          outputSwimlanes: viewModels[beforeHistoryItemIndex].outputSwimlanes.map((node) => (
            node.id === mergeBase && node.color === upstreamColor
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
          nodeColor: upstreamColor ?? colorRegistry[0],
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
        color: currentColor ?? colorRegistry[0],
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
        nodeColor: currentColor ?? colorRegistry[0],
      });

      viewModels[currentIndex + 1].inputSwimlanes.push({
        id: current.revision,
        color: currentColor ?? colorRegistry[0],
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
  const viewModels: GitHistoryItemViewModel[] = [];
  const colorsByIdentity = new Map<string, string>();
  const colorMap = new Map<string, string | undefined>();

  const assignColor = (identity: string, unavailableColors: readonly string[] = []): string => {
    const existingColor = colorsByIdentity.get(identity);
    if (existingColor) {
      return existingColor;
    }

    const preferredIndex = hashGraphIdentity(identity) % colorRegistry.length;
    let color = colorRegistry[preferredIndex];
    const unavailable = new Set(unavailableColors);

    if (unavailable.size < colorRegistry.length) {
      for (let index = 0; index < colorRegistry.length; index++) {
        const candidate = colorRegistry[rotate(preferredIndex + index, colorRegistry.length)];
        if (!unavailable.has(candidate)) {
          color = candidate;
          break;
        }
      }
    }

    colorsByIdentity.set(identity, color);
    return color;
  };

  const currentColor = refs.current
    ? assignColor(refs.current.id)
    : undefined;
  const upstreamColor = refs.upstream
    ? assignColor(refs.upstream.id, currentColor ? [currentColor] : [])
    : undefined;
  const baseColor = refs.base
    ? assignColor(refs.base.id, [currentColor, upstreamColor].filter((color): color is string => Boolean(color)))
    : undefined;

  if (refs.current) colorMap.set(refs.current.id, currentColor);
  if (refs.upstream) colorMap.set(refs.upstream.id, upstreamColor);
  if (refs.base) colorMap.set(refs.base.id, baseColor);

  const getOrAssignLabelColor = (
    historyItem: GitHistoryItem | GitHistoryGraphItem,
    unavailableColors: readonly string[] = [],
  ): string | undefined => {
    const ref = getIdentityRef(historyItem);
    if (!ref) {
      return undefined;
    }

    let color = colorMap.get(ref.id);
    if (color === undefined) {
      color = assignColor(ref.id, unavailableColors);
      colorMap.set(ref.id, color);
    }

    return color;
  };

  for (const historyItem of items) {
    const graphHistoryItem: GitHistoryGraphItem = {
      ...historyItem,
      displayId: historyItem.id.slice(0, 8),
    };
    const kind = historyItem.id === refs.current?.revision ? 'HEAD' : 'node';
    const inputSwimlanes = (viewModels.at(-1)?.outputSwimlanes ?? []).map(cloneNode);
    const outputSwimlanes: GitHistoryGraphNode[] = [];
    let firstParentAdded = false;
    const labelColor = getOrAssignLabelColor(graphHistoryItem, inputSwimlanes.map((node) => node.color));

    if (graphHistoryItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === graphHistoryItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: graphHistoryItem.parentIds[0],
              color: labelColor ?? node.color,
            });
            firstParentAdded = true;
          }
          continue;
        }

        outputSwimlanes.push(cloneNode(node));
      }
    }

    for (let index = firstParentAdded ? 1 : 0; index < graphHistoryItem.parentIds.length; index++) {
      let color = index === 0 ? labelColor : undefined;

      if (index > 0) {
        const parentItem = items.find((candidate) => candidate.id === graphHistoryItem.parentIds[index]);
        color = parentItem ? getOrAssignLabelColor(parentItem, outputSwimlanes.map((node) => node.color)) : undefined;
      }

      if (!color) {
        color = assignColor(graphHistoryItem.parentIds[index], outputSwimlanes.map((node) => node.color));
      }

      outputSwimlanes.push({
        id: graphHistoryItem.parentIds[index],
        color,
      });
    }

    const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id);
    const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
    const nodeColor = labelColor
      ?? outputSwimlanes[circleIndex]?.color
      ?? inputSwimlanes[circleIndex]?.color
      ?? assignColor(graphHistoryItem.id, inputSwimlanes.map((node) => node.color));

    const badgeColors: string[] = [];
    const references = (graphHistoryItem.references ?? []).map((ref) => {
      let color = colorMap.get(ref.id);
      if (ref.category !== 'tags' && color === undefined) {
        color = getOrAssignLabelColor(
          { ...graphHistoryItem, references: [ref] },
          inputSwimlanes.map((node) => node.color)
            .concat(outputSwimlanes.map((node) => node.color), badgeColors),
        );
      }

      if (color !== undefined) {
        badgeColors.push(color);
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
      nodeColor,
    });
  }

  addIncomingOutgoingChangesHistoryItems(
    viewModels,
    refs.current,
    refs.upstream,
    currentColor,
    upstreamColor,
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
