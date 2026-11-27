import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { analyzeCogMapGraph, computeCausalCone, serializeCogMapDsl } from './graph';
import { computeCogMapLayout } from './layout';
import type {
  CogMapDirection,
  CogMapEdge,
  CogMapEdgeSign,
  CogMapLadderingIntent,
  CogMapMutationPayload,
  CogMapNode,
  CogMapNodeRole,
  CogMapPacing,
  CognitiveMap,
} from './types';

export interface CognitiveMapCanvasProps {
  title: string;
  mapId?: string;
  rev?: number;
  pacing?: CogMapPacing;
  nodes: readonly CogMapNode[];
  edges: readonly CogMapEdge[];
  focusNodeId?: string | null;
  compact?: boolean;
  height?: number;
  editable?: boolean;
  disabled?: boolean;
  onMutate?: (payload: CogMapMutationPayload) => Promise<void> | void;
  onLadder?: (intent: CogMapLadderingIntent, node: CogMapNode) => Promise<void> | void;
  onExpandToPanel?: () => void;
  onPacingChange?: (pacing: CogMapPacing) => void;
}

type StructuralFilter = 'all' | 'heads' | 'tails' | 'hubs' | 'loops';

const ROLE_META: Record<CogMapNodeRole, { label: string; accent: string; badgeTone: string }> = {
  goal: { label: 'Goal', accent: 'var(--status-success)', badgeTone: 'success' },
  option: { label: 'Option', accent: 'var(--primary-base)', badgeTone: 'info' },
  factor: { label: 'Factor', accent: 'var(--chart-2, var(--status-info))', badgeTone: 'neutral' },
  constraint: { label: 'Constraint', accent: 'var(--status-warning)', badgeTone: 'warning' },
  assumption: { label: 'Assumption', accent: 'var(--chart-4, var(--muted-foreground))', badgeTone: 'neutral' },
};

const ROLE_OPTIONS: readonly CogMapNodeRole[] = ['goal', 'option', 'factor', 'constraint', 'assumption'];
const SIGN_OPTIONS: readonly { value: CogMapEdgeSign; label: string }[] = [
  { value: '+', label: '+ promotes' },
  { value: '-', label: '− inhibits' },
  { value: '?', label: '? uncertain' },
];

function edgeStrokeColor(sign: CogMapEdgeSign): string {
  if (sign === '-') return 'var(--status-error)';
  if (sign === '?') return 'var(--muted-foreground)';
  return 'var(--status-success)';
}

function clampZoom(z: number): number {
  return Math.max(0.2, Math.min(2.5, Math.round(z * 1000) / 1000));
}

const SIGN_MEANING: Record<CogMapEdgeSign, string> = {
  '+': 'promotes / leads to',
  '-': 'inhibits / reduces',
  '?': 'uncertain influence',
};

function signGlyph(sign: CogMapEdgeSign): string {
  return sign === '-' ? '−' : sign;
}

export function CognitiveMapCanvas({
  title,
  mapId = 'm1',
  rev = 1,
  pacing = 'collab',
  nodes,
  edges,
  focusNodeId = null,
  compact = false,
  height = 360,
  editable = false,
  disabled = false,
  onMutate,
  onLadder,
  onExpandToPanel,
  onPacingChange,
}: CognitiveMapCanvasProps) {
  const [direction, setDirection] = React.useState<CogMapDirection>('up');
  const [filter, setFilter] = React.useState<StructuralFilter>('all');
  const [selectedId, setSelectedIdState] = React.useState<string | null>(focusNodeId);
  const [selectedEdgeId, setSelectedEdgeId] = React.useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = React.useState<string | null>(null);
  // Node and edge selection are mutually exclusive: picking one clears the other.
  const setSelectedId = React.useCallback((next: React.SetStateAction<string | null>) => {
    setSelectedEdgeId(null);
    setSelectedIdState(next);
  }, []);
  const selectEdge = React.useCallback((edgeId: string | null) => {
    setSelectedIdState(null);
    setSelectedEdgeId((prev) => (edgeId !== null && prev === edgeId ? null : edgeId));
  }, []);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [dragging, setDragging] = React.useState(false);
  const [copiedDsl, setCopiedDsl] = React.useState(false);
  const [ladderingBusy, setLadderingBusy] = React.useState<CogMapLadderingIntent | null>(null);
  const [sidebarOpen, setSidebarOpen] = React.useState(!compact);

  // Inline editor states for zero-token co-creation.
  const [addFormOpen, setAddFormOpen] = React.useState(false);
  const [newLabel, setNewLabel] = React.useState('');
  const [newPole, setNewPole] = React.useState('');
  const [newRole, setNewRole] = React.useState<CogMapNodeRole>('factor');
  const [newNote, setNewNote] = React.useState('');
  const [newLinkDir, setNewLinkDir] = React.useState<'none' | 'from-selected' | 'to-selected'>('from-selected');
  const [newLinkSign, setNewLinkSign] = React.useState<CogMapEdgeSign>('+');

  const [editingNodeId, setEditingNodeId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState('');
  const [editPole, setEditPole] = React.useState('');
  const [editRole, setEditRole] = React.useState<CogMapNodeRole>('factor');
  const [editNote, setEditNote] = React.useState('');

  const [connectTargetId, setConnectTargetId] = React.useState('');
  const [connectSign, setConnectSign] = React.useState<CogMapEdgeSign>('+');

  const viewportRef = React.useRef<HTMLDivElement>(null);
  const dragOriginRef = React.useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);
  const zoomRef = React.useRef(zoom);
  const panRef = React.useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;
  // Inline (compact) maps live inside the scrolling chat: only take over the wheel after the user
  // clicks into the map, so scrolling past it keeps scrolling the conversation.
  const [wheelArmed, setWheelArmed] = React.useState(!compact);
  const wheelArmedRef = React.useRef(wheelArmed);
  wheelArmedRef.current = wheelArmed;
  const markerPrefix = React.useId().replace(/:/g, '');

  // Keep selected node synced when parent pushes a new focusNodeId.
  const prevFocusRef = React.useRef<string | null>(focusNodeId);
  if (focusNodeId !== prevFocusRef.current) {
    prevFocusRef.current = focusNodeId;
    if (focusNodeId && nodes.some((node) => node.id === focusNodeId)) {
      setSelectedId(focusNodeId);
    }
  }

  const analysis = React.useMemo(() => analyzeCogMapGraph(nodes, edges), [nodes, edges]);
  const layout = React.useMemo(() => computeCogMapLayout(nodes, edges, direction), [nodes, edges, direction]);

  const headSet = React.useMemo(() => new Set(analysis.heads.map((h) => h.id)), [analysis.heads]);
  const tailSet = React.useMemo(() => new Set(analysis.tails.map((t) => t.id)), [analysis.tails]);
  const hubSet = React.useMemo(() => new Set(analysis.hubs.slice(0, 3).map((h) => h.id)), [analysis.hubs]);
  const loopNodeSet = React.useMemo(() => new Set(analysis.loops.flatMap((loop) => loop.nodes)), [analysis.loops]);
  const loopEdgeSet = React.useMemo(() => new Set(analysis.loops.flatMap((loop) => loop.edges)), [analysis.loops]);

  const activeSelectedId = selectedId && nodes.some((node) => node.id === selectedId) ? selectedId : null;
  const selectedEdge = React.useMemo(
    () => (selectedEdgeId ? edges.find((edge) => edge.id === selectedEdgeId) ?? null : null),
    [edges, selectedEdgeId],
  );
  const selectedNode = React.useMemo(
    () => (activeSelectedId ? nodes.find((node) => node.id === activeSelectedId) ?? null : null),
    [activeSelectedId, nodes],
  );

  const causalCone = React.useMemo(
    () => computeCausalCone(nodes, edges, activeSelectedId),
    [nodes, edges, activeSelectedId],
  );

  const searchNeedle = searchQuery.trim().toLowerCase();

  const isNodeHighlighted = React.useCallback(
    (node: CogMapNode): boolean => {
      if (searchNeedle) {
        const hay = `${node.id} ${node.label} ${node.pole ?? ''} ${node.note ?? ''}`.toLowerCase();
        if (!hay.includes(searchNeedle)) return false;
      }
      if (filter === 'heads') return headSet.has(node.id);
      if (filter === 'tails') return tailSet.has(node.id);
      if (filter === 'hubs') return hubSet.has(node.id);
      if (filter === 'loops') return loopNodeSet.has(node.id);
      if (selectedEdge) return node.id === selectedEdge.from || node.id === selectedEdge.to;
      if (!activeSelectedId) return true;
      return (
        node.id === activeSelectedId
        || causalCone.upstreamNodes.has(node.id)
        || causalCone.downstreamNodes.has(node.id)
      );
    },
    [activeSelectedId, causalCone, filter, headSet, hubSet, loopNodeSet, searchNeedle, selectedEdge, tailSet],
  );

  const fitView = React.useCallback(() => {
    const el = viewportRef.current;
    if (!el || layout.nodes.length === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const vw = el.clientWidth || 640;
    const vh = el.clientHeight || height;
    const scaleX = (vw - 24) / Math.max(layout.width, 1);
    const scaleY = (vh - 24) / Math.max(layout.height, 1);
    const nextZoom = clampZoom(Math.min(1, scaleX, scaleY));
    const offsetX = Math.round((vw - layout.width * nextZoom) / 2);
    const offsetY = Math.round((vh - layout.height * nextZoom) / 2);
    setZoom(nextZoom);
    setPan({ x: offsetX, y: offsetY });
  }, [height, layout.height, layout.nodes.length, layout.width]);

  // Fit viewport cleanly on initial render or when map dimensions change substantially.
  const layoutSig = `${mapId}:${layout.nodes.length}:${layout.width}x${layout.height}:${direction}`;
  const fittedSigRef = React.useRef('');
  React.useLayoutEffect(() => {
    if (fittedSigRef.current === layoutSig) return;
    fittedSigRef.current = layoutSig;
    fitView();
  }, [fitView, layoutSig]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (compact) setWheelArmed(true);
    if (target?.closest('[data-cogmap-node], [data-cogmap-edge], button, input, textarea, select')) return;
    dragOriginRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y, moved: false };
    setDragging(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore synthetic events in tests.
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    if (!origin.moved && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 3) origin.moved = true;
    setPan({
      x: origin.panX + (event.clientX - origin.x),
      y: origin.panY + (event.clientY - origin.y),
    });
  };

  const handlePointerUp = () => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    setDragging(false);
    // A plain click on empty canvas clears any node/edge selection.
    if (origin && !origin.moved) {
      setSelectedIdState(null);
      setSelectedEdgeId(null);
    }
  };

  // Wheel zooms around the cursor while the pointer is over the canvas. Registered natively
  // because React's onWheel listener is passive and cannot stop the page from scrolling.
  React.useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!wheelArmedRef.current) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const prevZoom = zoomRef.current;
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const nextZoom = clampZoom(prevZoom * Math.exp(-delta * 0.0015));
      if (nextZoom === prevZoom) return;
      const prevPan = panRef.current;
      const worldX = (cx - prevPan.x) / prevZoom;
      const worldY = (cy - prevPan.y) / prevZoom;
      const nextPan = { x: cx - worldX * nextZoom, y: cy - worldY * nextZoom };
      zoomRef.current = nextZoom;
      panRef.current = nextPan;
      setZoom(nextZoom);
      setPan(nextPan);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleCopyDsl = async () => {
    const dsl = serializeCogMapDsl({
      id: mapId,
      rev,
      pacing,
      title,
      nodes: [...nodes],
      edges: [...edges],
    });
    try {
      await navigator.clipboard.writeText(dsl);
      setCopiedDsl(true);
      setTimeout(() => setCopiedDsl(false), 1600);
    } catch {
      // Clipboard unavailable in sandboxed or headless contexts.
    }
  };

  const triggerLadder = async (intent: CogMapLadderingIntent, node: CogMapNode) => {
    if (!onLadder || disabled || ladderingBusy) return;
    setLadderingBusy(intent);
    try {
      await onLadder(intent, node);
    } finally {
      setLadderingBusy(null);
    }
  };

  const beginEditNode = (node: CogMapNode) => {
    setEditingNodeId(node.id);
    setEditLabel(node.label);
    setEditPole(node.pole ?? '');
    setEditRole(node.role);
    setEditNote(node.note ?? '');
  };

  const handleSaveNodeEdit = async () => {
    if (!editingNodeId || !editLabel.trim() || !onMutate) return;
    await onMutate({
      mapId,
      updateNodes: [
        {
          id: editingNodeId,
          label: editLabel.trim(),
          pole: editPole.trim(),
          role: editRole,
          note: editNote.trim(),
          status: 'agreed',
        },
      ],
    });
    setEditingNodeId(null);
  };

  const handleCreateNode = async () => {
    if (!newLabel.trim() || !onMutate) return;
    const existingIds = new Set(nodes.map((node) => node.id));
    let seq = nodes.length + 1;
    while (existingIds.has(`n${seq}`)) seq += 1;
    const nextId = `n${seq}`;

    const addEdges: NonNullable<CogMapMutationPayload['addEdges']> = [];
    if (selectedNode && newLinkDir === 'from-selected') {
      addEdges.push({ from: selectedNode.id, to: nextId, sign: newLinkSign });
    } else if (selectedNode && newLinkDir === 'to-selected') {
      addEdges.push({ from: nextId, to: selectedNode.id, sign: newLinkSign });
    }

    await onMutate({
      mapId,
      addNodes: [
        {
          id: nextId,
          label: newLabel.trim(),
          ...(newPole.trim() ? { pole: newPole.trim() } : {}),
          role: newRole,
          ...(newNote.trim() ? { note: newNote.trim() } : {}),
          status: 'agreed',
        },
      ],
      ...(addEdges.length > 0 ? { addEdges } : {}),
      focusNodeId: nextId,
    });
    setNewLabel('');
    setNewPole('');
    setNewNote('');
    setAddFormOpen(false);
    setSelectedId(nextId);
  };

  const handleConnectEdge = async () => {
    if (!selectedNode || !connectTargetId || !onMutate || connectTargetId === selectedNode.id) return;
    await onMutate({
      mapId,
      addEdges: [{ from: selectedNode.id, to: connectTargetId, sign: connectSign }],
    });
    setConnectTargetId('');
  };

  const incidentIncoming = React.useMemo(
    () => (selectedNode ? edges.filter((edge) => edge.to === selectedNode.id) : []),
    [edges, selectedNode],
  );
  const incidentOutgoing = React.useMemo(
    () => (selectedNode ? edges.filter((edge) => edge.from === selectedNode.id) : []),
    [edges, selectedNode],
  );
  const nodeLookup = React.useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const isEdgeDimmed = (edge: CogMapEdge): boolean => {
    if (selectedEdgeId) return edge.id !== selectedEdgeId;
    if (filter === 'loops' && !loopEdgeSet.has(edge.id)) return true;
    if (!activeSelectedId) return false;
    return !causalCone.upstreamEdges.has(edge.id) && !causalCone.downstreamEdges.has(edge.id);
  };

  const edgeDetails = selectedEdge ? (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="oc-badge" style={{ color: edgeStrokeColor(selectedEdge.sign) }}>
          {signGlyph(selectedEdge.sign)} {SIGN_MEANING[selectedEdge.sign]}
        </span>
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => setSelectedEdgeId(null)}
          className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => setSelectedId(selectedEdge.from)}
        className="rounded-md bg-muted/30 px-2 py-1 text-start typography-micro hover:bg-muted/60"
      >
        <span className="font-mono text-[10px] text-muted-foreground">{selectedEdge.from}</span>{' '}
        {nodeLookup.get(selectedEdge.from)?.label ?? selectedEdge.from}
      </button>
      <div className="ps-2 typography-micro font-semibold" style={{ color: edgeStrokeColor(selectedEdge.sign) }}>
        {signGlyph(selectedEdge.sign)}{'→'} <span className="font-normal text-foreground">{selectedEdge.label ?? ''}</span>
      </div>
      <button
        type="button"
        onClick={() => setSelectedId(selectedEdge.to)}
        className="rounded-md bg-muted/30 px-2 py-1 text-start typography-micro hover:bg-muted/60"
      >
        <span className="font-mono text-[10px] text-muted-foreground">{selectedEdge.to}</span>{' '}
        {nodeLookup.get(selectedEdge.to)?.label ?? selectedEdge.to}
      </button>
      {editable && onMutate && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="self-start text-[var(--status-error)]"
          onClick={() => {
            const id = selectedEdge.id;
            setSelectedEdgeId(null);
            void onMutate({ mapId, removeEdgeIds: [id] });
          }}
        >
          <Icon name="delete-bin" className="size-3" />
          Delete link
        </Button>
      )}
    </div>
  ) : null;

  const filterButtons: readonly { id: StructuralFilter; label: string; count?: number }[] = [
    { id: 'all', label: 'All', count: analysis.stats.nodeCount },
    { id: 'heads', label: 'Heads', count: analysis.stats.headCount },
    { id: 'tails', label: 'Tails', count: analysis.stats.tailCount },
    { id: 'hubs', label: 'Hubs', count: Math.min(3, analysis.hubs.length) },
    { id: 'loops', label: 'Loops', count: analysis.stats.loopCount },
  ];

  return (
    <div
      data-cogmap-canvas={mapId}
      className={cn(
        'flex flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground',
        compact ? 'w-full' : 'h-full min-h-0 flex-1',
      )}
    >
      {/* Header & Controls Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="brain" className="size-4 shrink-0 text-[var(--primary-base)]" />
          <span className="truncate typography-meta font-semibold text-foreground">{title}</span>
          <span className="oc-badge shrink-0 tabular-nums">
            {analysis.stats.nodeCount}n · {analysis.stats.edgeCount}e
            {analysis.stats.loopCount > 0 ? ` · ${analysis.stats.loopCount}↺` : ''}
          </span>
          {analysis.stats.proposedCount > 0 && (
            <span className="oc-badge shrink-0" data-tone="info">
              {analysis.stats.proposedCount} proposed
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {onPacingChange && (
            <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5 typography-micro">
              <button
                type="button"
                aria-pressed={pacing === 'auto'}
                onClick={() => onPacingChange('auto')}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  pacing === 'auto' ? 'bg-[var(--primary)]/15 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Auto
              </button>
              <button
                type="button"
                aria-pressed={pacing === 'collab'}
                onClick={() => onPacingChange('collab')}
                className={cn(
                  'rounded px-1.5 py-0.5 transition-colors',
                  pacing === 'collab' ? 'bg-[var(--primary)]/15 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                Co-create
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setDirection((prev) => (prev === 'up' ? 'down' : 'up'))}
            title={direction === 'up' ? 'Goals at top (Eden convention) — click to invert' : 'Causes at top — click for Goals at top'}
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 typography-micro text-muted-foreground hover:text-foreground"
          >
            <Icon name={direction === 'up' ? 'arrow-up' : 'arrow-down'} className="size-3" />
            <span>{direction === 'up' ? 'Ends ↑' : 'Ends ↓'}</span>
          </button>

          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z * 0.85))}
            aria-label="Zoom out"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background typography-micro text-muted-foreground hover:text-foreground"
          >
            −
          </button>
          <button
            type="button"
            onClick={fitView}
            title="Fit map to view"
            className="inline-flex h-6 items-center justify-center rounded-md border border-border bg-background px-1.5 typography-micro tabular-nums text-muted-foreground hover:text-foreground"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => clampZoom(z * 1.15))}
            aria-label="Zoom in"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background typography-micro text-muted-foreground hover:text-foreground"
          >
            +
          </button>

          {editable && onMutate && (
            <Button
              type="button"
              size="xs"
              variant={addFormOpen ? 'default' : 'outline'}
              disabled={disabled}
              onClick={() => setAddFormOpen((prev) => !prev)}
            >
              <Icon name="add" className="size-3.5" />
              Node
            </Button>
          )}

          <button
            type="button"
            onClick={() => void handleCopyDsl()}
            title="Copy compact Mini-DSL"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 typography-micro text-muted-foreground hover:text-foreground"
          >
            <Icon name={copiedDsl ? 'check' : 'file-copy'} className="size-3" />
            <span>{copiedDsl ? 'Copied' : 'DSL'}</span>
          </button>

          {!compact && (
            <button
              type="button"
              onClick={() => setSidebarOpen((prev) => !prev)}
              aria-pressed={sidebarOpen}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 typography-micro text-muted-foreground hover:text-foreground"
            >
              <Icon name="filter-3" className="size-3" />
              <span>Inspect</span>
            </button>
          )}

          {onExpandToPanel && (
            <Button type="button" size="xs" variant="outline" onClick={onExpandToPanel}>
              <Icon name="fullscreen" className="size-3.5" />
              Panel
            </Button>
          )}
        </div>
      </div>

      {/* Structural Filter Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {filterButtons.map((btn) => (
            <button
              key={btn.id}
              type="button"
              aria-pressed={filter === btn.id}
              onClick={() => setFilter(btn.id)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 typography-micro transition-colors',
                filter === btn.id
                  ? 'bg-[var(--primary)]/15 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
              )}
            >
              <span>{btn.label}</span>
              {btn.count !== undefined && <span className="tabular-nums opacity-75">{btn.count}</span>}
            </button>
          ))}
        </div>

        {!compact && (
          <div className="flex items-center gap-1.5">
            <Icon name="search" className="size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter concepts…"
              className="h-6 w-36 rounded-md border border-border bg-background px-2 typography-micro text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        )}
      </div>

      {/* Zero-token Co-creation Add Node Form */}
      {editable && addFormOpen && (
        <div className="flex flex-col gap-2 border-b border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              placeholder="Concept phrase (e.g. Share live POS demand data)"
              className="h-8 min-w-[14rem] flex-1"
            />
            <Input
              value={newPole}
              onChange={(event) => setNewPole(event.target.value)}
              placeholder="Contrast pole (optional, e.g. delayed monthly reports)"
              className="h-8 min-w-[12rem] flex-1"
            />
            <select
              value={newRole}
              onChange={(event) => setNewRole(event.target.value as CogMapNodeRole)}
              className="h-8 rounded-md border border-border bg-background px-2 typography-micro text-foreground"
            >
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>{ROLE_META[role].label}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newNote}
              onChange={(event) => setNewNote(event.target.value)}
              placeholder="Optional rationale / evidence note (shown locally, 0 tokens)"
              className="h-7 min-w-[14rem] flex-1 typography-micro"
            />
            {selectedNode && (
              <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                <select
                  value={newLinkDir}
                  onChange={(event) => setNewLinkDir(event.target.value as 'none' | 'from-selected' | 'to-selected')}
                  className="h-7 rounded-md border border-border bg-background px-1.5 text-foreground"
                >
                  <option value="from-selected">From {selectedNode.id} → new</option>
                  <option value="to-selected">New → {selectedNode.id}</option>
                  <option value="none">Unlinked</option>
                </select>
                {newLinkDir !== 'none' && (
                  <select
                    value={newLinkSign}
                    onChange={(event) => setNewLinkSign(event.target.value as CogMapEdgeSign)}
                    className="h-7 rounded-md border border-border bg-background px-1.5 text-foreground"
                  >
                    {SIGN_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <Button type="button" size="xs" disabled={!newLabel.trim()} onClick={() => void handleCreateNode()}>
              Add to map
            </Button>
          </div>
        </div>
      )}

      {/* Main Split: Interactive Canvas + Optional Inspector Sidebar */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={viewportRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => {
            if (compact) setWheelArmed(false);
          }}
          style={compact ? { height } : undefined}
          className={cn(
            'relative min-h-[240px] flex-1 overflow-hidden select-none bg-[radial-gradient(color-mix(in_srgb,var(--border)_65%,transparent)_1px,transparent_1px)] [background-size:18px_18px]',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
        >
          {nodes.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Icon name="brain" className="size-8 text-muted-foreground/50" />
              <div className="typography-meta font-medium text-foreground">No cognitive map concepts yet</div>
              <div className="max-w-xs typography-micro text-muted-foreground">
                Describe a complex scenario in chat or add your first goal/option node directly to start mapping means-ends causality.
              </div>
            </div>
          ) : (
            <div
              className="origin-top-left"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
              }}
            >
              {/* Causal Edges Layer (SVG) */}
              <svg
                width={layout.width}
                height={layout.height}
                className="pointer-events-none absolute inset-0 overflow-visible"
              >
                <defs>
                  {(['+', '-', '?'] as const).map((sign) => (
                    <marker
                      key={sign}
                      id={`${markerPrefix}-arrow-${sign === '+' ? 'pos' : sign === '-' ? 'neg' : 'unc'}`}
                      viewBox="0 0 10 10"
                      refX="8.5"
                      refY="5"
                      markerWidth="6.5"
                      markerHeight="6.5"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill={edgeStrokeColor(sign)} />
                    </marker>
                  ))}
                </defs>

                {layout.edges.map(({ edge, path, isFeedback }) => {
                  const isActive = edge.id === selectedEdgeId || edge.id === hoveredEdgeId;
                  const dimmed = !isActive && isEdgeDimmed(edge);
                  const stroke = edgeStrokeColor(edge.sign);
                  const markerKey = edge.sign === '+' ? 'pos' : edge.sign === '-' ? 'neg' : 'unc';
                  return (
                    <g key={edge.id} opacity={dimmed ? 0.16 : isActive ? 1 : 0.85}>
                      <path
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth={isActive ? 3 : isFeedback ? 2.1 : 1.75}
                        strokeDasharray={edge.sign === '?' ? '5 4' : isFeedback ? '6 3' : undefined}
                        markerEnd={`url(#${markerPrefix}-arrow-${markerKey})`}
                      />
                      {/* Wide invisible hit area so thin causal links are easy to click. */}
                      <path
                        d={path}
                        data-cogmap-edge={edge.id}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={14}
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        onClick={() => selectEdge(edge.id)}
                        onPointerEnter={() => setHoveredEdgeId(edge.id)}
                        onPointerLeave={() => setHoveredEdgeId((prev) => (prev === edge.id ? null : prev))}
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Concept Nodes Layer (HTML cards for crisp theme typography) */}
              {layout.nodes.map(({ node, x, y, width, height: nodeHeight }) => {
                const roleMeta = ROLE_META[node.role];
                const isSelected = node.id === activeSelectedId;
                const isUpstream = causalCone.upstreamNodes.has(node.id);
                const isDownstream = causalCone.downstreamNodes.has(node.id);
                const highlighted = isNodeHighlighted(node);
                const isProposed = node.status === 'proposed';

                return (
                  <div
                    key={node.id}
                    data-cogmap-node={node.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId((prev) => (prev === node.id ? null : node.id))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId((prev) => (prev === node.id ? null : node.id));
                      }
                    }}
                    style={{
                      width,
                      minHeight: nodeHeight,
                      transform: `translate(${x}px, ${y}px)`,
                      borderColor: isSelected
                        ? 'var(--primary-base)'
                        : isUpstream
                          ? 'var(--status-info)'
                          : isDownstream
                            ? 'var(--status-success)'
                            : undefined,
                    }}
                    className={cn(
                      'absolute inset-s-0 top-0 flex cursor-pointer flex-col gap-1 rounded-lg border bg-background px-2.5 py-2 text-start shadow-xs transition-opacity',
                      isProposed || node.role === 'assumption' ? 'border-dashed' : 'border-solid',
                      isSelected ? 'ring-2 ring-[var(--primary)]/35' : 'border-border hover:border-foreground/30',
                      !highlighted && 'opacity-25',
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="inline-flex items-center gap-1.5 typography-micro font-medium text-muted-foreground">
                        <span
                          aria-hidden="true"
                          className="inline-block size-2 rounded-full"
                          style={{ backgroundColor: roleMeta.accent }}
                        />
                        <span className="font-mono text-[10px] opacity-80">{node.id}</span>
                        <span>{roleMeta.label}</span>
                      </span>
                      <span className="flex items-center gap-1">
                        {isProposed && (
                          <span className="rounded bg-[var(--status-info-background)] px-1 py-0.2 typography-micro text-[10px] text-[var(--status-info)]">
                            proposed
                          </span>
                        )}
                        {node.author === 'user' && (
                          <span className="rounded bg-muted px-1 py-0.2 typography-micro text-[10px] text-muted-foreground">
                            you
                          </span>
                        )}
                        {node.note && <Icon name="eye" className="size-3 text-muted-foreground/80" />}
                      </span>
                    </div>

                    <div className="typography-micro font-medium leading-snug text-foreground">
                      {node.label}
                    </div>

                    {node.pole && (
                      <div className="typography-micro italic leading-tight text-muted-foreground">
                        … {node.pole}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Edge badges & labels render ABOVE the cards so link text is never hidden. */}
              {layout.edges.map(({ edge, midX, midY }) => {
                const isActive = edge.id === selectedEdgeId || edge.id === hoveredEdgeId;
                const dimmed = !isActive && isEdgeDimmed(edge);
                const stroke = edgeStrokeColor(edge.sign);
                return (
                  <button
                    key={`label-${edge.id}`}
                    type="button"
                    data-cogmap-edge={edge.id}
                    onClick={() => selectEdge(edge.id)}
                    onPointerEnter={() => setHoveredEdgeId(edge.id)}
                    onPointerLeave={() => setHoveredEdgeId((prev) => (prev === edge.id ? null : prev))}
                    title={edge.label ?? SIGN_MEANING[edge.sign]}
                    style={{
                      left: midX,
                      top: midY,
                      borderColor: stroke,
                      zIndex: isActive ? 30 : 20,
                      opacity: dimmed ? 0.22 : 1,
                    }}
                    className={cn(
                      'absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-start shadow-xs transition-[opacity,box-shadow]',
                      isActive && 'shadow-md ring-2 ring-[var(--primary)]/35',
                    )}
                  >
                    <span className="text-[11px] font-bold leading-none" style={{ color: stroke }}>
                      {signGlyph(edge.sign)}
                    </span>
                    {edge.label && (
                      <span
                        className={cn(
                          'typography-micro leading-tight text-foreground/85',
                          isActive ? 'w-max max-w-[260px] whitespace-normal' : 'max-w-[150px] truncate',
                        )}
                      >
                        {edge.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {compact && edgeDetails && (
            <div className="absolute inset-x-2 bottom-2 z-40 rounded-lg border border-border bg-background/95 p-2.5 shadow-md backdrop-blur-xs">
              {edgeDetails}
            </div>
          )}

          {/* Compact Inline Quick Inspector Bar (when a node is clicked inside inline A2UI) */}
          {compact && selectedNode && (
            <div className="absolute inset-x-2 bottom-2 z-40 flex flex-col gap-2 rounded-lg border border-border bg-background/95 p-2.5 shadow-md backdrop-blur-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono typography-micro text-muted-foreground">{selectedNode.id}</span>
                    <span className="oc-badge" data-tone={ROLE_META[selectedNode.role].badgeTone}>
                      {ROLE_META[selectedNode.role].label}
                    </span>
                    <span className="typography-micro font-semibold text-foreground">{selectedNode.label}</span>
                    {selectedNode.pole && (
                      <span className="typography-micro italic text-muted-foreground">… {selectedNode.pole}</span>
                    )}
                  </div>
                  {selectedNode.note && (
                    <div className="mt-1 typography-micro text-muted-foreground">{selectedNode.note}</div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Close inspector"
                  onClick={() => setSelectedId(null)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <Icon name="close" className="size-3.5" />
                </button>
              </div>

              {onLadder && (
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={disabled || ladderingBusy !== null}
                    onClick={() => void triggerLadder('ladder_up', selectedNode)}
                  >
                    <Icon name="arrow-up" className="size-3" />
                    Why?
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={disabled || ladderingBusy !== null}
                    onClick={() => void triggerLadder('ladder_down', selectedNode)}
                  >
                    <Icon name="arrow-down" className="size-3" />
                    How?
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={disabled || ladderingBusy !== null}
                    onClick={() => void triggerLadder('challenge', selectedNode)}
                  >
                    <Icon name="arrow-left-right" className="size-3" />
                    Challenge
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={disabled || ladderingBusy !== null}
                    onClick={() => void triggerLadder('explain', selectedNode)}
                  >
                    Explain
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Full-Mode Right Inspector & Structural Analysis Sidebar */}
        {!compact && sidebarOpen && (
          <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-s border-border bg-background p-3">
            {edgeDetails ?? (selectedNode ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono typography-micro text-muted-foreground">{selectedNode.id}</span>
                    <span className="oc-badge" data-tone={ROLE_META[selectedNode.role].badgeTone}>
                      {ROLE_META[selectedNode.role].label}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label="Clear selection"
                    onClick={() => {
                      setSelectedId(null);
                      setEditingNodeId(null);
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-3.5" />
                  </button>
                </div>

                {editingNodeId === selectedNode.id ? (
                  <div className="flex flex-col gap-2">
                    <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="Concept phrase" className="h-8" />
                    <Input value={editPole} onChange={(e) => setEditPole(e.target.value)} placeholder="Contrast pole (optional)" className="h-8" />
                    <select
                      value={editRole}
                      onChange={(e) => setEditRole(e.target.value as CogMapNodeRole)}
                      className="h-8 rounded-md border border-border bg-background px-2 typography-micro text-foreground"
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>{ROLE_META[role].label}</option>
                      ))}
                    </select>
                    <Textarea rows={3} value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Rationale / evidence note" />
                    <div className="flex items-center gap-1.5">
                      <Button type="button" size="xs" onClick={() => void handleSaveNodeEdit()}>Save</Button>
                      <Button type="button" size="xs" variant="ghost" onClick={() => setEditingNodeId(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="typography-meta font-semibold text-foreground">{selectedNode.label}</div>
                    {selectedNode.pole && (
                      <div className="typography-micro italic text-muted-foreground">Contrast pole: … {selectedNode.pole}</div>
                    )}
                    {selectedNode.note && (
                      <div className="rounded-lg bg-muted/40 p-2 typography-micro leading-relaxed text-foreground/90">
                        {selectedNode.note}
                      </div>
                    )}

                    {/* Accept / Edit / Delete controls (0 LLM tokens) */}
                    {editable && onMutate && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {selectedNode.status === 'proposed' && (
                          <Button
                            type="button"
                            size="xs"
                            variant="default"
                            onClick={() => void onMutate({ mapId, updateNodes: [{ id: selectedNode.id, status: 'agreed' }] })}
                          >
                            <Icon name="check" className="size-3" />
                            Accept
                          </Button>
                        )}
                        <Button type="button" size="xs" variant="outline" onClick={() => beginEditNode(selectedNode)}>
                          <Icon name="edit-2" className="size-3" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="text-[var(--status-error)]"
                          onClick={() => {
                            const id = selectedNode.id;
                            setSelectedId(null);
                            void onMutate({ mapId, removeNodeIds: [id] });
                          }}
                        >
                          <Icon name="delete-bin" className="size-3" />
                          Delete
                        </Button>
                      </div>
                    )}

                    {/* Bidirectional AI Laddering Actions */}
                    {onLadder && (
                      <div className="flex flex-col gap-1.5 border-t border-border pt-2">
                        <div className="typography-micro font-medium text-muted-foreground">Ask Agent (Laddering)</div>
                        <div className="grid grid-cols-2 gap-1.5">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={disabled || ladderingBusy !== null}
                            onClick={() => void triggerLadder('ladder_up', selectedNode)}
                          >
                            <Icon name="arrow-up" className="size-3" />
                            Why? (Ends)
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={disabled || ladderingBusy !== null}
                            onClick={() => void triggerLadder('ladder_down', selectedNode)}
                          >
                            <Icon name="arrow-down" className="size-3" />
                            How? (Causes)
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={disabled || ladderingBusy !== null}
                            onClick={() => void triggerLadder('challenge', selectedNode)}
                          >
                            <Icon name="arrow-left-right" className="size-3" />
                            Challenge
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={disabled || ladderingBusy !== null}
                            onClick={() => void triggerLadder('loops', selectedNode)}
                          >
                            <Icon name="flow-chart" className="size-3" />
                            Find Loops
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Causal Connections + Add Link */}
                    <div className="flex flex-col gap-1.5 border-t border-border pt-2">
                      <div className="typography-micro font-medium text-muted-foreground">
                        Causal Links ({incidentIncoming.length} in · {incidentOutgoing.length} out)
                      </div>
                      {incidentIncoming.map((edge) => (
                        <div key={edge.id} className="flex items-center justify-between gap-1 rounded bg-muted/30 px-2 py-1 typography-micro">
                          <button
                            type="button"
                            onClick={() => setSelectedId(edge.from)}
                            className="min-w-0 flex-1 truncate text-start hover:underline"
                          >
                            <span className="font-mono opacity-70">{edge.from}</span> {edge.sign}→ {nodeLookup.get(edge.from)?.label}
                          </button>
                          {editable && onMutate && (
                            <button
                              type="button"
                              aria-label="Remove edge"
                              onClick={() => void onMutate({ mapId, removeEdgeIds: [edge.id] })}
                              className="text-muted-foreground hover:text-[var(--status-error)]"
                            >
                              <Icon name="close" className="size-3" />
                            </button>
                          )}
                        </div>
                      ))}
                      {incidentOutgoing.map((edge) => (
                        <div key={edge.id} className="flex items-center justify-between gap-1 rounded bg-muted/30 px-2 py-1 typography-micro">
                          <button
                            type="button"
                            onClick={() => setSelectedId(edge.to)}
                            className="min-w-0 flex-1 truncate text-start hover:underline"
                          >
                            {edge.sign}→ <span className="font-mono opacity-70">{edge.to}</span> {nodeLookup.get(edge.to)?.label}
                          </button>
                          {editable && onMutate && (
                            <button
                              type="button"
                              aria-label="Remove edge"
                              onClick={() => void onMutate({ mapId, removeEdgeIds: [edge.id] })}
                              className="text-muted-foreground hover:text-[var(--status-error)]"
                            >
                              <Icon name="close" className="size-3" />
                            </button>
                          )}
                        </div>
                      ))}

                      {editable && onMutate && nodes.length > 1 && (
                        <div className="mt-1 flex items-center gap-1">
                          <select
                            value={connectSign}
                            onChange={(e) => setConnectSign(e.target.value as CogMapEdgeSign)}
                            className="h-7 rounded border border-border bg-background px-1 typography-micro"
                          >
                            <option value="+">+</option>
                            <option value="-">−</option>
                            <option value="?">?</option>
                          </select>
                          <select
                            value={connectTargetId}
                            onChange={(e) => setConnectTargetId(e.target.value)}
                            className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 typography-micro"
                          >
                            <option value="">Link to node…</option>
                            {nodes
                              .filter((candidate) => candidate.id !== selectedNode.id)
                              .map((candidate) => (
                                <option key={candidate.id} value={candidate.id}>
                                  {candidate.id}: {candidate.label}
                                </option>
                              ))}
                          </select>
                          <Button type="button" size="xs" variant="outline" disabled={!connectTargetId} onClick={() => void handleConnectEdge()}>
                            Link
                          </Button>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              /* Structural Overview (0 LLM tokens) */
              <div className="flex flex-col gap-3">
                <div className="typography-micro text-muted-foreground">
                  Click a node to trace its causes & consequences, or click a link to read why it holds. Scroll to zoom, drag to pan.
                </div>

                <div>
                  <div className="mb-1 typography-micro font-semibold text-foreground">
                    Heads / Goals ({analysis.heads.length})
                  </div>
                  {analysis.heads.length === 0 ? (
                    <div className="typography-micro text-muted-foreground">None yet</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {analysis.heads.map((head) => (
                        <button
                          key={head.id}
                          type="button"
                          onClick={() => setSelectedId(head.id)}
                          className="rounded-md bg-muted/30 px-2 py-1 text-start typography-micro hover:bg-muted/60"
                        >
                          <span className="font-mono text-[10px] text-muted-foreground">{head.id}</span> {head.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-1 typography-micro font-semibold text-foreground">
                    Tails / Levers ({analysis.tails.length})
                  </div>
                  {analysis.tails.length === 0 ? (
                    <div className="typography-micro text-muted-foreground">None yet</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {analysis.tails.map((tail) => (
                        <button
                          key={tail.id}
                          type="button"
                          onClick={() => setSelectedId(tail.id)}
                          className="rounded-md bg-muted/30 px-2 py-1 text-start typography-micro hover:bg-muted/60"
                        >
                          <span className="font-mono text-[10px] text-muted-foreground">{tail.id}</span> {tail.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {analysis.hubs.length > 0 && (
                  <div>
                    <div className="mb-1 typography-micro font-semibold text-foreground">Central Hubs</div>
                    <div className="flex flex-col gap-1">
                      {analysis.hubs.slice(0, 4).map((hub) => (
                        <button
                          key={hub.id}
                          type="button"
                          onClick={() => setSelectedId(hub.id)}
                          className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1 text-start typography-micro hover:bg-muted/60"
                        >
                          <span className="truncate">{hub.label}</span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{hub.totalDegree} deg</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.loops.length > 0 && (
                  <div>
                    <div className="mb-1 typography-micro font-semibold text-foreground">
                      Feedback Loops ({analysis.loops.length})
                    </div>
                    <div className="flex flex-col gap-1">
                      {analysis.loops.map((loop, idx) => (
                        <button
                          key={`${loop.nodes.join('-')}-${idx}`}
                          type="button"
                          onClick={() => {
                            setFilter('loops');
                            setSelectedId(loop.nodes[0] ?? null);
                          }}
                          className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-start typography-micro hover:bg-muted/50"
                        >
                          <span className="font-medium">
                            {loop.polarity === 'reinforcing' ? 'R · Reinforcing' : loop.polarity === 'balancing' ? 'B · Balancing' : '? · Uncertain'}
                          </span>
                          <span className="truncate text-muted-foreground">{loop.nodes.join(' → ')} → {loop.nodes[0]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

export type { CognitiveMap };
