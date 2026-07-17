export const CURRENT_LAYOUT_VERSION = 1

const MAX_LEAF_GROUPS = 6

export type TabGroupLeaf = { kind: "group"; id: string; tileIds: string[]; activeTileId: string }
export type SplitDirection = "horizontal" | "vertical"
export type SplitBranch = { kind: "split"; direction: SplitDirection; children: SplitNode[]; sizes: number[] }
export type SplitNode = TabGroupLeaf | SplitBranch
export type PanelLayout = { version: number; root: SplitNode; focusedGroupId: string }
export type SplitAnchor = "left" | "right" | "top" | "bottom"

export class InvalidSplitTreeError extends Error {
  readonly name = "InvalidSplitTreeError"

  constructor(readonly reason: string) {
    super(`Invalid split tree: ${reason}`)
  }
}

const assertNever = (value: never): never => {
  throw new InvalidSplitTreeError(`unexpected variant ${JSON.stringify(value)}`)
}

const first = <T>(values: T[], reason: string): T => {
  const value = values[0]
  if (value === undefined) throw new InvalidSplitTreeError(reason)
  return value
}

const leafList = (node: SplitNode): TabGroupLeaf[] => {
  switch (node.kind) {
    case "group":
      return [node]
    case "split":
      return node.children.flatMap(leafList)
    default:
      return assertNever(node)
  }
}

const mapNode = (node: SplitNode, mapLeaf: (leaf: TabGroupLeaf) => TabGroupLeaf): SplitNode => {
  switch (node.kind) {
    case "group":
      return mapLeaf(node)
    case "split": {
      let changed = false
      const children = node.children.map((child) => {
        const next = mapNode(child, mapLeaf)
        if (next !== child) changed = true
        return next
      })
      return changed ? { ...node, children } : node
    }
    default:
      return assertNever(node)
  }
}

const transformNode = (node: SplitNode, transformLeaf: (leaf: TabGroupLeaf) => TabGroupLeaf | null): SplitNode | null => {
  switch (node.kind) {
    case "group":
      return transformLeaf(node)
    case "split": {
      let changed = false
      const children = node.children
        .map((child) => {
          const next = transformNode(child, transformLeaf)
          if (next !== child) changed = true
          return next
        })
        .filter((child): child is SplitNode => child !== null)
      if (children.length === 0) return null
      if (children.length === 1) return first(children, "collapsed split has no child")
      if (!changed) return node
      return { ...node, children, sizes: normalizeSizes(children, node.sizes) }
    }
    default:
      return assertNever(node)
  }
}

const replaceGroup = (node: SplitNode, groupId: string, replacement: SplitNode): SplitNode => {
  switch (node.kind) {
    case "group":
      return node.id === groupId ? replacement : node
    case "split": {
      let changed = false
      const children = node.children.map((child) => {
        const next = replaceGroup(child, groupId, replacement)
        if (next !== child) changed = true
        return next
      })
      return changed ? { ...node, children } : node
    }
    default:
      return assertNever(node)
  }
}

const findTileGroup = (layout: PanelLayout, tileId: string): TabGroupLeaf | undefined =>
  leafList(layout.root).find((leaf) => leaf.tileIds.includes(tileId))

const nextGroupId = (layout: PanelLayout): string => {
  const ids = new Set(leafList(layout.root).map((leaf) => leaf.id))
  for (let index = 1; ; index += 1) {
    const candidate = `group-${index}`
    if (!ids.has(candidate)) return candidate
  }
}

const withValidFocus = (layout: PanelLayout, root: SplitNode, preferredFocus?: string): PanelLayout => {
  const groups = leafList(root)
  const focusedGroupId = preferredFocus && groups.some((leaf) => leaf.id === preferredFocus)
    ? preferredFocus
    : groups.some((leaf) => leaf.id === layout.focusedGroupId)
      ? layout.focusedGroupId
      : first(groups, "layout has no groups").id
  return { ...layout, root, focusedGroupId }
}

const removeTile = (layout: PanelLayout, tileId: string): PanelLayout | null => {
  const root = transformNode(layout.root, (leaf) => {
    const index = leaf.tileIds.indexOf(tileId)
    if (index < 0) return leaf
    const tileIds = leaf.tileIds.filter((id) => id !== tileId)
    if (tileIds.length === 0) return null
    const activeTileId = leaf.activeTileId === tileId
      ? tileIds[Math.min(index, tileIds.length - 1)]
      : leaf.activeTileId
    if (activeTileId === undefined) throw new InvalidSplitTreeError("group lost active tile")
    return { ...leaf, tileIds, activeTileId }
  })
  return root ? withValidFocus(layout, root) : null
}

const normalizeSizes = (children: SplitNode[], sizes?: number[]): number[] => {
  if (children.length === 0) return []
  const valid = sizes?.length === children.length && sizes.every((size) => Number.isFinite(size) && size > 0)
  if (!valid || !sizes) return children.map(() => 1 / children.length)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  return sizes.map((size) => size / total)
}

export const createSingleGroup = (tileIds: string[], activeTileId: string): PanelLayout => {
  if (tileIds.length === 0) throw new InvalidSplitTreeError("single group needs tiles")
  if (!tileIds.includes(activeTileId)) throw new InvalidSplitTreeError("active tile is absent")
  const root: TabGroupLeaf = { kind: "group", id: "group-1", tileIds: [...tileIds], activeTileId }
  return { version: CURRENT_LAYOUT_VERSION, root, focusedGroupId: root.id }
}

export const moveTileToGroup = (layout: PanelLayout, tileId: string, targetGroupId: string, index?: number): PanelLayout => {
  const source = findTileGroup(layout, tileId)
  const target = leafList(layout.root).find((leaf) => leaf.id === targetGroupId)
  if (!source || !target) return layout
  const removed = removeTile(layout, tileId)
  if (!removed) return layout
  const currentTarget = leafList(removed.root).find((leaf) => leaf.id === targetGroupId)
  if (!currentTarget) return layout
  const insertionIndex = Math.max(0, Math.min(index ?? currentTarget.tileIds.length, currentTarget.tileIds.length))
  const tileIds = [...currentTarget.tileIds]
  tileIds.splice(insertionIndex, 0, tileId)
  const root = mapNode(removed.root, (leaf) => leaf.id === targetGroupId ? { ...leaf, tileIds, activeTileId: tileId } : leaf)
  return withValidFocus(removed, root, targetGroupId)
}

export const splitLeaf = (layout: PanelLayout, groupId: string, tileId: string, anchor: SplitAnchor): PanelLayout => {
  const source = findTileGroup(layout, tileId)
  const target = leafList(layout.root).find((leaf) => leaf.id === groupId)
  if (!source || !target || (source.id === target.id && source.tileIds.length === 1)) return layout
  if (leafList(layout.root).length >= MAX_LEAF_GROUPS) return moveTileToGroup(layout, tileId, groupId)

  const removed = removeTile(layout, tileId)
  if (!removed) return layout
  const currentTarget = leafList(removed.root).find((leaf) => leaf.id === groupId)
  if (!currentTarget) return layout
  const newGroup: TabGroupLeaf = { kind: "group", id: nextGroupId(layout), tileIds: [tileId], activeTileId: tileId }
  const before = anchor === "left" || anchor === "top"
  const direction: SplitDirection = anchor === "left" || anchor === "right" ? "horizontal" : "vertical"
  const children = before ? [newGroup, currentTarget] : [currentTarget, newGroup]
  const replacement: SplitBranch = { kind: "split", direction, children, sizes: normalizeSizes(children) }
  const root = replaceGroup(removed.root, groupId, replacement)
  return withValidFocus(removed, root, newGroup.id)
}

export const reorderWithinGroup = (layout: PanelLayout, groupId: string, tileId: string, overTileId: string): PanelLayout => {
  const group = leafList(layout.root).find((leaf) => leaf.id === groupId)
  if (!group) return layout
  const from = group.tileIds.indexOf(tileId)
  const to = group.tileIds.indexOf(overTileId)
  if (from < 0 || to < 0 || from === to) return layout
  const tileIds = [...group.tileIds]
  const removed = tileIds.splice(from, 1)[0]
  if (removed === undefined) throw new InvalidSplitTreeError("reorder lost tile")
  tileIds.splice(to, 0, removed)
  return { ...layout, root: mapNode(layout.root, (leaf) => leaf.id === groupId ? { ...leaf, tileIds } : leaf) }
}

export const setActiveTile = (layout: PanelLayout, tileId: string): PanelLayout => {
  const owner = findTileGroup(layout, tileId)
  if (!owner || owner.activeTileId === tileId) return layout
  return { ...layout, root: mapNode(layout.root, (leaf) => leaf.id === owner.id ? { ...leaf, activeTileId: tileId } : leaf) }
}

export const setFocusedGroup = (layout: PanelLayout, groupId: string): PanelLayout => {
  if (layout.focusedGroupId === groupId || !leafList(layout.root).some((leaf) => leaf.id === groupId)) return layout
  return { ...layout, focusedGroupId: groupId }
}

export const closeTile = (layout: PanelLayout, tileId: string): PanelLayout | null =>
  findTileGroup(layout, tileId) ? removeTile(layout, tileId) : layout

export const focusedGroupLeaf = (layout: PanelLayout): TabGroupLeaf | undefined =>
  leafList(layout.root).find((leaf) => leaf.id === layout.focusedGroupId)

export const pruneMissingLeaves = (layout: PanelLayout, missingTileIds: string[]): PanelLayout | null => {
  const missing = new Set(missingTileIds)
  let result: PanelLayout | null = layout
  for (const tileId of missing) {
    if (result) result = removeTile(result, tileId)
  }
  return result
}

export const syncLayoutWithTabs = (layout: PanelLayout, tabIds: string[], focusedGroupId?: string): PanelLayout => {
  const allowed = new Set(tabIds)
  const stale = leafList(layout.root).flatMap((leaf) => leaf.tileIds).filter((tileId) => !allowed.has(tileId))
  const pruned = pruneMissingLeaves(layout, stale)
  if (!pruned) return createSingleGroup(tabIds, first(tabIds, "sync needs at least one tab"))
  const focus = focusedGroupId && leafList(pruned.root).some((leaf) => leaf.id === focusedGroupId)
    ? focusedGroupId
    : pruned.focusedGroupId
  const existing = new Set(leafList(pruned.root).flatMap((leaf) => leaf.tileIds))
  const additions = tabIds.filter((tileId) => !existing.has(tileId))
  if (additions.length === 0) return focus === pruned.focusedGroupId ? pruned : { ...pruned, focusedGroupId: focus }
  const root = mapNode(pruned.root, (leaf) => leaf.id === focus
    ? { ...leaf, tileIds: [...leaf.tileIds, ...additions] }
    : leaf)
  return { ...pruned, root, focusedGroupId: focus }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null

const parseNode = (raw: unknown): SplitNode | null => {
  if (!isRecord(raw) || typeof raw.kind !== "string") return null
  switch (raw.kind) {
    case "group": {
      const tileIds = parseStringArray(raw.tileIds)
      if (typeof raw.id !== "string" || !tileIds || tileIds.length === 0 || typeof raw.activeTileId !== "string" || !tileIds.includes(raw.activeTileId)) return null
      return { kind: "group", id: raw.id, tileIds, activeTileId: raw.activeTileId }
    }
    case "split": {
      if ((raw.direction !== "horizontal" && raw.direction !== "vertical") || !Array.isArray(raw.children) || raw.children.length !== 2) return null
      const children = raw.children.map(parseNode)
      if (children.some((child) => child === null)) return null
      const parsedChildren = children.filter((child): child is SplitNode => child !== null)
      const sizes = Array.isArray(raw.sizes) && raw.sizes.every((size) => typeof size === "number") ? raw.sizes : undefined
      return { kind: "split", direction: raw.direction, children: parsedChildren, sizes: normalizeSizes(parsedChildren, sizes) }
    }
    default:
      return null
  }
}

const parseLayout = (raw: unknown): PanelLayout | null => {
  if (!isRecord(raw) || raw.version !== CURRENT_LAYOUT_VERSION || typeof raw.focusedGroupId !== "string") return null
  const root = parseNode(raw.root)
  if (!root) return null
  const groups = leafList(root)
  const groupIds = groups.map((leaf) => leaf.id)
  const tileIds = groups.flatMap((leaf) => leaf.tileIds)
  if (new Set(groupIds).size !== groupIds.length || new Set(tileIds).size !== tileIds.length || !groupIds.includes(raw.focusedGroupId)) return null
  return { version: CURRENT_LAYOUT_VERSION, root, focusedGroupId: raw.focusedGroupId }
}

export const migrate = (raw: unknown, tabIds: string[]): PanelLayout => {
  const fallback = (): PanelLayout => createSingleGroup(tabIds, first(tabIds, "migration needs at least one tab"))
  const parsed = parseLayout(raw)
  if (!parsed) return fallback()
  return syncLayoutWithTabs(parsed, tabIds)
}

export const serialize = (layout: PanelLayout): string => JSON.stringify(layout)

export const deserialize = (raw: string): PanelLayout | null => {
  try {
    return parseLayout(JSON.parse(raw))
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}
