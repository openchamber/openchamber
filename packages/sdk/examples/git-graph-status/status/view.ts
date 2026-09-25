import { lanesBelow, type GraphRow } from './graph.ts';

/** Row height of a collapsed commit, in CSS px. The dot sits in its middle. */
export const ROW = 36;
const LANE = 10;
const MAX_LANES = 8;
const SVG = 'http://www.w3.org/2000/svg';
// Lanes cycle through host colour tokens; no literal colours anywhere.
const LANE_COLORS = ['var(--oc-primary)', 'var(--oc-info)', 'var(--oc-success)', 'var(--oc-warning)', 'var(--oc-error)'];

export type RefKind = 'local' | 'remote' | 'tag';

export const STYLE = `
  html, body { margin: 0; background: transparent; color: var(--oc-fg); font: 12px/1.35 var(--oc-font); }
  /* The host stops growing the frame at its maximum; past that the page scrolls. */
  html, body { height: 100%; overflow-y: auto; overflow-x: hidden; }
  button { font: inherit; color: inherit; }
  .bar { display: flex; align-items: center; gap: 6px; padding: 2px 0 6px; }
  .bar .grow { flex: 1; }
  .picker { display: flex; flex-direction: column; gap: 2px; max-height: 104px; overflow-y: auto; padding: 0 2px 6px; }
  .picker-group { color: var(--oc-muted); font-size: 11px; padding-top: 2px; }
  .note { color: var(--oc-muted); padding: 6px 2px; }
  .commit { display: flex; flex-direction: column; }
  .head { all: unset; box-sizing: border-box; display: flex; align-items: stretch; gap: 6px; width: 100%; height: ${ROW}px;
    cursor: pointer; border-radius: 6px; }
  .head:hover { background: var(--oc-hover); }
  .head:focus-visible { box-shadow: 0 0 0 2px var(--oc-focus); }
  .commit.open > .head { background: var(--oc-selection); color: var(--oc-selection-fg); }
  .graph { flex: none; display: block; }
  .text { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .line { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .subject { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--oc-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit.open .meta { color: inherit; opacity: .8; }
  .ref { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    border-radius: 4px; padding: 0 4px; font-size: 10px; line-height: 15px; font-weight: 600; }
  .ref.head-ref { background: var(--oc-primary); color: var(--oc-primary-fg); }
  .ref.local { background: var(--oc-hover); color: var(--oc-fg); }
  .ref.remote { background: color-mix(in srgb, var(--oc-info) 18%, transparent); color: var(--oc-info-text); }
  .ref.tag { background: color-mix(in srgb, var(--oc-warning) 18%, transparent); color: var(--oc-warning-text); }
  .dirty .subject { font-style: italic; color: var(--oc-muted); }
  .dirty > .head { cursor: default; }
  .dirty > .head:hover { background: transparent; }
  .details { display: flex; gap: 6px; }
  .rail { flex: none; position: relative; }
  .rail svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .card { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; padding: 8px;
    border: 1px solid var(--oc-border); border-radius: var(--oc-radius); background: var(--oc-elevated); color: var(--oc-elevated-fg); }
  .card .full { font-weight: 600; white-space: pre-wrap; overflow-wrap: anywhere; }
  .card .body { color: var(--oc-muted); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 72px; overflow-y: auto; }
  .card .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--oc-muted); }
  .card .add { color: var(--oc-success-text); }
  .card .del { color: var(--oc-error-text); }
  .card code { font-family: var(--oc-mono); color: var(--oc-elevated-fg); }
  .card .actions { display: flex; gap: 6px; flex-wrap: wrap; padding-top: 2px; }
  .card .error { color: var(--oc-error-text); }
`;

const laneX = (lane: number): number => LANE / 2 + lane * LANE;
const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length] ?? 'var(--oc-muted)';

const svgNode = <K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

export const graphWidth = (lanes: number): number => Math.min(Math.max(lanes, 1), MAX_LANES) * LANE;

/** One collapsed row of the graph: straight lanes first, curves over them, the dot on top. */
export const drawRowGraph = (row: GraphRow, width: number, dot: 'commit' | 'head' | 'dirty'): SVGSVGElement => {
  const svg = svgNode('svg', { width, height: ROW, class: 'graph', 'aria-hidden': 'true' });
  const visible = (lane: number) => laneX(lane) < width;
  const mid = ROW / 2;
  const x = laneX(row.lane);
  const curves = row.connectors.filter((connector) => connector.type === 'branch-out' || connector.type === 'merge-in');
  const straight = row.connectors.filter((connector) => !curves.includes(connector));
  for (const connector of [...straight, ...curves]) {
    if (!visible(connector.fromLane) || !visible(connector.toLane)) continue;
    const from = laneX(connector.fromLane);
    const to = laneX(connector.toLane);
    const d = connector.type === 'passing' || connector.type === 'commit-lane' ? `M${from} 0 L${from} ${ROW}`
      : connector.type === 'top-stub' ? `M${from} 0 L${from} ${mid}`
        : connector.type === 'bottom-stub' ? `M${from} ${mid} L${from} ${ROW}`
          : connector.type === 'branch-out' ? `M${x} ${mid} C${x} ${(mid + ROW) / 2} ${to} ${(mid + ROW) / 2} ${to} ${ROW}`
            : `M${from} 0 C${from} ${mid / 2} ${x} ${mid / 2} ${x} ${mid}`;
    const lane = connector.type === 'branch-out' ? connector.toLane : connector.fromLane;
    const path = svgNode('path', {
      d, fill: 'none', stroke: laneColor(lane), 'stroke-width': 1.5, 'stroke-linecap': 'round',
      'stroke-opacity': connector.type === 'passing' ? 0.72 : 1,
    });
    // The working tree is not a commit yet: its lane is dashed.
    if (dot === 'dirty' && connector.fromLane === row.lane) path.setAttribute('stroke-dasharray', '2 3');
    svg.append(path);
  }
  if (visible(row.lane)) {
    const color = laneColor(row.lane);
    const circle = svgNode('circle', {
      cx: x, cy: mid, r: dot === 'head' ? 4.5 : 3.5,
      fill: dot === 'dirty' ? 'var(--oc-bg)' : color, stroke: dot === 'dirty' ? color : 'var(--oc-bg)', 'stroke-width': dot === 'dirty' ? 1.5 : 2,
    });
    if (dot === 'dirty') circle.setAttribute('stroke-dasharray', '2 2');
    svg.append(circle);
  }
  return svg;
};

/** Lanes continuing past an expanded row, drawn beside its details at any height. */
export const drawRail = (row: GraphRow, width: number): HTMLElement => {
  const rail = document.createElement('div');
  rail.className = 'rail';
  rail.style.width = `${width}px`;
  const svg = svgNode('svg', { 'aria-hidden': 'true', preserveAspectRatio: 'none' });
  for (const lane of lanesBelow(row)) {
    if (laneX(lane) >= width) continue;
    svg.append(svgNode('line', { x1: laneX(lane), x2: laneX(lane), y1: 0, y2: '100%', stroke: laneColor(lane), 'stroke-width': 1.5 }));
  }
  rail.append(svg);
  return rail;
};

export const refBadge = (name: string, kind: RefKind, head: boolean): HTMLElement => {
  const badge = document.createElement('span');
  badge.className = `ref ${head ? 'head-ref' : kind}`;
  badge.textContent = name;
  badge.title = kind === 'remote' ? `Remote branch ${name}` : kind === 'tag' ? `Tag ${name}` : head ? `Checked out: ${name}` : `Branch ${name}`;
  return badge;
};

export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
